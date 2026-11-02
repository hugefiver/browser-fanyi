import { describe, expect, it, vi } from 'vitest';
import { BackgroundController } from '../../src/background/controller';
import type browser from '../../src/shared/browser';
import { defaultPreferences, fail, idleStatus, type Reply } from '../../src/shared/contracts';
import { content, fixture, pageUrl, tab, ui } from './fixture';

describe('message and grant boundaries', () => {
  it('gives exact extension pages only their own operations', async () => {
    const ctx = await fixture();
    for (const sender of [
      { ...ui('options'), url: 'https://page.example/options.html' },
      { ...ui('options'), url: 'chrome-extension://clean-room/nested/options.html' },
      { ...ui('options'), url: 'chrome-extension://clean-room/options.html?extra=1' },
      { ...ui('options'), id: 'other-extension' }, { ...ui('options'), frameId: 2 }, ui('popup'), content(),
    ]) expect(await ctx.controller.handle({ type: 'service.test' }, sender)).toEqual(fail('permission'));
    expect(await ctx.controller.handle({ type: 'settings.clear', all: true }, ui('popup'))).toEqual(fail('permission'));
    expect(await ctx.controller.handle({ type: 'glossary.list' }, ui('popup'))).toEqual(fail('permission'));
    expect(await ctx.controller.handle({ type: 'glossary.upsert', entry: {
      source: 'private', target: '私有', targetLanguage: 'zh-CN',
    } }, content())).toEqual(fail('permission'));
    expect(await ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'start' }, ui('options'))).toEqual(fail('permission'));
    expect(ctx.translator).not.toHaveBeenCalled();
    const settings = await ctx.controller.handle({ type: 'settings.get' }, ui('popup'));
    expect(JSON.stringify(settings)).not.toContain('private-key');
    expect(settings).toMatchObject({ ok: true, value: { hasKey: true } });
  });

  it('requires a top-level sender, matching tab, URL and active session', async () => {
    const ctx = await fixture();
    const grant = await ctx.start();
    const message = { type: 'content.translate', sessionId: grant.sessionId, text: 'source' };
    for (const sender of [{ ...content(), frameId: 1 }, { ...content(), tab: tab(2) },
      { ...content(), tab: { ...tab(1), url: `${pageUrl}#other` } }, { ...content(), id: 'another-extension' }]) {
      expect(await ctx.controller.handle(message, sender)).toEqual(fail('interrupted'));
    }
    expect(await ctx.controller.handle({ ...message, sessionId: 'stale' }, content())).toEqual(fail('interrupted'));
    expect(await ctx.controller.handle(message, content())).toEqual({ ok: true, value: 'translated' });
    expect(ctx.api.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1, frameIds: [0] }, files: ['content.js'] });
    expect(ctx.translator).toHaveBeenCalledTimes(1);
  });

  it('sends only matching current-language terms and keeps them within the existing request budget', async () => {
    const ctx = await fixture();
    await ctx.controller.handle({ type: 'glossary.import', entries: [
      { source: 'source', target: '来源', targetLanguage: 'zh-CN' },
      { source: 'PRIVATE_UNRELATED', target: '不应发送', targetLanguage: 'zh-CN' },
      { source: 'source', target: 'source-fr', targetLanguage: 'fr' },
    ] }, ui('options'));
    const listed = await ctx.controller.handle({ type: 'glossary.list' }, ui('options'));
    expect(listed).toMatchObject({ ok: true, value: expect.arrayContaining([
      expect.objectContaining({ source: 'PRIVATE_UNRELATED' }),
    ]) });
    const grant = await ctx.start();
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source only' }, content()))
      .toEqual({ ok: true, value: 'translated' });
    expect(ctx.translator).toHaveBeenCalledTimes(1);
    expect(ctx.translator.mock.calls[0][3]).toEqual([{ source: 'source', target: '来源' }]);
    expect(ctx.translator.mock.calls[0][1]).toBe('source only');
  });

  it('accepts a fresh SPA grant with an old sender document URL only when the current tab URL matches', async () => {
    const ctx = await fixture();
    const oldGrant = await ctx.start();
    const nextUrl = 'https://page.example/next';
    const navigate = ctx.onHistoryStateUpdated.mock.calls[0][0] as (details: { tabId: number; frameId: number }) => void;
    navigate({ tabId: 1, frameId: 0 });
    ctx.api.tabs.query.mockResolvedValue([{ id: 1, url: nextUrl }]);
    ctx.api.tabs.get.mockResolvedValue({ id: 1, url: nextUrl });
    const grant = await ctx.start();
    const sender = { ...content(), tab: { ...tab(1), url: nextUrl } };
    expect(sender.url).toBe(pageUrl);
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: oldGrant.sessionId, text: 'old' }, sender))
      .toEqual(fail('interrupted'));
    const message = { type: 'content.translate', sessionId: grant.sessionId, text: 'new' };
    expect(await ctx.controller.handle(message, sender)).toEqual({ ok: true, value: 'translated' });
    expect(await ctx.controller.handle(message, { ...sender, url: nextUrl, tab: tab(1) })).toEqual(fail('interrupted'));
    expect(await ctx.controller.handle(message, { ...sender, tab: { ...tab(1), url: undefined } }))
      .toEqual(fail('interrupted'));
    expect(ctx.translator).toHaveBeenCalledTimes(1);
  });

  it('refuses commands for a non-active tab and returns idle when no receiver exists', async () => {
    const ctx = await fixture();
    expect(await ctx.controller.handle({ type: 'page.command', tabId: 2, action: 'start' }, ui('popup'))).toEqual(fail('unsupported'));
    ctx.sendMessage.mockRejectedValueOnce(new Error('No receiving end'));
    expect(await ctx.controller.handle({ type: 'page.status', tabId: 1 }, ui('popup'))).toEqual({ ok: true, value: idleStatus() });
    expect(ctx.translator).not.toHaveBeenCalled();
  });

  it('has a finite 100-request budget and renews it only through a user command', async () => {
    const ctx = await fixture();
    const grant = await ctx.start();
    const message = { type: 'content.translate', sessionId: grant.sessionId, text: 'source' };
    for (let index = 0; index < 100; index++) expect(await ctx.controller.handle(message, content())).toMatchObject({ ok: true });
    expect(await ctx.controller.handle(message, content())).toEqual(fail('limit'));
    expect(ctx.translator).toHaveBeenCalledTimes(100);
    await ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'resume' }, ui('popup'));
    expect(await ctx.controller.handle({ ...message, sessionId: ctx.grant().sessionId }, content())).toMatchObject({ ok: true });
    expect(await ctx.controller.handle({ type: 'content.cancel', sessionId: grant.sessionId }, content())).toEqual(fail('interrupted'));
    expect(await ctx.controller.handle({ ...message, sessionId: ctx.grant().sessionId }, content())).toMatchObject({ ok: true });
  });

  it('mode changes do not renew the grant or send translations', async () => {
    const ctx = await fixture();
    const grant = await ctx.start();
    await ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'mode', mode: 'translation' }, ui('popup'));
    expect(ctx.grant()).toEqual(grant);
    expect(ctx.translator).not.toHaveBeenCalled();
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source' }, content()))
      .toMatchObject({ ok: true });
  });

  it('pauses immediately, cancels in-flight requests and rejects the stale grant', async () => {
    const ctx = await fixture();
    const grant = await ctx.start();
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    ctx.translator.mockImplementation((_settings, _text, signal) => new Promise<Reply<string>>((resolve) => {
      signal.addEventListener('abort', () => resolve(fail('interrupted')), { once: true });
      began();
    }));
    const request = ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source' }, content());
    await started;
    await ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'pause' }, ui('popup'));
    expect(await request).toEqual(fail('interrupted'));
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source' }, content()))
      .toEqual(fail('interrupted'));
  });

  it('does not create a grant when pause overtakes an awaiting start', async () => {
    const ctx = await fixture();
    let finish!: (tabs: Array<{ id: number; url: string }>) => void;
    ctx.api.tabs.query.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const starting = ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'start' }, ui('popup'));
    await ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'pause' }, ui('popup'));
    finish([{ id: 1, url: pageUrl }]);
    expect(await starting).toEqual(fail('interrupted'));
    expect(ctx.api.scripting.executeScript).not.toHaveBeenCalled();
    expect(ctx.translator).not.toHaveBeenCalled();
  });

  it.each(['onCommitted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated'] as const)(
    '%s ends only the top-level grant and notifies content', async (event) => {
      const ctx = await fixture();
      const grant = await ctx.start();
      const navigate = ctx[event].mock.calls[0][0] as (details: { tabId: number; frameId: number }) => void;
      navigate({ tabId: 1, frameId: 2 });
      const message = { type: 'content.translate', sessionId: grant.sessionId, text: 'source' };
      expect(await ctx.controller.handle(message, content())).toMatchObject({ ok: true });
      navigate({ tabId: 1, frameId: 0 });
      expect(await ctx.controller.handle(message, content())).toEqual(fail('interrupted'));
      expect(ctx.sendMessage).toHaveBeenCalledWith(1, { type: 'content.invalidate', error: expect.objectContaining({ code: 'interrupted' }) }, { frameId: 0 });
    });

  it('permission removal and settings changes invalidate grants', async () => {
    const ctx = await fixture();
    let grant = await ctx.start();
    const removed = ctx.permissionsRemoved.mock.calls[0][0] as () => void;
    removed();
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source' }, content())).toEqual(fail('interrupted'));
    grant = await ctx.start();
    await ctx.controller.handle({ type: 'settings.save', settings: { ...defaultPreferences,
      prefix: 'https://receiver.example/v1', model: 'changed', key: { kind: 'keep' } } }, ui('options'));
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source' }, content())).toEqual(fail('interrupted'));
    grant = await ctx.start();
    await ctx.controller.handle({ type: 'settings.clear', all: true }, ui('options'));
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source' }, content())).toEqual(fail('interrupted'));
    expect(await ctx.controller.handle({ type: 'service.test' }, ui('options'))).toEqual(fail('configuration'));
  });

  it('glossary mutations cancel in-flight translations and invalidate the old grant', async () => {
    const ctx = await fixture();
    const grant = await ctx.start();
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    ctx.translator.mockImplementation((_settings, _text, signal) => new Promise<Reply<string>>((resolve) => {
      signal.addEventListener('abort', () => resolve(fail('interrupted')), { once: true });
      began();
    }));
    const request = ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source' }, content());
    await started;
    expect(await ctx.controller.handle({ type: 'glossary.upsert', entry: {
      source: 'source', target: '术语', targetLanguage: 'zh-CN',
    } }, ui('options'))).toMatchObject({ ok: true, value: [expect.objectContaining({ source: 'source' })] });
    expect(await request).toEqual(fail('interrupted'));
    expect(await ctx.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source' }, content()))
      .toEqual(fail('interrupted'));
  });

  it('returns public settings after save/clear and invalidates paused page results', async () => {
    const ctx = await fixture();
    await ctx.start();
    await ctx.controller.handle({ type: 'page.command', tabId: 1, action: 'pause' }, ui('popup'));
    ctx.sendMessage.mockClear();
    const saved = await ctx.controller.handle({ type: 'settings.save', settings: { ...defaultPreferences,
      prefix: 'https://receiver.example/v1', model: 'updated', key: { kind: 'keep' } } }, ui('options'));
    expect(saved).toMatchObject({ ok: true, value: { prefix: 'https://receiver.example/v1', model: 'updated', hasKey: true } });
    expect(JSON.stringify(saved)).not.toContain('private-key');
    expect(ctx.sendMessage).toHaveBeenCalledWith(1, { type: 'content.invalidate', error: expect.objectContaining({ code: 'interrupted' }) }, { frameId: 0 });
    expect(await ctx.controller.handle({ type: 'settings.clear', all: true }, ui('options')))
      .toMatchObject({ ok: true, value: { prefix: '', model: '', hasKey: false, authorized: false } });
  });

  it('installs independent subtitle and workbench ports and propagates permission and data invalidations', async () => {
    const ctx = await fixture();
    expect(ctx.onConnect).toHaveBeenCalledTimes(2);
    const contextChanged = vi.spyOn(ctx.controller.subtitles, 'contextChanged').mockResolvedValue();
    const workbenchChanged = vi.spyOn(ctx.controller.workbench, 'contextChanged').mockResolvedValue();

    const removed = ctx.permissionsRemoved.mock.calls[0][0] as () => void;
    removed();
    expect(contextChanged).toHaveBeenCalledTimes(1);

    await ctx.controller.handle({ type: 'glossary.upsert', entry: {
      source: 'source', target: '术语', targetLanguage: 'zh-CN',
    } }, ui('options'));
    expect(contextChanged).toHaveBeenCalledTimes(3);
    expect(workbenchChanged).toHaveBeenCalledTimes(3);
  });

  it('loses grants on background restart instead of silently resending', async () => {
    const ctx = await fixture();
    const grant = await ctx.start();
    const restarted = new BackgroundController(ctx.api as unknown as typeof browser, ctx.store, ctx.translator);
    expect(await restarted.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'source' }, content()))
      .toEqual(fail('interrupted'));
    expect(ctx.translator).not.toHaveBeenCalled();
  });

  it('connection testing checks authorization and sends a fixed small string without glossary data', async () => {
    const ctx = await fixture();
    await ctx.store.upsertGlossary({ source: 'Hello.', target: '你好。', targetLanguage: 'zh-CN' });
    ctx.api.permissions.contains.mockResolvedValueOnce(false);
    expect(await ctx.controller.handle({ type: 'service.test' }, ui('options'))).toEqual(fail('permission'));
    expect(ctx.translator).not.toHaveBeenCalled();
    await ctx.controller.handle({ type: 'service.test' }, ui('options'));
    expect(ctx.translator.mock.calls[0][1]).toBe('Hello.');
    expect(ctx.translator.mock.calls[0][3]).toEqual([]);
  });
});
