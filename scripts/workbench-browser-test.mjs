import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startMock } from './mock-service.mjs';

const root = resolve(import.meta.dirname, '..');
const profiles = resolve(root, '.build-temp');
await mkdir(profiles, { recursive: true });
const profile = await mkdtemp(resolve(profiles, 'workbench-chromium-'));
const service = await startMock();
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(), headless: false, viewport: { width: 1100, height: 850 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--disable-component-update'],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  console.log('Browser:', (await cdp.send('Browser.getVersion')).product);
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: resolve(root, 'dist/chromium') });
  const base = `chrome-extension://${id}`;
  const options = await context.newPage();
  await options.goto(`${base}/options.html`);
  await options.getByLabel('API 前缀地址', { exact: false }).fill(`${service.url}/v1`);
  await options.getByLabel('模型名称', { exact: false }).fill('workbench-test-model');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await options.getByText('设置已成功保存', { exact: false }).waitFor();
  await options.getByRole('button', { name: '授权主机权限', exact: true }).click();
  await nativeButton('允许');
  await options.getByText('已授权', { exact: true }).waitFor();
  const popup = await context.newPage();
  await popup.goto(`${base}/popup.html`);
  const opened = context.waitForEvent('page');
  await popup.getByRole('button', { name: '翻译与写作工作台' }).click();
  const page = await opened;
  await page.getByRole('heading', { name: '翻译与写作工作台' }).waitFor();
  await page.getByText(/workbench-test-model/).waitFor();
  assert.equal(service.requests.length, 0);
  await page.getByLabel('待处理文字', { exact: true }).fill('Local text');
  assert.equal(service.requests.length, 0);
  await page.getByRole('button', { name: '确认发送并翻译' }).click();
  await page.getByLabel('结果预览（可编辑）').waitFor();
  assert.equal(service.requests.at(-1).text, 'Local text');
  await page.getByLabel('结果预览（可编辑）').fill('Edited result');
  await page.getByRole('button', { name: '恢复服务结果' }).click();
  assert.equal(await page.getByLabel('结果预览（可编辑）').inputValue(), '译文：Local text');
  await page.getByRole('button', { name: '复制结果' }).click();
  await page.getByText('已复制。', { exact: true }).waitFor();
  await page.getByLabel('操作', { exact: true }).click();
  await page.getByRole('option', { name: '润色', exact: true }).click();
  await page.getByRole('button', { name: '确认发送并润色' }).click();
  await page.getByLabel('结果预览（可编辑）').waitFor();
  assert.match(service.requests.at(-1).body.messages[0].content, /polish/i);
  console.log('PASS: popup opens local workbench; explicit translation/writing, edit/restore/copy use real API');

  await page.getByRole('tab', { name: 'TXT / HTML 文档' }).click();
  const beforeFile = service.requests.length;
  const externalDocumentRequests = [];
  page.on('request', request => { if (request.url().startsWith('https://never.invalid/')) externalDocumentRequests.push(request.url()); });
  await page.getByLabel('选择文档文件').setInputFiles({ name: 'private-name.html', mimeType: 'text/html',
    buffer: Buffer.from('<h1>Document title</h1><p>Document body</p><img src="https://never.invalid/private"><script>secret()</script>') });
  await page.getByRole('region', { name: '文档原文预览' }).waitFor();
  assert.equal(service.requests.length, beforeFile);
  assert.equal(await page.getByRole('region', { name: '文档原文预览' }).locator('img,script').count(), 0);
  await page.getByRole('button', { name: '确认发送并翻译（最多100段）' }).click();
  await page.getByText(/翻译已完成 ·/).waitFor();
  for (const label of ['导出 TXT', '导出安全 HTML']) {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: label, exact: true }).click();
    const download = await downloaded;
    const output = await readFile(await download.path(), 'utf8');
    assert(output.includes('译文：Document body'));
    assert(!output.includes('never.invalid') && !output.includes('secret()'));
  }
  assert.deepEqual(service.requests.slice(beforeFile).map(request => request.text), ['Document title', 'Document body']);
  assert.deepEqual(externalDocumentRequests, []);
  console.log('PASS: local safe HTML preview; only reading text sent; real TXT and HTML Blob downloads');

  const source = await context.newPage();
  await source.goto(`${service.url.replace('127.0.0.1', 'localhost')}/fixture`);
  await source.locator('#draft').fill('Original input draft');
  await source.locator('#draft').focus();
  await source.locator('#draft').evaluate(element => element.setSelectionRange(0, 0));
  const targets = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const target = targets.targetInfos.find(item => item.url === source.url());
  assert(target);
  await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
  await source.bringToFront();
  await popup.reload();
  await popup.getByRole('button', { name: '捕获输入并打开工作台' }).waitFor();
  const capturedPage = context.waitForEvent('page');
  await popup.getByRole('button', { name: '捕获输入并打开工作台' }).click();
  const input = await capturedPage;
  await input.getByLabel('捕获的源文字').waitFor();
  assert.equal(await input.getByLabel('捕获的源文字').inputValue(), 'Original input draft');
  const beforePreview = service.requests.length;
  await input.getByRole('button', { name: '确认发送并翻译' }).click();
  await input.getByLabel('结果预览（可编辑）').waitFor();
  assert.equal(await source.locator('#draft').inputValue(), 'Original input draft');
  assert.equal(service.requests.length, beforePreview + 1);
  await input.getByRole('button', { name: '确认写回源字段' }).click();
  await input.getByText('已写回源字段，未提交表单。').waitFor();
  assert.equal(await source.locator('#draft').inputValue(), '译文：Original input draft');
  await source.locator('#draft').fill('User changed draft');
  await input.getByRole('button', { name: '恢复源字段原文' }).click();
  await input.getByText(/写入后您已改稿，拒绝覆盖/).waitFor();
  assert.equal(await source.locator('#draft').inputValue(), 'User changed draft');
  console.log('PASS: initial focused capture; preview writes zero; confirmed real write; later draft rejects restore');

  const beforeSidebar = service.requests.length;
  await source.bringToFront();
  await popup.getByRole('button', { name: '打开原生侧栏' }).click();
  await popup.waitForFunction(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }))
    .some(item => item.documentUrl.endsWith('/workbench.html?sidebar=1')));
  assert.equal(service.requests.length, beforeSidebar);
  console.log('PASS: native Chromium SIDE_PANEL opens same workbench without sending');
  const sidebarTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url === `${base}/workbench.html?sidebar=1`);
  assert(sidebarTarget, 'Native sidebar target must exist');
  const sidebar = await attachSidebar(cdp, sidebarTarget.targetId);
  await until(async () => (await sidebar.evaluate('document.body.innerText')).includes('当前授权网页'));
  await until(async () => await sidebar.evaluate("[...document.querySelectorAll('button')].some(button => button.textContent === '开始整页翻译' && !button.disabled)"));
  await sidebar.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === '开始整页翻译').click()");
  await source.locator('[data-browser-fanyi]').first().waitFor();
  await sidebar.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === '暂停整页翻译').click()");
  await until(async () => (await sidebar.evaluate('document.body.innerText')).includes('已暂停'));
  await sidebar.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === '还原当前网页').click()");
  await source.waitForFunction(() => !document.querySelector('[data-browser-fanyi]'));
  const unauthorized = await context.newPage();
  await unauthorized.goto(`${service.url.replace('127.0.0.1', 'localhost')}/fixture`);
  await until(async () => (await sidebar.evaluate('document.body.innerText')).includes('先点击该页的扩展工具栏'));
  assert(await sidebar.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === '开始整页翻译').disabled"));
  await sidebar.detach();
  console.log('PASS: native sidebar starts/pauses/restores authorized page and follows tab switch without expanding permission');
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.screenshot({ path: resolve(profiles, 'workbench-documents.png'), fullPage: true });
} finally {
  await context?.close();
  await service.close();
  const target = resolve(profile);
  if (dirname(target) !== profiles || !target.startsWith(resolve(profiles, 'workbench-chromium-'))) throw new Error('Unexpected owned profile path');
  await rm(target, { recursive: true, force: true });
}

async function attachSidebar(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
  let sequence = 0;
  const pending = new Map();
  const receive = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const finish = pending.get(message.id);
    if (finish) { pending.delete(message.id); finish(message); }
  };
  cdp.on('Target.receivedMessageFromTarget', receive);
  return {
    evaluate(expression) {
      const id = ++sequence;
      return new Promise((done, reject) => {
        pending.set(id, message => {
          if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
          else done(message.result.result.value);
        });
        void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }) }).catch(reject);
      });
    },
    async detach() { cdp.off('Target.receivedMessageFromTarget', receive); await cdp.send('Target.detachFromTarget', { sessionId }); },
  };
}

async function until(check) {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for native sidebar behavior');
    await new Promise(done => setTimeout(done, 75));
  }
}

function nativeButton(name) {
  return new Promise((done, reject) => {
    const helper = spawn('pwsh', ['-NoProfile', '-File', resolve(root, 'scripts/edge-permission.ps1'), '-ProfilePath', profile, '-ButtonName', name], { stdio: 'inherit' });
    helper.once('error', reject);
    helper.once('exit', code => code === 0 ? done() : reject(new Error(`Native permission helper exited ${code}`)));
  });
}
