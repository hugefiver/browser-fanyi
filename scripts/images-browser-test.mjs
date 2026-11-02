import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startMock } from './mock-service.mjs';
const root = resolve(import.meta.dirname, '..');
const profiles = resolve(root, '.build-temp');
const profile = await mkdtemp(resolve(profiles, 'images-chromium-'));
const service = await startMock();
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(), headless: false,
    viewport: { width: 1100, height: 850 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--disable-component-update'] });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: resolve(root, 'dist/chromium') });
  const base = `chrome-extension://${id}`;
  const options = await context.newPage();
  await options.goto(`${base}/options.html`);
  await options.getByLabel('API 前缀地址', { exact: false }).fill(`${service.url}/v1`);
  await options.getByLabel('模型名称', { exact: false }).fill('vision-mock');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await options.getByText('设置已成功保存', { exact: false }).waitFor();
  await options.getByRole('button', { name: '授权主机权限', exact: true }).click();
  await nativeButton('允许');
  await options.getByText('已授权', { exact: true }).waitFor();
  const popup = await context.newPage();
  await popup.goto(`${base}/popup.html`);
  const source = await context.newPage();
  await source.goto(`${service.url}/fixture`);
  await source.evaluate(() => { document.body.innerHTML = '<div style="position:fixed;inset:0;background:red"><div style="position:absolute;left:50px;top:50px;width:400px;height:300px;background:rgb(0,0,255)"></div></div>'; });
  const targets = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  await cdp.send('Extensions.triggerAction', { id, targetId: targets.targetInfos.find(t => t.url === source.url()).targetId });
  await source.bringToFront();
  await source.keyboard.press('Escape');
  await popup.reload();
  await popup.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '框选区域截图（本地预览）' && !button.disabled));
  await source.bringToFront();

  const opened = context.waitForEvent('page', { timeout: 30000 });
  opened.catch(() => undefined);
  await popup.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '框选区域截图（本地预览）').click());

  await source.getByRole('application', { name: '拖动选择截图区域，按 Escape 取消' }).waitFor();
  await source.mouse.move(100, 100); await source.mouse.down();
  await source.mouse.move(300, 200, { steps: 6 }); await source.mouse.up();
  await popup.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '框选区域截图（本地预览）' && !button.disabled));
  const captureErrors = await popup.getByRole('alert').allTextContents();
  const captureFailed = captureErrors.find(text => text === '活动标签页或窗口已变化，请重新框选。');
  let page;
  if (captureFailed) {
    console.error('BLOCKED: OS window focus left Chromium during selection; capture correctly refused. Pixel upload check remains unverified.');
    process.exitCode = 1;
    page = await context.newPage();
    await page.goto(`${base}/workbench.html`);
    await page.getByRole('tab', { name: '图片与截图' }).click();
  } else {
  page = await opened;
  await page.getByRole('img', { name: '实际待上传 PNG 预览' }).waitFor();
  assert.equal(service.requests.length, 0);
  service.control.output = '{"source":"Hello image","translation":"图像译文"}';
  await page.getByRole('button', { name: '确认并发送当前区域', exact: true }).click();
  await page.getByLabel('图像译文内容').waitFor();
  const imageUrl = service.requests[0].body.messages[1].content[0].image_url.url;
  const pixels = await page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 200 && pixels[i + 2] < 50) red++;
    return { width: image.width, height: image.height, red, first: [...pixels.slice(0, 4)] };
  }, imageUrl);
  assert.deepEqual(pixels, { width: 200, height: 100, red: 0, first: [0, 0, 255, 255] });
  console.log('PASS: real captureVisibleTab + trusted drag; preview before send; outside red pixels never uploaded');
  }
  const beforeFile = service.requests.length;
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 80, 40); ctx.fillStyle = 'black'; ctx.fillText('Local', 5, 20);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('选择图像文件').setInputFiles({ name: 'private-image.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('region', { name: '实际待上传图像' }).getByText(/80 × 40/).waitFor();
  assert.equal(service.requests.length, beforeFile);
  service.control.output = '{"source":"Local image","translation":"本地图像译文"}';
  await page.getByRole('button', { name: '确认并发送当前区域', exact: true }).click();
  await page.getByLabel('图像译文内容').waitFor();
  assert.equal(service.requests.length, beforeFile + 1);
  assert(!JSON.stringify(service.requests.at(-1).body).includes('private-image.png'));
  service.control.output = 'invalid JSON';
  await page.getByRole('button', { name: '重新确认并发送当前区域', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'invalid-response' }).waitFor();
  service.control.delay = 800;
  service.control.output = '{"source":"late","translation":"LATE IMAGE"}';
  await page.getByRole('button', { name: '确认并发送当前区域', exact: true }).click();
  await page.getByRole('button', { name: '取消识别', exact: true }).click();
  await page.waitForTimeout(1000);
  assert.equal(await page.getByText('LATE IMAGE', { exact: true }).count(), 0);
  console.log('PASS: real canvas file decode remains local; invalid structured response and cancelled late result');
} finally {
  await context?.close(); await service.close();
  const target = resolve(profile);
  if (dirname(target) !== profiles || !target.startsWith(resolve(profiles, 'images-chromium-'))) throw new Error('Unexpected profile');
  await rm(target, { recursive: true, force: true });
}
function nativeButton(name) {
  return new Promise((done, reject) => {
    const helper = spawn('pwsh', ['-NoProfile', '-File', resolve(root, 'scripts/edge-permission.ps1'), '-ProfilePath', profile, '-ButtonName', name], { stdio: 'inherit' });
    helper.once('error', reject); helper.once('exit', code => code === 0 ? done() : reject(new Error(`Permission helper: ${code}`)));
  });
}
