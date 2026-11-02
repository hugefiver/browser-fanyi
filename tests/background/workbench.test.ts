import { describe, expect, it, vi } from 'vitest';
import type browser from '../../src/shared/browser';
import type { Runtime } from 'webextension-polyfill';
import { Workbench } from '../../src/background/workbench';
import type { PageSessions } from '../../src/background/pages';
import type { TranslationSnapshot } from '../../src/background/settings';
import type { InputAssistCapture } from '../../src/content/input-assist';
import { defaultPreferences, type Reply } from '../../src/shared/contracts';
import { WORKBENCH_PORT_NAME, type WorkbenchContext, type WorkbenchServerMessage, type WritingOperation } from '../../src/shared/workbench';

class Event<T extends (...args: never[]) => void> {
  listeners: T[] = [];
  addListener = (listener: T) => { this.listeners.push(listener); };
  emit(...args: Parameters<T>) { this.listeners.forEach(listener => listener(...args)); }
}
class Port {
  onMessage = new Event<(value: unknown) => void>();
  onDisconnect = new Event<() => void>();
  posted: WorkbenchServerMessage[] = [];
  disconnected = false;
  constructor(readonly sender: Runtime.MessageSender = { id: 'test', url: 'chrome-extension://test/workbench.html' }, readonly name = WORKBENCH_PORT_NAME) {}
  postMessage = (message: WorkbenchServerMessage) => { this.posted.push(message); };
  disconnect = () => { this.disconnected = true; this.onDisconnect.emit(); };
  receive(value: unknown) { this.onMessage.emit(value); }
}
const capture: InputAssistCapture = {
  id: 'document:1', instanceId: 'document', kind: 'textarea', url: 'https://page.example/',
  originalValue: 'Original draft', selectedText: '', sourceText: 'Original draft', selection: { start: 0, end: 0, direction: 'none' }, canApply: true,
};
const settings: TranslationSnapshot = { ...defaultPreferences, prefix: 'https://receiver.example/v1', model: 'model', key: 'secret', glossary: [] };
function fixture() {
  let context: WorkbenchContext = { contextId: 'boot:0', settings: { ...defaultPreferences, prefix: settings.prefix, model: settings.model, hasKey: true, authorized: true } };
  const onConnect = new Event<(port: Runtime.Port) => void>();
  const onRemoved = new Event<(tabId: number) => void>();
  const onNavigate = new Event<(details: { tabId: number; frameId: number }) => void>();
  const sendMessage = vi.fn(async (_tabId: number, message: { type: string }) => message.type === 'input.capture' ? capture : { ok: true, value: 'written' });
  const api = {
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onConnect },
    tabs: { onRemoved, onActivated: new Event<(info: { tabId: number }) => void>(), sendMessage, query: vi.fn(async () => [{ id: 1 }]), get: vi.fn(async () => ({ url: capture.url })), create: vi.fn(async (_options: { url: string }) => ({ id: 22 })) },
    webNavigation: { onCommitted: onNavigate, onHistoryStateUpdated: onNavigate, onReferenceFragmentUpdated: onNavigate },
  };
  const pages = { activeTab: vi.fn(async () => capture.url), version: vi.fn(() => 0), inject: vi.fn(async () => undefined) };
  const ready = vi.fn(async (): Promise<Reply<TranslationSnapshot>> => ({ ok: true, value: settings }));
  const send = vi.fn(async (_settings: TranslationSnapshot, text: string, _signal: AbortSignal, _operation: WritingOperation): Promise<Reply<string>> => ({ ok: true, value: `done:${text}` }));
  const workbench = new Workbench(api as unknown as typeof browser, pages as unknown as PageSessions, ready, send, async () => context, async () => ({ ok: true, value: '{"source":"image","translation":"图像"}' }));
  workbench.install();
  return { workbench, api, pages, ready, send, onNavigate, onRemoved,
    setContext: (id: string) => { context = { ...context, contextId: id }; },
    connect: (port = new Port()) => { onConnect.emit(port as unknown as Runtime.Port); return port; } };
}
async function hello(port: Port) { await vi.waitFor(() => expect(port.posted.some(message => message.type === 'hello')).toBe(true)); }
const start = (port: Port, id = 'request', text = 'hello', operation: WritingOperation = 'translate') => port.receive({ type: 'translate', id, contextId: 'boot:0', text, operation });
const results = (port: Port) => port.posted.filter(message => message.type === 'result');
async function bind(ctx: ReturnType<typeof fixture>) {
  expect(await ctx.workbench.capture(1)).toEqual({ ok: true, value: null });
  const url = ctx.api.tabs.create.mock.calls[0][0].url;
  const port = ctx.connect(new Port({ id: 'test', frameId: 0, tab: { id: 22 } as Runtime.MessageSender['tab'], url }));
  await hello(port);
  return { port, url };
}

describe('workbench ownership and explicit tasks', () => {
  it('accepts native sidebar without sender.tab and does not send on connect', async () => {
    const ctx = fixture();
    const port = ctx.connect();
    await hello(port);
    expect(ctx.send).not.toHaveBeenCalled();
    expect(JSON.stringify(port.posted)).not.toContain('secret');
    start(port, 'writing', 'draft', 'polish');
    await vi.waitFor(() => expect(results(port)).toHaveLength(1));
    expect(ctx.send.mock.calls[0][3]).toBe('polish');
  });

  it('binds cropped previews to one workbench tab and sends images only on confirmation', async () => {
    const ctx = fixture();
    await ctx.workbench.openImage('data:image/png;base64,cHJldmlldw==', 'boot:0');
    const url = ctx.api.tabs.create.mock.calls[0][0].url;
    expect(ctx.connect(new Port({ id: 'test', url, tab: { id: 99 } as Runtime.MessageSender['tab'] })).disconnected).toBe(true);
    const port = ctx.connect(new Port({ id: 'test', url, tab: { id: 22 } as Runtime.MessageSender['tab'] }));
    await hello(port);
    expect(port.posted[0]).toMatchObject({ type: 'hello', image: 'data:image/png;base64,cHJldmlldw==' });
    expect(results(port)).toHaveLength(0);
    port.receive({ type: 'image', id: 'image', contextId: 'boot:0', dataUrl: 'data:image/png;base64,cHJldmlldw==' });
    await vi.waitFor(() => expect(results(port)).toHaveLength(1));
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('rejects foreign pages, subframes, query paths and another tab claiming a capture', async () => {
    const ctx = fixture();
    for (const sender of [
      { id: 'foreign', url: 'chrome-extension://test/workbench.html' },
      { id: 'test', url: 'https://page.example/workbench.html' },
      { id: 'test', url: 'chrome-extension://test/workbench.html?extra=1' },
      { id: 'test', url: 'chrome-extension://test/workbench.html', frameId: 2 },
    ]) expect(ctx.connect(new Port(sender)).disconnected).toBe(true);
    const unrelated = ctx.connect(new Port(undefined, 'subtitles'));
    expect(unrelated.disconnected).toBe(false);
    const { url } = await bind(ctx);
    expect(ctx.connect(new Port({ id: 'test', url, tab: { id: 23 } as Runtime.MessageSender['tab'] })).disconnected).toBe(true);
  });

  it('rejects arbitrary operations, oversized input and stale context', async () => {
    const ctx = fixture();
    const port = ctx.connect();
    await hello(port);
    port.receive({ type: 'translate', id: 'tool', contextId: 'boot:0', text: 'x', operation: 'execute' });
    start(port, 'long', 'x'.repeat(2001));
    port.receive({ type: 'translate', id: 'old', contextId: 'old', text: 'x', operation: 'translate' });
    await Promise.resolve();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('cancels exactly the owner request and ignores late replies after disconnect', async () => {
    const ctx = fixture();
    let finish!: (reply: Reply<string>) => void;
    ctx.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const owner = ctx.connect();
    const other = ctx.connect();
    await hello(owner); await hello(other);
    start(owner);
    await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledOnce());
    other.receive({ type: 'cancel', id: 'request' });
    expect(ctx.send.mock.calls[0][2].aborted).toBe(false);
    owner.disconnect();
    expect(ctx.send.mock.calls[0][2].aborted).toBe(true);
    finish({ ok: true, value: 'late' });
    await Promise.resolve();
    expect(results(owner)).toHaveLength(0);
  });

  it('cancels while ready is pending and never sends after cancel', async () => {
    const ctx = fixture();
    let finish!: (reply: Reply<TranslationSnapshot>) => void;
    ctx.ready.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const port = ctx.connect(); await hello(port);
    start(port);
    port.receive({ type: 'cancel', id: 'request' });
    finish({ ok: true, value: settings });
    await vi.waitFor(() => expect(ctx.ready).toHaveBeenCalledOnce());
    expect(ctx.send).not.toHaveBeenCalled();
  });
});

describe('captured input owner lifecycle', () => {
  it('preserves a capture through the new owner tab initial navigation and cancels on close', async () => {
    const ctx = fixture();
    await ctx.workbench.capture(1);
    const url = ctx.api.tabs.create.mock.calls[0][0].url;
    ctx.onNavigate.emit({ tabId: 22, frameId: 0 });
    const port = ctx.connect(new Port({ id: 'test', url, tab: { id: 22 } as Runtime.MessageSender['tab'] }));
    await hello(port);
    expect(port.posted[0]).toMatchObject({ type: 'hello', capture });
    ctx.onRemoved.emit(22);
    expect(port.posted.some(message => message.type === 'invalidated')).toBe(true);
  });

  it('previews without writing, then applies and restores only the captured source', async () => {
    const ctx = fixture();
    const { port } = await bind(ctx);
    ctx.api.tabs.sendMessage.mockClear();
    port.receive({ type: 'apply', id: 'early', contextId: 'boot:0', text: 'unapproved' });
    await vi.waitFor(() => expect(port.posted.some(message => message.type === 'input-result')).toBe(true));
    expect(ctx.api.tabs.sendMessage).not.toHaveBeenCalled();
    start(port, 'preview', capture.sourceText, 'correct');
    await vi.waitFor(() => expect(results(port)).toHaveLength(1));
    expect(ctx.api.tabs.sendMessage).not.toHaveBeenCalled();
    port.receive({ type: 'apply', id: 'apply', contextId: 'boot:0', text: 'Edited preview' });
    await vi.waitFor(() => expect(ctx.api.tabs.sendMessage).toHaveBeenCalledOnce());
    expect(ctx.api.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'input.apply', id: capture.id, instanceId: capture.instanceId, text: 'Edited preview' }, { frameId: 0 });
    port.receive({ type: 'restore', id: 'restore', contextId: 'boot:0' });
    await vi.waitFor(() => expect(ctx.api.tabs.sendMessage).toHaveBeenCalledTimes(2));
    expect(ctx.api.tabs.sendMessage).toHaveBeenLastCalledWith(1, { type: 'input.restore', id: capture.id, instanceId: capture.instanceId }, { frameId: 0 });
  });

  it('invalidates binding and running requests on context changes', async () => {
    const ctx = fixture();
    const { port } = await bind(ctx);
    ctx.send.mockImplementation(() => new Promise(() => undefined));
    start(port, 'run', capture.sourceText);
    await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledOnce());
    ctx.setContext('boot:1');
    await ctx.workbench.contextChanged();
    expect(ctx.send.mock.calls[0][2].aborted).toBe(true);
    expect(ctx.api.tabs.sendMessage).toHaveBeenLastCalledWith(1, { type: 'input.invalidate', id: capture.id, instanceId: capture.instanceId }, { frameId: 0 });
    ctx.api.tabs.sendMessage.mockClear();
    port.receive({ type: 'apply', id: 'stale', contextId: 'boot:1', text: 'stale' });
    await vi.waitFor(() => expect(port.posted.some(message => message.type === 'input-result')).toBe(true));
    expect(ctx.api.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('navigation or closing the bound page invalidates only its session', async () => {
    const ctx = fixture();
    const { port } = await bind(ctx);
    const independent = ctx.connect(); await hello(independent);
    ctx.onNavigate.emit({ tabId: 1, frameId: 0 });
    expect(port.posted.some(message => message.type === 'invalidated')).toBe(true);
    expect(independent.posted.some(message => message.type === 'invalidated')).toBe(false);
    start(independent);
    await vi.waitFor(() => expect(results(independent)).toHaveLength(1));
  });
});
