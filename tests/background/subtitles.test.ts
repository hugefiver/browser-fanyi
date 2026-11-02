import { describe, expect, it, vi } from 'vitest';
import type browser from '../../src/shared/browser';
import type { Runtime } from 'webextension-polyfill';
import { Subtitles } from '../../src/background/subtitles';
import { defaultPreferences, fail, type PublicSettings, type Reply } from '../../src/shared/contracts';
import { SUBTITLES_PORT_NAME, type SubtitlesContext, type SubtitlesServerMessage } from '../../src/shared/subtitles';
import type { TranslationSnapshot } from '../../src/background/settings';
import { SRT_MAX_TRANSLATION_BYTES } from '../../src/shared/srt';

class FakeEvent<T extends (...args: never[]) => void> {
  listeners: T[] = [];
  addListener = (listener: T) => { this.listeners.push(listener); };
  emit(...args: Parameters<T>) { for (const listener of this.listeners) listener(...args); }
}

class FakePort {
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly posted: SubtitlesServerMessage[] = [];
  disconnected = false;

  constructor(
    readonly name = SUBTITLES_PORT_NAME,
    readonly sender: Runtime.MessageSender = {
      id: 'clean-room',
      frameId: 0,
      url: 'chrome-extension://clean-room/subtitles.html',
    },
  ) {}

  postMessage = (message: SubtitlesServerMessage) => { this.posted.push(message); };
  disconnect = () => {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  };
  receive(message: unknown) { this.onMessage.emit(message); }
}

const settings: TranslationSnapshot = {
  ...defaultPreferences,
  prefix: 'https://receiver.example/v1',
  model: 'test-model',
  key: 'private-key',
  glossary: [],
};
const publicSettings: PublicSettings = {
  ...defaultPreferences,
  prefix: settings.prefix,
  model: settings.model,
  hasKey: true,
  authorized: true,
};
const source = (texts: string[]) => texts.map((text, index) => `${index + 1}\n00:00:0${index},000 --> 00:00:0${index + 1},000\n${text}`).join('\n\n');
const runId = () => crypto.randomUUID();

function fixture(send = vi.fn(async (_settings: TranslationSnapshot, text: string): Promise<Reply<string>> => ({ ok: true, value: `译文 ${text}` }))) {
  let onConnect!: (port: Runtime.Port) => void;
  let context: SubtitlesContext = { contextId: 'boot-a:0', settings: publicSettings };
  const api = {
    runtime: {
      id: 'clean-room',
      getURL: (path: string) => `chrome-extension://clean-room/${path}`,
      onConnect: { addListener: vi.fn((listener: (port: Runtime.Port) => void) => { onConnect = listener; }) },
    },
  };
  const ready = vi.fn(async () => ({ ok: true as const, value: settings }));
  const getContext = vi.fn(async () => context);
  const subtitles = new Subtitles(api as unknown as typeof browser, ready, send, getContext);
  subtitles.install();
  const connect = (port = new FakePort()) => {
    onConnect(port as unknown as Runtime.Port);
    return port;
  };
  return { subtitles, connect, ready, send, getContext, setContext: (value: SubtitlesContext) => { context = value; } };
}

async function waitFor(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true));
}

async function hello(port: FakePort): Promise<SubtitlesContext> {
  await waitFor(() => port.posted.some((message) => message.type === 'hello'));
  return (port.posted.find((message) => message.type === 'hello') as Extract<SubtitlesServerMessage, { type: 'hello' }>).context;
}

describe('subtitle port ownership and validation', () => {
  it('ignores ports with other names without disconnecting their owners', async () => {
    const ctx = fixture();
    const port = ctx.connect(new FakePort('workbench'));
    await Promise.resolve();

    expect(port.disconnected).toBe(false);
    expect(port.posted).toEqual([]);
    expect(ctx.getContext).not.toHaveBeenCalled();
  });

  it('rejects invalid same-name senders and accepts only the exact top-level extension page', async () => {
    const ctx = fixture();
    const invalid = [
      new FakePort(SUBTITLES_PORT_NAME, { id: 'other', frameId: 0, url: 'chrome-extension://clean-room/subtitles.html' }),
      new FakePort(SUBTITLES_PORT_NAME, { id: 'clean-room', frameId: 2, url: 'chrome-extension://clean-room/subtitles.html' }),
      new FakePort(SUBTITLES_PORT_NAME, { id: 'clean-room', frameId: 0, url: 'chrome-extension://clean-room/subtitles.html?extra=1' }),
      new FakePort(SUBTITLES_PORT_NAME, { id: 'clean-room', frameId: 0, url: 'chrome-extension://clean-room/nested/subtitles.html' }),
    ];
    invalid.forEach((port) => ctx.connect(port));
    expect(invalid.every((port) => port.disconnected)).toBe(true);
    expect(ctx.getContext).not.toHaveBeenCalled();

    const port = ctx.connect();
    const context = await hello(port);
    expect(context.settings).toEqual(publicSettings);
    expect(JSON.stringify(port.posted)).not.toContain('private-key');
  });

  it('revalidates the SRT, context, indices and ready authorization before sending', async () => {
    const ctx = fixture();
    const stale = ctx.connect();
    await hello(stale);
    stale.receive({ type: 'start', runId: runId(), contextId: 'stale', source: source(['one']), completedTranslationBytes: 0 });
    await waitFor(() => stale.posted.some((message) => message.type === 'invalidated'));
    expect(ctx.ready).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();

    const invalidSource = ctx.connect();
    await hello(invalidSource);
    invalidSource.receive({ type: 'start', runId: runId(), contextId: 'boot-a:0', source: 'not srt', completedTranslationBytes: 0 });
    await waitFor(() => invalidSource.posted.some((message) => message.type === 'stopped'));
    expect(ctx.ready).not.toHaveBeenCalled();

    const invalidIndices = ctx.connect();
    await hello(invalidIndices);
    invalidIndices.receive({ type: 'start', runId: runId(), contextId: 'boot-a:0', source: source(['one', 'two']), indices: [1, 1], completedTranslationBytes: 0 });
    await waitFor(() => invalidIndices.posted.some((message) => message.type === 'stopped'));
    expect(ctx.send).not.toHaveBeenCalled();
  });
});

describe('subtitle task scheduling', () => {
  it('keeps at most two sends active and returns out-of-order replies by cue index', async () => {
    const pending = new Map<string, (reply: Reply<string>) => void>();
    let active = 0;
    let maximum = 0;
    const send = vi.fn((_settings: TranslationSnapshot, text: string) => new Promise<Reply<string>>((resolve) => {
      active++;
      maximum = Math.max(maximum, active);
      pending.set(text, (reply) => { active--; resolve(reply); });
    }));
    const ctx = fixture(send);
    const port = ctx.connect();
    await hello(port);
    const id = runId();
    port.receive({ type: 'start', runId: id, contextId: 'boot-a:0', source: source(['one', 'two', 'three']), completedTranslationBytes: 0 });
    await waitFor(() => send.mock.calls.length === 2);
    expect(send.mock.calls.map((call) => call[1])).toEqual(['one', 'two']);
    expect(maximum).toBe(2);

    pending.get('two')!({ ok: true, value: '\n二\n\n行\n' });
    await waitFor(() => send.mock.calls.length === 3);
    pending.get('three')!({ ok: true, value: '三' });
    pending.get('one')!({ ok: true, value: '一' });
    await waitFor(() => port.posted.some((message) => message.type === 'done'));

    const cues = port.posted.filter((message): message is Extract<SubtitlesServerMessage, { type: 'cue' }> => message.type === 'cue');
    expect(cues.map((message) => message.index)).toEqual([1, 2, 0]);
    expect(cues[0].reply).toEqual({ ok: true, value: '二\n行' });
    expect(send.mock.calls.every((call) => ['one', 'two', 'three'].includes(call[1]))).toBe(true);
    expect(port.disconnected).toBe(false);

    port.receive({ type: 'start', runId: runId(), contextId: 'boot-a:0', source: source(['again']), completedTranslationBytes: 0 });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('sends only requested unfinished indices and stops new dispatch after a terminal failure', async () => {
    const send = vi.fn(async (_settings: TranslationSnapshot, text: string): Promise<Reply<string>> => text === 'two'
      ? fail('authentication')
      : { ok: true, value: `translated ${text}` });
    const ctx = fixture(send);
    const port = ctx.connect();
    await hello(port);
    port.receive({
      type: 'start',
      runId: runId(),
      contextId: 'boot-a:0',
      source: source(['one', 'two', 'three', 'four']),
      indices: [1, 3],
      completedTranslationBytes: 0,
    });
    await waitFor(() => port.posted.some((message) => message.type === 'stopped'));
    expect(send.mock.calls.map((call) => call[1]).sort()).toEqual(['four', 'two']);
    expect(port.posted).toContainEqual(expect.objectContaining({
      type: 'cue', index: 1, reply: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'authentication' }) }),
    }));
  });

  it('accepts a translation over the source cue limit and continues later cues', async () => {
    const longTranslation = '译'.repeat(2001);
    const send = vi.fn(async (_settings: TranslationSnapshot, text: string): Promise<Reply<string>> => ({
      ok: true,
      value: text === 'one' ? longTranslation : '后续译文',
    }));
    const ctx = fixture(send);
    const port = ctx.connect();
    await hello(port);
    const id = runId();
    port.receive({
      type: 'start', runId: id, contextId: 'boot-a:0', source: source(['one', 'two']), completedTranslationBytes: 0,
    });
    await waitFor(() => port.posted.some((message) => message.type === 'done'));

    const cues = port.posted.filter((message): message is Extract<SubtitlesServerMessage, { type: 'cue' }> => message.type === 'cue');
    expect(cues).toEqual(expect.arrayContaining([
      expect.objectContaining({ index: 0, reply: { ok: true, value: longTranslation } }),
      expect.objectContaining({ index: 1, reply: { ok: true, value: '后续译文' } }),
    ]));
    expect(port.posted).toContainEqual(expect.objectContaining({ type: 'done', completed: 2, failed: 0 }));
  });

  it('counts retained translations against the retry byte budget', async () => {
    const ctx = fixture(vi.fn(async (): Promise<Reply<string>> => ({ ok: true, value: 'xx' })));
    const port = ctx.connect();
    await hello(port);
    const id = runId();
    port.receive({
      type: 'start', runId: id, contextId: 'boot-a:0', source: source(['one', 'two']), indices: [1],
      completedTranslationBytes: SRT_MAX_TRANSLATION_BYTES - 1,
    });
    await waitFor(() => port.posted.some((message) => message.type === 'stopped'));

    expect(port.posted).toContainEqual(expect.objectContaining({
      type: 'cue', index: 1, reply: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'limit' }) }),
    }));
    expect(port.posted).not.toContainEqual(expect.objectContaining({ type: 'done' }));
  });

  it('aborts on cancel or disconnect and ignores late results', async () => {
    let aborted = false;
    let resolveRequest!: (reply: Reply<string>) => void;
    const send = vi.fn((_settings: TranslationSnapshot, _text: string, signal: AbortSignal) => new Promise<Reply<string>>((resolve) => {
      resolveRequest = resolve;
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    }));
    const ctx = fixture(send);
    const port = ctx.connect();
    await hello(port);
    const id = runId();
    port.receive({ type: 'start', runId: id, contextId: 'boot-a:0', source: source(['one']), completedTranslationBytes: 0 });
    await waitFor(() => send.mock.calls.length === 1);
    port.receive({ type: 'cancel', runId: id });
    expect(port.disconnected).toBe(true);
    expect(aborted).toBe(true);
    resolveRequest({ ok: true, value: 'late' });
    await Promise.resolve();
    expect(port.posted.some((message) => message.type === 'cue')).toBe(false);

    const disconnected = ctx.connect();
    await hello(disconnected);
    disconnected.receive({ type: 'start', runId: runId(), contextId: 'boot-a:0', source: source(['two']), completedTranslationBytes: 0 });
    await waitFor(() => send.mock.calls.length === 2);
    disconnected.disconnect();
    expect(aborted).toBe(true);
  });

  it('keeps a completed port alive so later context changes invalidate export proof', async () => {
    const ctx = fixture();
    const port = ctx.connect();
    await hello(port);
    const id = runId();
    port.receive({ type: 'start', runId: id, contextId: 'boot-a:0', source: source(['one']), completedTranslationBytes: 0 });
    await waitFor(() => port.posted.some((message) => message.type === 'done'));
    expect(port.disconnected).toBe(false);

    ctx.setContext({ contextId: 'boot-a:1', settings: { ...publicSettings, model: 'changed' } });
    await ctx.subtitles.contextChanged();
    expect(port.posted.at(-1)).toEqual({ type: 'invalidated', contextId: 'boot-a:1', error: {
      code: 'interrupted', message: expect.any(String),
    } });
    expect(port.disconnected).toBe(false);
  });
});
