import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from 'webextension-polyfill';
import { fixture, content, pageUrl, ui } from './fixture';
import { fail, type Reply } from '../../src/shared/contracts';
import type { WorkbenchServerMessage } from '../../src/shared/workbench';

function port() {
  let receive!: (message: unknown) => void;
  let close!: () => void;
  const posted: WorkbenchServerMessage[] = [];
  return { name: 'workbench', sender: { id: 'clean-room', frameId: 0, url: 'chrome-extension://clean-room/workbench.html?sidebar=1' },
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: (listener: typeof close) => { close = listener; } },
    postMessage: (message: WorkbenchServerMessage) => posted.push(message),
    disconnect: () => close(), posted, receive: (message: unknown) => receive(message) };
}
async function connected(ctx: Awaited<ReturnType<typeof fixture>>) {
  const connection = port();
  for (const [listener] of ctx.onConnect.mock.calls) (listener as (port: Runtime.Port) => void)(connection as unknown as Runtime.Port);
  await vi.waitFor(() => expect(connection.posted.some(message => message.type === 'hello')).toBe(true));
  const hello = connection.posted.find((message): message is Extract<WorkbenchServerMessage, { type: 'hello' }> => message.type === 'hello')!;
  return { connection, contextId: hello.context.contextId };
}

describe('native sidebar current-page ownership', () => {
  it('reads status locally, starts through the same PageSessions grant, and cancels on owner close', async () => {
    const ctx = await fixture();
    const { connection, contextId } = await connected(ctx);
    connection.receive({ type: 'page.status', id: 'status', contextId });
    await vi.waitFor(() => expect(connection.posted.some(message => message.type === 'page' && message.id === 'status')).toBe(true));
    expect(ctx.translator).not.toHaveBeenCalled();
    connection.receive({ type: 'page.command', id: 'start', contextId, tabId: 1, action: 'start' });
    await vi.waitFor(() => expect(connection.posted.some(message => message.type === 'page' && message.id === 'start')).toBe(true));
    const grant = ctx.grant();
    expect(ctx.api.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1, frameIds: [0] }, files: ['content.js'] });
    let finish!: (reply: Reply<string>) => void;
    ctx.translator.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const translating = ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'page body' }, content());
    await vi.waitFor(() => expect(ctx.translator).toHaveBeenCalledOnce());
    connection.disconnect();
    expect(ctx.translator.mock.calls[0][2].aborted).toBe(true);
    finish(fail('interrupted'));
    await translating;
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'late' }, content())).toEqual(fail('interrupted'));
  });

  it('does not target its own extension tab or a stale selected tab', async () => {
    const ctx = await fixture();
    const { connection, contextId } = await connected(ctx);
    ctx.api.tabs.query.mockResolvedValue([{ id: 22, url: 'chrome-extension://clean-room/workbench.html' }]);
    connection.receive({ type: 'page.command', id: 'self', contextId, tabId: 22, action: 'start' });
    await vi.waitFor(() => expect(connection.posted.some(message => message.type === 'page' && message.id === 'self')).toBe(true));
    ctx.api.tabs.query.mockResolvedValue([{ id: 2, url: pageUrl }]);
    connection.receive({ type: 'page.command', id: 'stale', contextId, tabId: 1, action: 'start' });
    await vi.waitFor(() => expect(connection.posted.some(message => message.type === 'page' && message.id === 'stale')).toBe(true));
    expect(ctx.api.scripting.executeScript).not.toHaveBeenCalled();
    expect(ctx.translator).not.toHaveBeenCalled();
  });

  it('switching active tabs stops owned pages without cancelling a newer popup session', async () => {
    const ctx = await fixture();
    const { connection, contextId } = await connected(ctx);
    connection.receive({ type: 'page.command', id: 'start', contextId, tabId: 1, action: 'start' });
    await vi.waitFor(() => expect(connection.posted.some(message => message.type === 'page' && message.id === 'start')).toBe(true));
    const first = ctx.grant();
    const activate = ctx.api.tabs.onActivated.addListener.mock.calls[0][0] as (info: { tabId: number }) => void;
    activate({ tabId: 2 });
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: first.sessionId, text: 'stale' }, content())).toEqual(fail('interrupted'));
    await ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'start' }, ui('popup'));
    const latest = ctx.grant();
    connection.disconnect();
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: latest.sessionId, text: 'current' }, content())).toEqual({ ok: true, value: 'translated' });
  });
});
