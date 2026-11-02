import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startMock } from './mock-service.mjs';

const root = resolve(import.meta.dirname, '..');
const profiles = resolve(root, '.build-temp');
await mkdir(profiles, { recursive: true });
const profile = await mkdtemp(resolve(profiles, 'subtitles-chromium-'));
const service = await startMock();
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    headless: false,
    viewport: { width: 1100, height: 850 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--disable-component-update'],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: resolve(root, 'dist/chromium') });
  const base = `chrome-extension://${id}`;
  const options = await context.newPage();
  await options.goto(`${base}/options.html`);
  await options.getByLabel('API 前缀地址', { exact: false }).fill(`${service.url}/v1`);
  await options.getByLabel('模型名称', { exact: false }).fill('subtitles-test-model');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await options.getByText('设置已成功保存', { exact: false }).waitFor();
  await options.getByRole('button', { name: '授权主机权限', exact: true }).click();
  await nativeButton('允许');
  await options.getByText('已授权', { exact: true }).waitFor({ timeout: 15_000 });

  const popup = await context.newPage();
  await popup.goto(`${base}/popup.html`);
  const subtitlesPage = context.waitForEvent('page', { predicate: candidate => candidate.url().includes('/subtitles.html') });
  await popup.getByRole('button', { name: 'SRT 字幕翻译（在新标签页打开）' }).click();
  const page = await subtitlesPage;
  await page.getByRole('heading', { name: 'SRT 字幕翻译' }).waitFor();
  const paged = srt(Array.from({ length: 51 }, (_, index) => `local ${index + 1}`));
  await page.getByLabel('选择 SRT 文件').setInputFiles({
    name: 'paged.srt',
    mimeType: 'application/x-subrip',
    buffer: Buffer.from(paged),
  });
  await page.getByText(/已在本机校验 51 条字幕/).waitFor();
  assert.equal(service.requests.length, 0);
  assert.equal(await page.getByText('条目 51 · 编号 51').count(), 0);
  await page.getByRole('button', { name: '下一页' }).click();
  await page.getByText('条目 51 · 编号 51').waitFor();
  assert.equal(service.requests.length, 0);
  console.log('PASS: real file selection and pagination remain local');

  service.control.delay = 700;
  const cancelSource = srt(['cancel one', 'cancel two', 'must not dispatch']);
  await page.getByLabel('选择 SRT 文件').setInputFiles({
    name: 'cancel.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(cancelSource),
  });
  await page.getByLabel(/我确认/).check();
  await page.getByRole('button', { name: '开始翻译全部字幕' }).click();
  await until(() => service.requests.filter((request) => request.text?.startsWith('cancel')).length === 2);
  await page.getByRole('button', { name: '取消翻译' }).click();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
  assert.equal(service.requests.some((request) => request.text === 'must not dispatch'), false);
  console.log('PASS: cancel aborts the owning port and stops later dispatch');

  service.control.delay = 0;
  service.control.failText = 'FAIL_ONCE';
  const partialSource = srt(['first body', 'FAIL_ONCE', 'third body']);
  const requestStart = service.requests.length;
  await page.getByLabel('选择 SRT 文件').setInputFiles({
    name: 'private-name.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(partialSource),
  });
  await page.getByLabel(/我确认/).check();
  await page.getByRole('button', { name: '开始翻译全部字幕' }).click();
  await page.getByRole('button', { name: '重试未完成或失败（1）' }).waitFor();
  const firstAttempt = service.requests.slice(requestStart);
  assert.deepEqual(firstAttempt.map((request) => request.text).sort(), ['FAIL_ONCE', 'first body', 'third body']);
  assert(firstAttempt.every((request) => !request.text.includes('private-name.srt') && !request.text.includes('-->')));

  service.control.failText = null;
  await page.getByRole('button', { name: '重试未完成或失败（1）' }).click();
  await page.getByText(/全部 3 条字幕已完成/).waitFor();
  assert.equal(service.requests.length, requestStart + 4);
  assert.equal(service.requests.at(-1).text, 'FAIL_ONCE');

  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整译文 SRT' }).click();
  const download = await downloadEvent;
  const path = await download.path();
  assert(path);
  const output = await readFile(path, 'utf8');
  assert(output.includes('00:00:00,000 --> 00:00:01,000\r\n译文：first body'));
  assert(output.includes('00:00:01,000 --> 00:00:02,000\r\n译文：FAIL_ONCE'));
  assert(output.endsWith('\r\n'));
  console.log('PASS: partial failure retries only unfinished cue and Blob download preserves SRT structure');

  const afterDownload = service.requests.length;
  const saved = await options.evaluate((prefix) => chrome.runtime.sendMessage({
    type: 'settings.save',
    settings: {
      prefix, model: 'subtitles-test-model-updated', sourceLanguage: 'auto', targetLanguage: 'zh-CN',
      mode: 'bilingual', key: { kind: 'keep' },
    },
  }), `${service.url}/v1`);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await until(() => page.getByRole('button', { name: '下载完整译文 SRT' }).isDisabled());
  assert.equal(service.requests.length, afterDownload);
  console.log('PASS: settings mutation invalidates completed subtitle export without resending');

  await translateOne(page, 'glossary-context.srt', 'glossary context');
  const beforeGlossary = service.requests.length;
  const glossary = await options.evaluate(() => chrome.runtime.sendMessage({
    type: 'glossary.upsert',
    entry: { source: 'glossary context', target: '术语上下文', targetLanguage: 'zh-CN' },
  }));
  assert.equal(glossary.ok, true, JSON.stringify(glossary));
  await until(() => page.getByRole('button', { name: '下载完整译文 SRT' }).isDisabled());
  assert.equal(service.requests.length, beforeGlossary);
  console.log('PASS: glossary mutation invalidates completed subtitle export without resending');

  await translateOne(page, 'permission-context.srt', 'permission context');
  const beforeRevoke = service.requests.length;
  const revoked = await options.evaluate(() => chrome.permissions.remove({ origins: ['http://127.0.0.1/*'] }));
  assert.equal(revoked, true);
  await page.getByText(/当前服务尚未配置完成或未获主机权限/).waitFor();
  assert.equal(await page.getByRole('button', { name: '下载完整译文 SRT' }).isDisabled(), true);
  assert.equal(service.requests.length, beforeRevoke);
  console.log('PASS: permission revocation invalidates completed subtitle export and blocks new sends');
} finally {
  await context?.close();
  await service.close();
  const expectedPrefix = `${profiles}\\subtitles-chromium-`;
  if (profile.startsWith(expectedPrefix) || profile.startsWith(`${profiles}/subtitles-chromium-`)) {
    await rm(profile, { recursive: true, force: true });
  }
}

function nativeButton(name) {
  return new Promise((resolveButton, reject) => {
    const helper = spawn('pwsh', [
      '-NoProfile', '-File', resolve(root, 'scripts/edge-permission.ps1'), '-ProfilePath', profile, '-ButtonName', name,
    ], { stdio: 'inherit' });
    helper.once('error', reject);
    helper.once('exit', (code) => code === 0 ? resolveButton() : reject(new Error(`Native button helper exited ${code}`)));
  });
}

function srt(texts) {
  return texts.map((text, index) => {
    const start = String(index % 60).padStart(2, '0');
    const end = String((index + 1) % 60).padStart(2, '0');
    return `${index + 1}\r\n00:00:${start},000 --> 00:00:${end},000\r\n${text}`;
  }).join('\r\n\r\n');
}

async function translateOne(page, name, text) {
  await page.getByLabel('选择 SRT 文件').setInputFiles({
    name, mimeType: 'application/x-subrip', buffer: Buffer.from(srt([text])),
  });
  await page.getByText(/已在本机校验 1 条字幕/).waitFor();
  await page.getByLabel(/我确认/).check();
  await page.getByRole('button', { name: '开始翻译全部字幕' }).click();
  await page.getByText(/全部 1 条字幕已完成/).waitFor();
}

async function until(check, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for subtitle browser evidence');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
  }
}
