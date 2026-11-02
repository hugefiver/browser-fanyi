import { describe, expect, it } from 'vitest';
import { fail, type Reply, type SelectionState } from '../../src/shared/contracts';
import { fixture, tab, ui } from './fixture';

function selectionSender(id: string, tabId = 22) {
  return { id: 'clean-room', frameId: 0, tab: tab(tabId), url: `chrome-extension://clean-room/selection.html?id=${id}` };
}

describe('selection task isolation', () => {
  it('obtains only the selected text and creates a local random task page', async () => {
    const ctx = await fixture();
    const result = await ctx.controller.handle({ type: 'selection.start', tabId: 1 }, ui('popup')) as Reply<SelectionState>;
    if (!result.ok) throw new Error('selection failed');
    const id = result.value.id;
    expect(id).toMatch(/^[\da-f-]{36}$/);
    expect(ctx.api.tabs.create).toHaveBeenCalledWith({ url: `chrome-extension://clean-room/selection.html?id=${id}` });
    expect(ctx.translator.mock.calls[0][1]).toBe('Only selected text');
    const state = await ctx.controller.handle({ type: 'selection.get', id }, selectionSender(id));
    expect(state).toMatchObject({ ok: true, value: { source: 'Only selected text' } });
    expect(await ctx.controller.handle({ type: 'selection.get', id },
      { ...ui('selection'), url: `chrome-extension://clean-room/selection.html?id=${id}` }))
      .toMatchObject({ ok: true, value: { id } });
    expect(JSON.stringify(state)).not.toContain('private-key');
    expect(JSON.stringify(state)).not.toContain('page.example');
  });

  it('restricts get, retry and close to the exact owning result tab and query', async () => {
    const ctx = await fixture();
    const result = await ctx.controller.handle({ type: 'selection.start', tabId: 1 }, ui('popup')) as Reply<SelectionState>;
    if (!result.ok) throw new Error('selection failed');
    const id = result.value.id;
    for (const type of ['selection.get', 'selection.retry', 'selection.close']) {
      expect(await ctx.controller.handle({ type, id }, selectionSender(id, 23))).toEqual(fail('interrupted'));
      expect(await ctx.controller.handle({ type, id }, selectionSender('another-id'))).toEqual(fail('interrupted'));
      expect(await ctx.controller.handle({ type, id }, { ...selectionSender(id),
        url: `chrome-extension://clean-room/selection.html?id=${id}&extra=1` })).toEqual(fail('interrupted'));
      expect(await ctx.controller.handle({ type, id }, ui('popup'))).toEqual(fail('permission'));
    }
    expect(await ctx.controller.handle({ type: 'selection.close', id }, selectionSender(id))).toEqual({ ok: true, value: null });
    expect(ctx.api.tabs.remove).toHaveBeenCalledWith(22);
    expect(await ctx.controller.handle({ type: 'selection.get', id }, selectionSender(id))).toEqual(fail('interrupted'));
  });

  it('rejects empty and over-2000-codepoint selection without sending', async () => {
    const ctx = await fixture();
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, value: '' });
    expect(await ctx.controller.handle({ type: 'selection.start', tabId: 1 }, ui('popup'))).toEqual(fail('unsupported'));
    ctx.sendMessage.mockResolvedValueOnce({ ok: true, value: '😀'.repeat(2001) });
    expect(await ctx.controller.handle({ type: 'selection.start', tabId: 1 }, ui('popup'))).toEqual(fail('limit'));
    expect(ctx.translator).not.toHaveBeenCalled();
    expect(ctx.api.tabs.create).not.toHaveBeenCalled();
  });

  it('cancels selection requests on result-tab removal and forgets the task', async () => {
    const ctx = await fixture();
    let aborted = false;
    ctx.translator.mockImplementation((_settings, _text, signal) => new Promise<Reply<string>>((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve(fail('interrupted')); }, { once: true });
    }));
    const result = await ctx.controller.handle({ type: 'selection.start', tabId: 1 }, ui('popup')) as Reply<SelectionState>;
    if (!result.ok) throw new Error('selection failed');
    const removed = ctx.onRemoved.mock.calls[0][0] as (id: number) => void;
    removed(22);
    expect(aborted).toBe(true);
    expect(await ctx.controller.handle({ type: 'selection.get', id: result.value.id }, selectionSender(result.value.id)))
      .toEqual(fail('interrupted'));
  });

  it('menu selections need configuration and authorization before any send', async () => {
    const ctx = await fixture();
    const clicked = ctx.menuClicked.mock.calls[0][0] as (info: { menuItemId: string; selectionText: string }) => void;
    ctx.api.permissions.contains.mockResolvedValue(false);
    const opened = new Promise<void>((resolve) => ctx.api.runtime.openOptionsPage.mockImplementationOnce(async () => resolve()));
    clicked({ menuItemId: 'translate-selection', selectionText: 'selected only' });
    await opened;
    expect(ctx.translator).not.toHaveBeenCalled();
    expect(ctx.api.tabs.create).not.toHaveBeenCalled();
    expect(ctx.api.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('shows menu over-limit refusal locally without truncating or sending', async () => {
    const ctx = await fixture();
    const result = await ctx.controller.selections.start('x'.repeat(2001), true);
    if (!result.ok) throw new Error('Expected local refusal page');
    expect(result.value).toMatchObject({ phase: 'failed', error: { code: 'limit' } });
    expect(result.value.source).toHaveLength(2001);
    expect(ctx.translator).not.toHaveBeenCalled();
    expect(ctx.api.tabs.create).toHaveBeenCalledTimes(1);
  });
});
