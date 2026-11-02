import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startMock } from './mock-service.mjs';
const root = resolve(import.meta.dirname, '..');
const profiles = resolve(root, '.build-temp');
const profile = await mkdtemp(resolve(profiles, 'review-chromium-'));
const service = await startMock();
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(), headless: false,
    viewport: { width: 1100, height: 850 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--disable-component-update'] });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: resolve(root, 'dist/chromium') });
  const base = `chrome-extension://${id}`;
  const options = await context.newPage(); await options.goto(`${base}/options.html`);
  await options.getByLabel('API 前缀地址', { exact: false }).fill(`${service.url}/v1`);
  await options.getByLabel('模型名称', { exact: false }).fill('review-mock');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await options.getByText('设置已成功保存', { exact: false }).waitFor();
  await options.getByRole('button', { name: '授权主机权限', exact: true }).click();
  await nativeButton('允许'); await options.getByText('已授权', { exact: true }).waitFor();
  const popup = await context.newPage(); await popup.goto(`${base}/popup.html`);
  const source = await context.newPage(); await source.goto(`${service.url}/fixture`);
  await popup.reload();
  const command = action => popup.evaluate(async action => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.runtime.sendMessage({ type: 'page.command', tabId: tab.id, action,
      ...(action === 'mode' ? { mode: 'translation' } : {}) });
  }, action);
  assert((await command('start')).ok);
  await popup.waitForFunction(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const reply = await chrome.runtime.sendMessage({ type: 'page.status', tabId: tab.id });
    return reply.ok && reply.value.phase === 'complete';
  });
  await popup.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '编辑译文 / 学习显示' && !button.disabled));
  await popup.getByRole('button', { name: '编辑译文 / 学习显示' }).evaluate(button => button.click());
  const panel = source.getByRole('dialog', { name: '译文审查' });
  await panel.waitFor();
  const row = panel.locator('[data-translation-review-entry]').first();
  const oldId = await row.getAttribute('data-translation-review-entry');
  const before = service.requests.length;
  await row.locator('textarea').fill('<img src=x>Local edit');
  await row.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await source.locator('#first').innerText(), 'Hello test world.<img src=x>Local edit');
  assert.equal(await source.locator('#first img').count(), 0);
  await row.getByRole('button', { name: '恢复服务译文' }).click();
  assert.equal(await source.locator('#first').innerText(), 'Hello test world.译文：Hello test world.');
  assert((await command('mode')).ok);
  await panel.getByRole('checkbox', { name: '学习模式' }).check();
  assert.equal(await source.locator('#first').innerText(), 'Hello test world.');
  assert.equal(await row.locator('textarea').isVisible(), false);
  await row.getByRole('button', { name: '揭示译文' }).click();
  assert.equal(await source.locator('#first').innerText(), 'Hello test world.译文：Hello test world.');
  await panel.getByRole('button', { name: '关闭译文审查' }).click();
  assert.equal(await source.locator('#first').innerText(), '译文：Hello test world.');
  assert.equal(service.requests.length, before);
  assert((await command('review')).ok);
  await panel.locator('textarea').first().fill('Unsaved editor draft');
  await source.evaluate(() => { document.body.classList.add('website-state'); });
  await source.waitForTimeout(100);
  assert.equal(await panel.locator('textarea').first().inputValue(), 'Unsaved editor draft');
  await source.evaluate(() => { document.querySelector('#first').firstChild.textContent = 'New website source'; });
  await source.waitForFunction(() => document.querySelector('#first').textContent === '译文：New website source');
  assert.equal(await panel.locator(`[data-translation-review-entry="${oldId}"]`).count(), 0);
  assert((await command('restore')).ok);
  await source.locator('#draft').fill('Website draft after restore');
  await source.getByRole('button', { name: 'Count clicks', exact: true }).click();
  assert.equal(await source.evaluate(() => window.clicks), 1);
  assert.equal(await source.locator('#draft').inputValue(), 'Website draft after restore');
  assert.equal(await source.locator('#first').innerText(), 'New website source');
  console.log('PASS: real page edit/reset/learning/reveal/mode reuse sends zero; draft survives unrelated mutation; source change drops identity; restore preserves input and events');
} finally {
  await context?.close(); await service.close();
  const target = resolve(profile);
  if (dirname(target) !== profiles || !target.startsWith(resolve(profiles, 'review-chromium-'))) throw new Error('Unexpected profile');
  await rm(target, { recursive: true, force: true });
}
function nativeButton(name) {
  return new Promise((done, reject) => {
    const helper = spawn('pwsh', ['-NoProfile', '-File', resolve(root, 'scripts/edge-permission.ps1'), '-ProfilePath', profile, '-ButtonName', name], { stdio: 'inherit' });
    helper.once('error', reject); helper.once('exit', code => code === 0 ? done() : reject(new Error(`Permission helper: ${code}`)));
  });
}
