import { spawn } from 'node:child_process';
import { firefox } from 'playwright-core';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startMock } from './mock-service.mjs';

const root = resolve(import.meta.dirname, '..');
const profiles = resolve(root, '.test-profiles');
await mkdir(profiles, { recursive: true });
const profile = await mkdtemp(resolve(profiles, 'firefox-root-'));
const uuid = randomUUID();
await writeFile(resolve(profile, 'user.js'), [
  `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'web-reader@browser-fanyi.local': uuid }))});`,
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
].join('\n'));
const port = await new Promise(done => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); });
});
const service = await startMock();
const process = spawn(firefox.executablePath(), [
  '-wait-for-browser', '-no-remote', '-headless', '-profile', profile, '--remote-debugging-port', String(port), '--remote-allow-system-access', 'about:blank',
], { stdio: 'inherit', env: { ...globalThis.process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });
console.log('Isolated Firefox PID:', process.pid, 'port:', port);
process.on('error', error => console.error('Firefox launch:', error.message));
process.on('exit', code => console.log('Firefox exit:', code));
let socket;
const pending = new Map();
let sequence = 0;
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`BiDi timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(context, expression) {
  const reply = await command('script.evaluate', { target: { context }, expression: `(async () => JSON.stringify(await (${expression})))()`, awaitPromise: true, userActivation: true });
  if (reply.type === 'exception') throw new Error(JSON.stringify(reply.exceptionDetails));
  return reply.result.value === undefined ? undefined : JSON.parse(reply.result.value);
}
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Firefox result did not reach the expected state');
    await new Promise(done => setTimeout(done, 100));
  }
}
async function open(url) {
  const { context } = await command('browsingContext.create', { type: 'tab' });
  await command('browsingContext.navigate', { context, url, wait: 'complete' });
  return context;
}
try {
  const deadline = Date.now() + 15000;
  while (!socket) {
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = new WebSocket(`ws://localhost:${port}/session`);
        candidate.onopen = () => resolve(candidate);
        candidate.onerror = reject;
      });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise(done => setTimeout(done, 200));
    }
  }
  socket.onmessage = event => {
    const value = JSON.parse(event.data);
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    if (value.type === 'error') entry.reject(new Error(`${value.error}: ${value.message}`));
    else entry.resolve(value.result);
  };
  const session = await command('session.new', { capabilities: { alwaysMatch: {} } });
  console.log('Firefox:', session.capabilities.browserVersion);
  const installed = await command('webExtension.install', { extensionData: { type: 'path', path: resolve(root, 'dist/firefox') } });
  assert.equal(installed.extension, 'web-reader@browser-fanyi.local');
  console.log('PASS: actual Firefox temporary extension installed');
  const listed = await command('webExtension.moz:listExtensions');
  const own = listed.extensions.find(item => item.id === installed.extension);
  assert(own?.isActive);
  assert.deepEqual(own.policy.backgroundScripts.map(url => new URL(url).pathname), ['/background.js']);
  const base = own.policy.extensionURL.replace(/\/$/, '');
  const options = await open(`${base}/options.html`);
  const settings = await evaluate(options, `browser.runtime.sendMessage({type:'settings.get'})`);
  assert.equal(settings.ok, true);
  assert.equal(settings.value.prefix, '');
  assert.equal(await evaluate(options, `(await browser.runtime.getBackgroundPage()).document.nodeType`), 9);
  assert.equal(service.requests.length, 0);
  console.log('PASS: actual Firefox temporary extension, event-page messaging, empty configuration');
  const saved = await evaluate(options, `browser.runtime.sendMessage(${JSON.stringify({ type: 'settings.save', settings: { prefix: `${service.url}/v1`, model: 'controlled-test-model', sourceLanguage: 'auto', targetLanguage: 'zh-CN', mode: 'bilingual', key: { kind: 'clear' } } })})`);
  assert.equal(saved.ok, true);
  assert.equal(saved.value.hasKey, false);
  const denied = await evaluate(options, `browser.runtime.sendMessage({type:'service.test'})`);
  assert.equal(denied.error.code, 'permission');
  assert.equal(service.requests.length, 0);
  await command('browsingContext.reload', { context: options, wait: 'complete' });
  await until(async () => await evaluate(options, `[...document.querySelectorAll('button')].some(node => node.textContent.trim()==='授权主机权限' && !node.disabled)`));
  const point = await evaluate(options, `(() => { const button=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='授权主机权限'); button.scrollIntoView(); const rect=button.getBoundingClientRect(); return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}; })()`);
  await command('input.performActions', { context: options, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
  ] }] });
  const chromeTree = await command('browsingContext.getTree', { 'moz:scope': 'chrome' });
  const chromeContext = chromeTree.contexts[0].context;
  await until(async () => await evaluate(chromeContext, `!!document.getElementById('addon-webext-permissions-notification').button`));
  await evaluate(chromeContext, `(document.getElementById('addon-webext-permissions-notification').button.click(), true)`);
  await until(async () => await evaluate(options, `browser.permissions.contains({origins:['http://127.0.0.1/*']})`) === true);
  const tested = await evaluate(options, `browser.runtime.sendMessage({type:'service.test'})`);
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.equal(service.requests.length, 1);
  assert.equal(service.requests[0].text, 'Hello.');
  console.log('PASS: Firefox keyless configuration, unauthorized refusal, native host authorization and controlled service');
  const page = await open(`${service.url.replace('127.0.0.1', 'localhost')}/fixture`);
  const panel = await open(`${base}/popup.html`);
  await command('browsingContext.activate', { context: page });
  await evaluate(chromeContext, `(gUnifiedExtensions.togglePanel(), true)`);
  const actionSelector = `[data-extensionid="web-reader@browser-fanyi.local"] .unified-extensions-item-action-button`;
  await until(async () => await evaluate(chromeContext, `!!document.querySelector(${JSON.stringify(actionSelector)})`));
  await evaluate(chromeContext, `(document.querySelector(${JSON.stringify(actionSelector)}).click(), true)`);
  await until(async () => !!await evaluate(panel, `(await browser.tabs.query({active:true,currentWindow:true}))[0].url`));
  const active = await evaluate(panel, `(await browser.tabs.query({active:true,currentWindow:true}))[0]`);
  assert.equal(active.url, `${service.url.replace('127.0.0.1', 'localhost')}/fixture`);
  const tabId = active.id;
  const send = payload => evaluate(panel, `browser.runtime.sendMessage(${JSON.stringify(payload)})`);
  const status = () => send({ type: 'page.status', tabId });
  const pageCommand = async (action, mode) => {
    const reply = await send({ type: 'page.command', tabId, action, mode });
    assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.value;
  };
  await pageCommand('start');
  await until(async () => (await status()).value?.phase === 'complete');
  assert(service.requests.some(item => item.text === 'Hello test world.'));
  const translatedCount = service.requests.length;
  await pageCommand('mode', 'translation');
  assert.equal(await evaluate(page, `document.querySelector('#first').textContent`), '译文：Hello test world.');
  await pageCommand('mode', 'bilingual');
  assert.equal(service.requests.length, translatedCount);
  await evaluate(page, `(document.querySelector('#draft').value='NEW_PRIVATE_DRAFT', document.querySelector('#counter').click(), addText('Firefox dynamic.'), true)`);
  await until(async () => (await status()).value?.phase === 'complete' && service.requests.some(item => item.text === 'Firefox dynamic.'));
  await pageCommand('pause');
  const pausedCount = service.requests.length;
  await evaluate(page, `(addText('Firefox paused.'), true)`);
  await new Promise(done => setTimeout(done, 250));
  assert.equal(service.requests.length, pausedCount);
  await pageCommand('resume');
  await until(async () => (await status()).value?.phase === 'complete');
  await pageCommand('restore');
  assert.equal(await evaluate(page, `document.querySelectorAll('[data-browser-fanyi]').length`), 0);
  assert.equal(await evaluate(page, `document.querySelector('#draft').value`), 'NEW_PRIVATE_DRAFT');
  assert.equal(await evaluate(page, `clicks`), 1);
  assert.equal(await evaluate(page, `firstNode===document.querySelector('#first').firstChild`), true);
  assert(service.requests.every(item => !item.text.includes('PRIVATE_') && item.cookie === undefined));
  console.log('PASS: Firefox actual activeTab action, page translation, cached modes, dynamic text, pause/resume, lossless restore and privacy');
  await pageCommand('start');
  await until(async () => (await status()).value?.phase === 'complete');
  service.control.failText = 'Failure sample';
  await evaluate(page, `(addText('Failure sample.'), true)`);
  await until(async () => (await status()).value?.phase === 'partial');
  const beforeRetry = service.requests.length;
  service.control.failText = null;
  await pageCommand('retry');
  await until(async () => (await status()).value?.phase === 'complete');
  assert.equal(service.requests.length, beforeRetry + 1);
  await pageCommand('restore');
  await evaluate(page, `(() => { const range=document.createRange(); range.selectNodeContents(document.querySelector('#first')); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; })()`);
  const selected = await send({ type: 'selection.start', tabId });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  let selectionContext;
  await until(async () => {
    const tree = await command('browsingContext.getTree');
    selectionContext = tree.contexts.find(context => context.url.startsWith(`${base}/selection.html`))?.context;
    return !!selectionContext;
  });
  await until(async () => await evaluate(selectionContext, `document.body.textContent.includes('译文：Hello test world.')`));
  await evaluate(selectionContext, `([...document.querySelectorAll('button')].find(button=>button.textContent.includes('复制')).click(),true)`);
  await until(async () => await evaluate(selectionContext, `document.body.textContent.includes('已复制')`));
  await command('browsingContext.close', { context: selectionContext });
  await command('browsingContext.activate', { context: page });
  await pageCommand('start');
  await until(async () => (await status()).value?.phase === 'complete');
  await evaluate(page, `(history.pushState({}, '', '/fixture-next'), true)`);
  await until(async () => (await status()).value?.phase === 'interrupted');
  assert.equal(await evaluate(page, `document.querySelectorAll('[data-browser-fanyi]').length`), 0);
  await pageCommand('start');
  await until(async () => (await status()).value?.phase === 'complete');
  await evaluate(options, `browser.permissions.remove({origins:['http://127.0.0.1/*']})`);
  await until(async () => (await status()).value?.phase === 'interrupted');
  const beforeRevocation = service.requests.length;
  await evaluate(page, `(addText('No permission.'), true)`);
  await new Promise(done => setTimeout(done, 200));
  assert.equal(service.requests.length, beforeRevocation);
  console.log('PASS: Firefox failure-only retry, selection/result/active copy, SPA stop/restart and permission revocation');
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await command('browser.close').catch(() => undefined);
    socket.close();
  }
  if (process.exitCode === null) await new Promise(done => {
    const timer = setTimeout(() => { process.kill(); done(); }, 5000);
    process.once('exit', () => { clearTimeout(timer); done(); });
  });
  await service.close();
  if (profile.startsWith(`${profiles}\\firefox-root-`) || profile.startsWith(`${profiles}/firefox-root-`)) {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
