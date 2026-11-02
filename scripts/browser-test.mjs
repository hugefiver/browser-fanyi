import { chromium } from 'playwright-core';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startMock } from './mock-service.mjs';

const root = resolve(import.meta.dirname, '..');
const profiles = resolve(root, '.test-profiles');
await mkdir(profiles, { recursive: true });
const profile = await mkdtemp(resolve(profiles, 'chromium-'));
const service = await startMock();
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    headless: false, viewport: { width: 1100, height: 850 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--disable-component-update'],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  console.log('Browser:', (await cdp.send('Browser.getVersion')).product);
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: resolve(root, 'dist/chromium') });
  const base = `chrome-extension://${id}`;
  console.log('Loaded extension:', id);
  const options = await context.newPage();
  await options.goto(`${base}/options.html`);
  await options.locator('input').first().waitFor();
  assert.equal(service.requests.length, 0);
  console.log('PASS: extension loaded; options rendered; no automatic request');
  await runChecks({ context, cdp, id, base, options, service });
} finally {
  await context?.close();
  await service.close();
  if (profile.startsWith(`${profiles}\\chromium-`) || profile.startsWith(`${profiles}/chromium-`)) await rm(profile, { recursive: true, force: true });
}

function nativeButton(name) {
  return new Promise((done, reject) => {
    const helper = spawn('pwsh', ['-NoProfile', '-File', resolve(root, 'scripts/edge-permission.ps1'), '-ProfilePath', profile, '-ButtonName', name], { stdio: 'inherit' });
    helper.once('error', reject);
    helper.once('exit', code => code === 0 ? done() : reject(new Error(`Native button helper exited ${code}`)));
  });
}

async function runChecks({ context, cdp, id, base, options, service }) {
  await options.getByLabel('API 前缀地址', { exact: false }).fill(`${service.url}/v1`);
  await options.getByLabel('模型名称', { exact: false }).fill('controlled-test-model');
  await options.getByLabel('API 密钥', { exact: false }).fill('fictional-test-key');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await options.getByText('设置已成功保存', { exact: false }).waitFor();
  assert.equal(service.requests.length, 0);
  await options.getByRole('button', { name: '授权主机权限', exact: true }).click();
  await nativeButton('允许');
  await options.getByText('已授权', { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(service.requests.length, 0);
  await options.getByRole('button', { name: '测试服务连接', exact: true }).click();
  await options.waitForFunction(() => !document.body.textContent.includes('正在测试...'));
  assert.equal(service.requests.length, 1);
  assert.equal(service.requests[0].text, 'Hello.');
  console.log('PASS: local save, host authorization, controlled connection test');
  const page = await context.newPage();
  await context.addCookies([{ name: 'CONTROLLED_COOKIE', value: 'must-not-send', url: service.url }]);
  await page.goto(`${service.url.replace('127.0.0.1', 'localhost')}/fixture`);
  const pageCdp = await context.newCDPSession(page);
  const { targetInfo } = await pageCdp.send('Target.getTargetInfo');
  const targets = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const tabTarget = targets.targetInfos.find(target => target.url === page.url());
  console.log('Action target:', tabTarget ?? targetInfo);
  await cdp.send('Extensions.triggerAction', { id, targetId: tabTarget?.targetId ?? targetInfo.targetId });
  const panel = await context.newPage();
  await panel.goto(`${base}/popup.html`);
  await page.bringToFront();
  const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const send = message => panel.evaluate(message => chrome.runtime.sendMessage(message), message);
  const command = async (action, mode) => {
    const result = await send({ type: 'page.command', tabId, action, mode });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const status = () => send({ type: 'page.status', tabId });
  await command('start');
  await until(async () => (await status()).value?.phase === 'complete');
  console.log('PASS: browser action grants activeTab; extension message starts page translation');
  const count = service.requests.length;
  assert(service.requests.every(item => !/PRIVATE_|<script|fixture/.test(item.text)));
  assert(service.requests.every(item => item.cookie === undefined && item.referer === undefined));
  await command('mode', 'translation');
  assert.equal(await page.locator('#first').textContent(), '译文：Hello test world.');
  assert(await page.evaluate(() => firstNode === document.querySelector('#first').firstChild));
  await command('mode', 'bilingual');
  assert.equal(service.requests.length, count);
  await page.locator('#counter').click();
  assert.equal(await page.evaluate(() => clicks), 1);
  await page.locator('#draft').fill('NEW_PRIVATE_DRAFT');
  await page.evaluate(() => addText('Dynamic arrival.'));
  await until(async () => (await status()).value?.phase === 'complete' && service.requests.some(item => item.text === 'Dynamic arrival.'));
  await page.evaluate(() => { firstNode.data = 'Website latest text.'; });
  await until(async () => (await page.locator('#first [data-browser-fanyi]').textContent()) === '译文：Website latest text.');
  console.log('PASS: privacy exclusions, modes without new requests, events/input, dynamic additions/updates');

  service.control.delay = 700;
  await page.evaluate(() => addText('Delayed sentence.'));
  await until(() => service.requests.some(item => item.text === 'Delayed sentence.'));
  await command('pause');
  const pausedCount = service.requests.length;
  await page.evaluate(() => addText('Added while paused.'));
  await new Promise(done => setTimeout(done, 900));
  assert.equal(service.requests.length, pausedCount);
  assert.equal(await page.locator('#dynamic [data-browser-fanyi]').filter({ hasText: 'Delayed sentence.' }).count(), 0);
  service.control.delay = 0;
  await command('resume');
  await until(async () => (await status()).value?.phase === 'complete');
  service.control.failText = 'Fail me';
  await page.evaluate(() => addText('Fail me once.'));
  await until(async () => (await status()).value?.phase === 'partial');
  const beforeRetry = service.requests.length;
  service.control.failText = null;
  await command('retry');
  await until(async () => (await status()).value?.phase === 'complete');
  assert.equal(service.requests.length, beforeRetry + 1);
  await command('restore');
  assert.equal(await page.locator('[data-browser-fanyi]').count(), 0);
  assert.equal(await page.locator('#first').textContent(), 'Website latest text.');
  assert.equal(await page.locator('#draft').inputValue(), 'NEW_PRIVATE_DRAFT');
  assert(await page.evaluate(() => firstNode === document.querySelector('#first').firstChild && counterNode === document.querySelector('#counter')));
  console.log('PASS: pause/resume ignores late output; retry only failures; lossless restoration');

  await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#first')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  const beforeSelection = service.requests.length;
  const selectionPageReady = context.waitForEvent('page', { predicate: page => page.url().includes('selection.html') });
  const selected = await send({ type: 'selection.start', tabId });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  const selectionPage = await selectionPageReady;
  await selectionPage.getByText('译文：Website latest text.', { exact: true }).waitFor();
  assert.equal(service.requests.length, beforeSelection + 1);
  assert.equal(service.requests.at(-1).text, 'Website latest text.');
  await selectionPage.getByRole('button', { name: /复制/ }).click();
  await selectionPage.getByText(/已复制/).waitFor();
  await selectionPage.close();
  await page.bringToFront();
  await command('start');
  await until(async () => (await status()).value?.phase === 'complete');
  await page.evaluate(() => history.pushState({}, '', '/fixture-next'));
  await until(async () => (await page.locator('[data-browser-fanyi]').count()) === 0);
  assert.equal((await status()).value.phase, 'interrupted');
  console.log('PASS: explicit selection only, result/active copy, SPA ends the session');

  const isolated = await panel.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: async () => ({
    local: await chrome.storage.local.get(null),
    databases: await indexedDB.databases(),
    denied: await chrome.runtime.sendMessage({ type: 'settings.get' }),
  }) }), tabId);
  assert.equal(JSON.stringify(isolated).includes('fictional-test-key'), false);
  assert.equal(isolated[0].result.databases.some(db => db.name === 'browser-translator'), false);
  assert.equal(isolated[0].result.denied.ok, false);
  console.log('PASS: actual content world cannot read vault or privileged settings');

  await command('start');
  await until(async () => (await status()).value?.phase === 'complete');
  console.log('PASS: explicit restart after SPA navigation uses the current document URL');
  await command('pause');
  const versions = new Map();
  pageCdp.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) if (version.scriptURL.startsWith(base)) versions.set(version.versionId, version);
  });
  await pageCdp.send('ServiceWorker.enable');
  await until(() => [...versions.values()].some(version => version.runningStatus === 'running'));
  const version = [...versions.values()].find(version => version.runningStatus === 'running');
  const beforeRestart = service.requests.length;
  await pageCdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await until(() => versions.get(version.versionId)?.runningStatus === 'stopped');
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings.get' }));
  await until(async () => (await page.locator('[data-browser-fanyi]').count()) === 0);
  assert.equal(service.requests.length, beforeRestart);
  assert.equal((await status()).value.phase, 'interrupted');
  console.log('PASS: service worker stop/restart clears old display without resending');

  await command('start');
  await until(async () => (await status()).value?.phase === 'complete');
  const beforeRevoke = service.requests.length;
  await options.evaluate(() => chrome.permissions.remove({ origins: ['http://127.0.0.1/*'] }));
  await until(async () => (await status()).value?.phase === 'interrupted');
  await page.evaluate(() => addText('After permission revocation.'));
  await new Promise(done => setTimeout(done, 200));
  assert.equal(service.requests.length, beforeRevoke);
  const denied = await send({ type: 'page.command', tabId, action: 'start' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'permission');
  await options.getByRole('button', { name: '清除全部数据（恢复初始状态）', exact: true }).click();
  const cleared = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings.get' }));
  assert.equal(cleared.value.prefix, '');
  assert.equal(cleared.value.hasKey, false);
  console.log('PASS: revocation stops new sends; all local settings/credentials cleared');
}

async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for an observed extension result');
    await new Promise(done => setTimeout(done, 75));
  }
}
