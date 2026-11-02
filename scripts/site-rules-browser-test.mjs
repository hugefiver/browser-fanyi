import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startMock } from './mock-service.mjs';

const root = resolve(import.meta.dirname, '..');
const profiles = resolve(root, '.build-temp');
const profile = await mkdtemp(resolve(profiles, 'sites-chromium-'));
const service = await startMock();
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(), headless: false, viewport: { width: 1100, height: 850 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--disable-component-update'],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: resolve(root, 'dist/chromium') });
  const base = `chrome-extension://${id}`;
  const options = await context.newPage();
  await options.goto(`${base}/options.html`);
  await options.getByLabel('API 前缀地址', { exact: false }).fill(`${service.url}/v1`);
  await options.getByLabel('模型名称', { exact: false }).fill('site-test');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await options.getByText('设置已成功保存', { exact: false }).waitFor();
  await options.getByRole('button', { name: '授权主机权限', exact: true }).click();
  await nativeButton('允许');
  await options.getByText('已授权', { exact: true }).waitFor();
  const popup = await context.newPage();
  await popup.goto(`${base}/popup.html`);
  const source = await context.newPage();
  await source.goto(`${service.url}/fixture`);
  await popup.reload();
  await popup.getByRole('button', { name: '同意长期自动发送并申请此主机所有端口权限' }).click();
  await popup.getByText('站点规则已确认并启用。').waitFor();
  assert.equal(service.requests.length, 0);
  await source.reload();
  await source.locator('[data-browser-fanyi]').first().waitFor();
  await source.waitForFunction(() => document.querySelectorAll('[data-browser-fanyi]').length >= 3);
  assert(service.requests.length > 0);
  console.log('PASS: explicit site consent sends zero; real reload automatically translates');
  await source.bringToFront();
  await popup.reload();
  const pause = await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.runtime.sendMessage({ type: 'page.command', tabId: tab.id, action: 'pause' });
  });
  assert(pause.ok, JSON.stringify(pause));
  const before = service.requests.length;
  await source.evaluate(() => { history.pushState({}, '', '/fixture?spa'); });
  await source.waitForTimeout(500);
  assert.equal(service.requests.length, before);
  await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.runtime.sendMessage({ type: 'page.command', tabId: tab.id, action: 'restore' });
  });
  await source.evaluate(() => { location.hash = 'restored'; });
  await source.waitForTimeout(400);
  assert.equal(service.requests.length, before);
  console.log('PASS: pause/restore suppress same-document navigation');
  await source.reload();
  await source.locator('[data-browser-fanyi]').first().waitFor();
  const beforeOther = service.requests.length;
  await source.goto(`${service.url.replace('127.0.0.1', 'localhost')}/fixture`);
  await source.waitForTimeout(500);
  assert.equal(service.requests.length, beforeOther);
  const cleared = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings.clear', all: false }));
  assert(cleared.ok);
  await options.evaluate(prefix => chrome.runtime.sendMessage({ type: 'settings.save', settings: {
    prefix, model: 'site-test', sourceLanguage: 'auto', targetLanguage: 'zh-CN', mode: 'bilingual', key: { kind: 'keep' },
  } }), `${service.url}/v1`);
  await source.goto(`${service.url}/fixture`);
  await source.waitForTimeout(500);
  assert.equal(service.requests.length, beforeOther);
  console.log('PASS: unlisted origin sends zero; clear and reconfigure cannot restore consent');
} finally {
  await context?.close();
  await service.close();
  const target = resolve(profile);
  if (dirname(target) !== profiles || !target.startsWith(resolve(profiles, 'sites-chromium-'))) throw new Error('Unexpected profile');
  await rm(target, { recursive: true, force: true });
}
function nativeButton(name) {
  return new Promise((done, reject) => {
    const helper = spawn('pwsh', ['-NoProfile', '-File', resolve(root, 'scripts/edge-permission.ps1'), '-ProfilePath', profile, '-ButtonName', name], { stdio: 'inherit' });
    helper.once('error', reject);
    helper.once('exit', code => code === 0 ? done() : reject(new Error(`Permission helper: ${code}`)));
  });
}
