import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startMock } from './mock-service.mjs';
const root = resolve(import.meta.dirname, '..');
const profiles = resolve(root, '.build-temp');
const profile = await mkdtemp(resolve(profiles, 'video-chromium-'));
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
  await options.getByLabel('模型名称', { exact: false }).fill('video-mock');
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await options.getByText('设置已成功保存', { exact: false }).waitFor();
  await options.getByRole('button', { name: '授权主机权限', exact: true }).click();
  await nativeButton('允许');
  await options.getByText('已授权', { exact: true }).waitFor();
  const popup = await context.newPage(); await popup.goto(`${base}/popup.html`);
  const source = await context.newPage(); await source.goto(`${service.url}/fixture`);
  const media = await source.evaluate(async () => {
    document.body.replaceChildren();
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 160, 90);
    const stream = canvas.captureStream(0);
    const videoTrack = stream.getVideoTracks()[0];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = []; recorder.ondataavailable = event => chunks.push(event.data);
    const started = new Promise(resolve => { recorder.addEventListener('start', resolve, { once: true }); });
    const done = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(); await started;
    let frame = 0;
    for (; frame < 60; frame += 1) {
      ctx.fillStyle = frame % 2 ? 'blue' : 'green'; ctx.fillRect(0, 0, 160, 90);
      videoTrack.requestFrame();
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    recorder.stop(); await done;
    stream.getTracks().forEach(track => track.stop());
    const video = document.createElement('video'); video.id = 'media'; video.controls = true; video.muted = true;
    const event = name => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Media fixture ${name}: ready=${video.readyState}, duration=${video.duration}, time=${video.currentTime}, error=${video.error?.code}, bytes=${chunks.reduce((sum, blob) => sum + blob.size, 0)}, frames=${frame}, mime=${recorder.mimeType}`)), 5000);
      video.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const loaded = event('loadeddata');
    video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })); document.body.append(video);
    await loaded;
    if (!Number.isFinite(video.duration)) { const seeked = event('seeked'); video.currentTime = 1e10; await seeked; }
    const seeked = event('seeked'); video.currentTime = 0.1; await seeked;
    const track = video.addTextTrack('subtitles', 'Readable local track', 'en'); track.mode = 'hidden';
    track.addCue(new VTTCue(0, 0.8, 'First real cue'));
    track.addCue(new VTTCue(0.8, 1.6, 'Second real cue'));
    track.addCue(new VTTCue(1.6, 2.3, 'Late real cue'));
    return { duration: video.duration, seekable: video.seekable.length, currentTime: video.currentTime };
  });
  assert(media.seekable > 0 && media.currentTime < 0.2, JSON.stringify(media));
  await popup.reload();
  const read = popup.getByRole('button', { name: '读取文字轨 / 刷新字幕状态' });
  await popup.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '读取文字轨 / 刷新字幕状态' && !button.disabled));
  await read.evaluate(button => button.click());
  await popup.getByLabel('视频与字幕轨').click();
  await popup.getByRole('option', { name: /Readable local track/ }).click();
  assert.equal(service.requests.length, 0);
  await source.bringToFront();
  await popup.getByRole('button', { name: '同意本次播放发送并开启字幕翻译' }).evaluate(button => button.click());
  await source.getByText('译文：First real cue', { exact: true }).waitFor();
  assert.deepEqual(service.requests.map(r => r.text), ['First real cue']);
  await source.getByRole('button', { name: '0:00 Second real cue' }).click();
  await source.getByText('译文：Second real cue', { exact: true }).waitFor();
  assert(await source.locator('#media').evaluate(video => video.currentTime >= 0.8 && video.paused));
  service.control.delay = 700;
  await source.getByRole('button', { name: '0:01 Late real cue' }).click();
  await source.waitForFunction(() => document.querySelector('[data-video-subtitle-original]')?.textContent === 'Late real cue');
  await source.getByRole('button', { name: '0:00 First real cue' }).click();
  await source.waitForTimeout(900);
  assert.equal(await source.locator('[data-video-subtitle-translation]').innerText(), '译文：First real cue');
  const beforeClose = service.requests.length;
  await source.getByRole('button', { name: '关闭视频字幕翻译', exact: true }).click();
  await source.locator('#media').evaluate(video => { video.currentTime = 1.8; });
  await source.waitForTimeout(300);
  assert.equal(await source.locator('[data-video-subtitle-translation]').count(), 0);
  assert.equal(service.requests.length, beforeClose);
  console.log('PASS: real recorded video and TextTrack; inspection sends zero; current cue, real seek without play, cached rewind, late suppression, close');
} finally {
  await context?.close(); await service.close();
  const target = resolve(profile);
  if (dirname(target) !== profiles || !target.startsWith(resolve(profiles, 'video-chromium-'))) throw new Error('Unexpected profile');
  await rm(target, { recursive: true, force: true });
}
function nativeButton(name) {
  return new Promise((done, reject) => {
    const helper = spawn('pwsh', ['-NoProfile', '-File', resolve(root, 'scripts/edge-permission.ps1'), '-ProfilePath', profile, '-ButtonName', name], { stdio: 'inherit' });
    helper.once('error', reject); helper.once('exit', code => code === 0 ? done() : reject(new Error(`Permission helper: ${code}`)));
  });
}
