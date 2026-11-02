import { describe, expect, it } from 'vitest';
import type browser from '../../src/shared/browser';
import { BackgroundController } from '../../src/background/controller';
import { defaultPreferences, fail, type Reply } from '../../src/shared/contracts';
import { content, fixture, ui } from './fixture';

async function enable(ctx: Awaited<ReturnType<typeof fixture>>) {
  const reply = await ctx.controller.handle({ type: 'hover.command', tabId: 1, enabled: true }, ui('popup'));
  expect(reply).toMatchObject({ ok: true });
  return ctx.grant();
}

describe('explicit hover background sessions', () => {
  it('limits hover commands to popup and enforces the grant kind', async () => {
    const ctx = await fixture();
    expect(await ctx.controller.handle({ type: 'hover.command', tabId: 1, enabled: true }, ui('options')))
      .toEqual(fail('permission'));
    const pageGrant = await ctx.start();
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: pageGrant.sessionId, sequence: 1, text: 'wrong' }, content()))
      .toEqual(fail('interrupted'));
    const hoverGrant = await enable(ctx);
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: hoverGrant.sessionId, text: 'wrong' }, content()))
      .toEqual(fail('interrupted'));
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: hoverGrant.sessionId, sequence: 1, text: 'pointed' }, content()))
      .toEqual({ ok: true, value: 'translated' });
    expect(ctx.translator).toHaveBeenCalledTimes(1);
  });

  it('lets a later disable invalidate an enable still awaiting content injection', async () => {
    const ctx = await fixture();
    let finish!: (result: never[]) => void;
    let began!: () => void;
    const injectionBegan = new Promise<void>(resolve => { began = resolve; });
    ctx.api.scripting.executeScript.mockImplementationOnce(() => {
      began();
      return new Promise(resolve => { finish = resolve; });
    });
    const enabling = ctx.controller.handle({ type: 'hover.command', tabId: 1, enabled: true }, ui('popup'));
    await injectionBegan;
    expect(await ctx.controller.handle({ type: 'hover.command', tabId: 1, enabled: false }, ui('popup')))
      .toMatchObject({ ok: true });
    finish([]);
    expect(await enabling).toEqual(fail('interrupted'));
    const commands = ctx.sendMessage.mock.calls.map(([, command]) => command).filter(command => command.type === 'hover.command');
    expect(commands.map(command => command.enabled)).toEqual([false]);
  });

  it('does not stop an existing page session when hover is disabled', async () => {
    const ctx = await fixture();
    const pageGrant = await ctx.start();
    expect(await ctx.controller.handle({ type: 'hover.command', tabId: 1, enabled: false }, ui('popup')))
      .toMatchObject({ ok: true });
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: pageGrant.sessionId, text: 'page text' }, content()))
      .toEqual({ ok: true, value: 'translated' });
  });

  it('advances cancellation sequence, aborts one operation and preserves the grant', async () => {
    const ctx = await fixture();
    const grant = await enable(ctx);
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    ctx.translator.mockImplementation((_settings, _text, signal) => new Promise<Reply<string>>(resolve => {
      signal.addEventListener('abort', () => resolve(fail('interrupted')), { once: true });
      began();
    }));
    const pending = ctx.controller.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence: 1, text: 'first' }, content());
    await started;
    expect(await ctx.controller.handle({ type: 'hover.cancel', sessionId: grant.sessionId, sequence: 2 }, content()))
      .toEqual({ ok: true, value: null });
    expect(await pending).toEqual(fail('interrupted'));
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence: 1, text: 'stale' }, content()))
      .toEqual(fail('interrupted'));
    ctx.translator.mockResolvedValue({ ok: true, value: 'fresh' });
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence: 3, text: 'next' }, content()))
      .toEqual({ ok: true, value: 'fresh' });
  });

  it('keeps the 100-request budget across single-operation cancels and renews only after disable/enable', async () => {
    const ctx = await fixture();
    const grant = await enable(ctx);
    for (let sequence = 1; sequence <= 100; sequence++) {
      expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence, text: 'source' }, content()))
        .toMatchObject({ ok: true });
    }
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence: 101, text: 'over' }, content()))
      .toEqual(fail('limit'));
    expect(await ctx.controller.handle({ type: 'hover.cancel', sessionId: grant.sessionId, sequence: 102 }, content()))
      .toEqual({ ok: true, value: null });
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence: 103, text: 'still over' }, content()))
      .toEqual(fail('limit'));
    await ctx.controller.handle({ type: 'hover.command', tabId: 1, enabled: false }, ui('popup'));
    const renewed = await enable(ctx);
    expect(renewed.sessionId).not.toBe(grant.sessionId);
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: renewed.sessionId, sequence: 1, text: 'renewed' }, content()))
      .toMatchObject({ ok: true });
    expect(ctx.translator).toHaveBeenCalledTimes(101);
  });

  it('invalidates hover grants on whole-page start, settings change and navigation', async () => {
    const ctx = await fixture();
    let grant = await enable(ctx);
    await ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'start' }, ui('popup'));
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence: 1, text: 'old' }, content()))
      .toEqual(fail('interrupted'));
    grant = await enable(ctx);
    await ctx.controller.handle({ type: 'settings.save', settings: { ...defaultPreferences,
      prefix: 'https://receiver.example/v1', model: 'changed', key: { kind: 'keep' } } }, ui('options'));
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence: 1, text: 'old' }, content()))
      .toEqual(fail('interrupted'));
    grant = await enable(ctx);
    const navigate = ctx.onHistoryStateUpdated.mock.calls[0][0] as (details: { tabId: number; frameId: number }) => void;
    navigate({ tabId: 1, frameId: 0 });
    expect(await ctx.controller.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence: 1, text: 'old' }, content()))
      .toEqual(fail('interrupted'));
    grant = await enable(ctx);
    const restarted = new BackgroundController(ctx.api as unknown as typeof browser, ctx.store, ctx.translator);
    expect(await restarted.handle({ type: 'hover.translate', sessionId: grant.sessionId, sequence: 1, text: 'old' }, content()))
      .toEqual(fail('interrupted'));
  });
});
