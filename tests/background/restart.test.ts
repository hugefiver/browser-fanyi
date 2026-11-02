import { describe, expect, it } from 'vitest';
import type browser from '../../src/shared/browser';
import { BackgroundController } from '../../src/background/controller';
import { defaultPreferences, fail, idleStatus, type PageStatus, type Reply } from '../../src/shared/contracts';
import { content, fixture, ui } from './fixture';

const interruptedStatus = (): PageStatus => ({ ...idleStatus(), phase: 'interrupted' });

describe('background restart page cleanup', () => {
  it.each(['complete', 'paused'] as const)('invalidates a %s page before exposing new settings without resending', async (phase) => {
    const ctx = await fixture();
    let status: PageStatus = { ...idleStatus(), phase };
    ctx.sendMessage.mockImplementation(async (_tabId, command): Promise<Reply<PageStatus>> => {
      if (command.type === 'content.invalidate') status = interruptedStatus();
      return { ok: true, value: status };
    });
    const oldGrant = await ctx.start();
    if (phase === 'paused') await ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'pause' }, ui('popup'));
    expect(await ctx.api.storage.session.get('injectedTabIds')).toEqual({ injectedTabIds: [1] });
    for (const [value] of ctx.api.storage.session.set.mock.calls) expect(value).toEqual({ injectedTabIds: [1] });
    ctx.sendMessage.mockClear();
    const restarted = new BackgroundController(ctx.api as unknown as typeof browser, ctx.store, ctx.translator);
    restarted.install();
    expect(ctx.onMessage).toHaveBeenCalledTimes(2);
    const settings = await restarted.handle({ type: 'settings.save', settings: { ...defaultPreferences, targetLanguage: 'fr',
      prefix: 'https://receiver.example/v1', model: 'test', key: { kind: 'keep' } } }, ui('options'));
    expect(settings).toMatchObject({ ok: true, value: { targetLanguage: 'fr' } });
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.sendMessage).toHaveBeenCalledWith(1, { type: 'content.invalidate', error: expect.objectContaining({ code: 'interrupted' }) }, { frameId: 0 });
    expect(await restarted.handle({ type: 'page.status', tabId: 1 }, ui('popup')))
      .toEqual({ ok: true, value: interruptedStatus() });
    expect(await restarted.handle({ type: 'content.translate', sessionId: oldGrant.sessionId, text: 'old source' }, content()))
      .toEqual(fail('interrupted'));
    expect(ctx.translator).not.toHaveBeenCalled();
    expect(await ctx.api.storage.session.get('injectedTabIds')).toEqual({ injectedTabIds: undefined });
  });

  it('serializes removal after an in-flight registry write without granting the closed tab', async () => {
    const ctx = await fixture();
    const save = ctx.api.storage.session.set.getMockImplementation()!;
    let finishWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    let began!: () => void;
    const writeBegan = new Promise<void>((resolve) => { began = resolve; });
    let removed!: () => void;
    const removalWritten = new Promise<void>((resolve) => { removed = resolve; });
    let first = true;
    ctx.api.storage.session.set.mockImplementation(async (value) => {
      if (first) { first = false; began(); await blockedWrite; }
      await save(value);
      if (Array.isArray(value.injectedTabIds) && value.injectedTabIds.length === 0) removed();
    });
    const starting = ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'start' }, ui('popup'));
    await writeBegan;
    const closed = ctx.onRemoved.mock.calls[0][0] as (tabId: number) => void;
    closed(1);
    finishWrite();
    await removalWritten;
    expect(await starting).toEqual(fail('interrupted'));
    expect(await ctx.api.storage.session.get('injectedTabIds')).toEqual({ injectedTabIds: [] });
    expect(ctx.sendMessage).not.toHaveBeenCalled();
    expect(ctx.translator).not.toHaveBeenCalled();
  });

  it('waits for old invalidation acknowledgement before injecting or granting a new user session', async () => {
    const ctx = await fixture();
    const oldGrant = await ctx.start();
    ctx.api.scripting.executeScript.mockClear();
    ctx.sendMessage.mockClear();
    let finishRead!: (value: Record<string, unknown>) => void;
    ctx.api.storage.session.get.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    let finishInvalidation!: (reply: Reply<PageStatus>) => void;
    const acknowledgement = new Promise<Reply<PageStatus>>((resolve) => { finishInvalidation = resolve; });
    let began!: () => void;
    const invalidationBegan = new Promise<void>((resolve) => { began = resolve; });
    ctx.sendMessage.mockImplementationOnce(async (_tabId, command) => {
      expect(command.type).toBe('content.invalidate');
      began();
      return acknowledgement;
    });
    const restarted = new BackgroundController(ctx.api as unknown as typeof browser, ctx.store, ctx.translator);
    restarted.install();
    const starting = restarted.handle({ type: 'page.command', tabId: 1, action: 'start' }, ui('popup'));
    expect(ctx.onMessage).toHaveBeenCalledTimes(2);
    expect(ctx.api.scripting.executeScript).not.toHaveBeenCalled();
    finishRead({ injectedTabIds: [1] });
    await invalidationBegan;
    expect(ctx.api.scripting.executeScript).not.toHaveBeenCalled();
    finishInvalidation({ ok: true, value: interruptedStatus() });
    expect(await starting).toMatchObject({ ok: true });
    expect(ctx.sendMessage.mock.calls.map(([, command]) => command.type)).toEqual(['content.invalidate', 'content.command']);
    expect(await ctx.api.storage.session.get('injectedTabIds')).toEqual({ injectedTabIds: [1] });
    expect(await restarted.handle({ type: 'content.translate', sessionId: oldGrant.sessionId, text: 'old' }, content()))
      .toEqual(fail('interrupted'));
    expect(await restarted.handle({ type: 'content.translate', sessionId: ctx.grant().sessionId, text: 'new' }, content()))
      .toEqual({ ok: true, value: 'translated' });
  });
});
