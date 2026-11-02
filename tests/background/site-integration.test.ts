import { describe, expect, it, vi } from 'vitest';
import { content, fixture, pageUrl, ui } from './fixture';
import { createSiteRule } from '../../src/background/site-rules';

const candidate = () => createSiteRule({ tabUrl: pageUrl, targetLanguage: 'fr', mode: 'bilingual',
  service: { prefix: 'https://receiver.example/v1', model: 'test' } });

describe('integrated automatic site translation', () => {
  it('saves without sending; navigations start with local target language and shared SPA budget', async () => {
    const f = await fixture();
    expect(await f.controller.handle({ type: 'sites.save', tabId: 1, rule: candidate() }, ui('popup'))).toMatchObject({ ok: true });
    expect(f.translator).not.toHaveBeenCalled();
    await f.controller.sites.visibleTabChanged(1);
    await f.controller.sites.documentCommitted({ tabId: 1, documentId: 'doc', url: pageUrl });
    let grant = f.grant();
    expect(grant.preferences.targetLanguage).toBe('fr');
    for (let index = 0; index < 100; index++) {
      expect(await f.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'Hello' }, content())).toMatchObject({ ok: true });
    }
    expect(f.translator.mock.calls[0][0].targetLanguage).toBe('fr');
    expect((await f.store.read()).targetLanguage).toBe('zh-CN');
    await f.controller.sites.sameDocumentNavigated({ tabId: 1, documentId: 'doc', url: pageUrl });
    grant = f.grant();
    expect(await f.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'Hello' }, content()))
      .toMatchObject({ ok: false, error: { code: 'limit' } });
  });

  it('orders automatic suppression before the manual pause command', async () => {
    const f = await fixture();
    await f.store.changeSiteRules(() => [candidate()]);
    f.onCommitted.mock.calls[0][0]({ tabId: 1, frameId: 0, url: pageUrl });
    await vi.waitFor(() => expect(f.grant().preferences.targetLanguage).toBe('fr'));
    expect(await f.controller.handle({ type: 'page.command', tabId: 1, action: 'pause' }, ui('popup'))).toMatchObject({ ok: true });
  });

  it('rejects forged origin and service binding and ordinary content management', async () => {
    const f = await fixture();
    for (const rule of [{ ...candidate(), origin: 'https://other.example' }, { ...candidate(), service: { prefix: 'https://evil.example', model: 'test' } }]) {
      expect(await f.controller.handle({ type: 'sites.save', tabId: 1, rule }, ui('popup'))).toMatchObject({ ok: false });
    }
    expect(await f.controller.handle({ type: 'sites.save', tabId: 1, rule: candidate() }, content())).toMatchObject({ ok: false });
    expect(await f.store.listSiteRules()).toEqual([]);
  });

  it('clear service disables consent atomically and saving the same service cannot revive it', async () => {
    const f = await fixture();
    const settings = await f.store.read();
    await f.controller.handle({ type: 'sites.save', tabId: 1, rule: candidate() }, ui('popup'));
    await f.controller.handle({ type: 'settings.clear', all: false }, ui('options'));
    await f.store.save({ ...settings, key: { kind: 'keep' } });
    expect(await f.store.listSiteRules()).toMatchObject([{ enabled: false }]);
    await f.store.clear(true);
    expect(await f.store.listSiteRules()).toEqual([]);
  });

  it('service changes disable rules and concurrent origin edits preserve other rules', async () => {
    const f = await fixture();
    await f.store.changeSiteRules(() => [candidate(), { ...candidate(), origin: 'https://other.example' }]);
    await Promise.all([
      f.store.changeSiteRules(rules => rules.map(rule => rule.origin === candidate().origin ? { ...rule, enabled: false } : rule)),
      f.store.changeSiteRules(rules => [...rules, { ...candidate(), origin: 'https://third.example' }]),
    ]);
    expect(await f.store.listSiteRules()).toHaveLength(3);
    const settings = await f.store.read();
    await f.store.save({ ...settings, model: 'changed', key: { kind: 'keep' } });
    expect((await f.store.listSiteRules()).every(rule => !rule.enabled)).toBe(true);
  });

  it('invalidates an automatic grant immediately when paused or hidden', async () => {
    const f = await fixture();
    await f.store.changeSiteRules(() => [candidate()]);
    await f.controller.sites.visibleTabChanged(1);
    await f.controller.sites.documentCommitted({ tabId: 1, documentId: 'doc', url: pageUrl });
    const grant = f.grant();
    const hidden = f.controller.sites.visibleTabChanged(null);
    expect(await f.controller.handle({ type: 'content.translate', sessionId: grant.sessionId, text: 'Hello' }, content())).toMatchObject({ ok: false });
    await hidden;
    expect(f.translator).not.toHaveBeenCalled();
  });
});
