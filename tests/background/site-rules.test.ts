import { describe, expect, it, vi } from 'vitest';
import {
  SITE_DOCUMENT_REQUEST_LIMIT,
  SiteRuleScheduler,
  applySettingsClearToSiteRules,
  createSiteRule,
  mayReleaseSitePermission,
  reconcileSiteRulesForService,
  siteOriginFromUrl,
  sitePermissionPattern,
  stopAndRemoveSiteRule,
  type SiteRule,
  type SiteRuleSchedulerCallbacks,
  type SiteServiceBinding,
  type SiteTranslationStart,
  type SiteTranslationStop,
} from '../../src/background/site-rules';

const service: SiteServiceBinding = { prefix: 'https://translator.example/v1', model: 'stable-model' };
const otherService: SiteServiceBinding = { prefix: 'https://translator.example/v1', model: 'new-model' };
const rule = (origin = 'https://news.example:8443'): SiteRule => ({
  origin,
  enabled: true,
  targetLanguage: 'zh-CN',
  mode: 'bilingual',
  service,
});

describe('site rule persistence transforms', () => {
  it('keeps rules on exact URL.origin while permissions use protocol and hostname', () => {
    expect(siteOriginFromUrl('https://news.example:8443/article#part')).toBe('https://news.example:8443');
    expect(sitePermissionPattern('https://news.example:8443')).toBe('https://news.example/*');
    expect(sitePermissionPattern('https://news.example:9443')).toBe('https://news.example/*');
    expect(sitePermissionPattern('http://news.example:8080')).toBe('http://news.example/*');
    expect(siteOriginFromUrl('https://m.news.example/article')).toBe('https://m.news.example');
    expect(() => siteOriginFromUrl('file:///private/page.html')).toThrow();
    expect(() => sitePermissionPattern('https://news.example/path')).toThrow(/URL.origin/);
  });

  it('creates an enabled consent record bound to language, mode, receiver, and model', () => {
    expect(createSiteRule({
      tabUrl: 'https://news.example:8443/article',
      targetLanguage: ' zh-CN ',
      mode: 'translation',
      service,
    })).toEqual({
      origin: 'https://news.example:8443',
      enabled: true,
      targetLanguage: 'zh-CN',
      mode: 'translation',
      service,
    });
  });

  it('disables consent on service change and never restores it when the old service returns', () => {
    const changed = reconcileSiteRulesForService([rule()], otherService);
    expect(changed[0].enabled).toBe(false);
    expect(reconcileSiteRulesForService(changed, service)[0].enabled).toBe(false);
  });

  it('implements clear(true) deletion and clear(false) persistent disablement', () => {
    const disabled = applySettingsClearToSiteRules([rule()], false);
    expect(disabled).toHaveLength(1);
    expect(disabled[0].enabled).toBe(false);
    expect(reconcileSiteRulesForService(disabled, service)[0].enabled).toBe(false);
    expect(applySettingsClearToSiteRules([rule()], true)).toEqual([]);
  });

  it('does not release a host permission shared across ports by rules, service, or another feature', () => {
    const origin = 'https://translator.example:8443';
    expect(mayReleaseSitePermission({ origin, remainingRules: [], currentService: service, otherFeatureOrigins: [] })).toBe(false);
    expect(mayReleaseSitePermission({ origin, remainingRules: [], currentService: null, otherFeatureOrigins: ['https://translator.example:9443'] })).toBe(false);
    expect(mayReleaseSitePermission({
      origin,
      remainingRules: [rule('https://translator.example:10443')],
      currentService: null,
      otherFeatureOrigins: [],
    })).toBe(false);
    expect(mayReleaseSitePermission({ origin, remainingRules: [], currentService: null, otherFeatureOrigins: [] })).toBe(true);
    expect(mayReleaseSitePermission({
      origin,
      remainingRules: [rule('http://translator.example:8443')],
      currentService: null,
      otherFeatureOrigins: [],
    })).toBe(true);
  });

  it('stops the origin before deleting and saving its rule', async () => {
    const events: string[] = [];
    const saved: SiteRule[][] = [];
    await stopAndRemoveSiteRule({
      origin: rule().origin,
      stop: async () => { events.push('stop'); },
      store: {
        load: async () => { events.push('load'); return [rule()]; },
        save: async rules => { events.push('save'); saved.push([...rules]); },
      },
    });
    expect(events).toEqual(['stop', 'load', 'save']);
    expect(saved).toEqual([[]]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function schedulerFixture(initialRules: readonly SiteRule[] = [rule('https://news.example')]) {
  let rules = [...initialRules];
  const starts: SiteTranslationStart[] = [];
  const stops: SiteTranslationStop[] = [];
  const callbacks: SiteRuleSchedulerCallbacks = {
    load: vi.fn(async () => rules),
    disableRule: vi.fn(async origin => {
      rules = rules.map(existing => existing.origin === origin ? { ...existing, enabled: false } : existing);
    }),
    authorize: vi.fn(async () => true),
    currentSettings: vi.fn(async () => service),
    start: vi.fn(async request => { starts.push(request); }),
    stop: vi.fn(async request => { stops.push(request); }),
  };
  return {
    scheduler: new SiteRuleScheduler(callbacks),
    callbacks,
    starts,
    stops,
    rules: () => rules,
    replaceRules: (next: readonly SiteRule[]) => { rules = [...next]; },
  };
}

describe('site navigation scheduler', () => {
  it('starts only a visible active tab and starts an inactive document when it later becomes visible', async () => {
    const ctx = schedulerFixture();
    await ctx.scheduler.documentCommitted({ tabId: 1, documentId: 'doc-1', url: 'https://news.example/one' });
    expect(ctx.starts).toEqual([]);
    await ctx.scheduler.visibleTabChanged(1);
    expect(ctx.starts).toHaveLength(1);
    await ctx.scheduler.documentCommitted({ tabId: 2, documentId: 'doc-2', url: 'https://news.example/two' });
    expect(ctx.starts).toHaveLength(1);
    await ctx.scheduler.visibleTabChanged(2);
    expect(ctx.stops.at(-1)).toMatchObject({ tabId: 1, reason: 'hidden' });
    expect(ctx.starts).toHaveLength(2);
  });

  it('does nothing after a background restart until a new document event is received', async () => {
    const ctx = schedulerFixture();
    await ctx.scheduler.visibleTabChanged(7);
    expect(ctx.callbacks.load).not.toHaveBeenCalled();
    expect(ctx.starts).toEqual([]);
  });

  it.each(['pause', 'hidden', 'stop'] as const)(
    'invalidates a pending start synchronously during deferred load on %s',
    async boundary => {
      const ctx = schedulerFixture();
      const load = deferred<readonly SiteRule[]>();
      const loadStarted = deferred<void>();
      vi.mocked(ctx.callbacks.load).mockImplementation(async () => {
        loadStarted.resolve();
        return load.promise;
      });
      await ctx.scheduler.visibleTabChanged(1);
      const navigation = ctx.scheduler.documentCommitted({
        tabId: 1,
        documentId: 'doc-1',
        url: 'https://news.example/page',
      });
      await loadStarted.promise;
      const boundaryWork = boundary === 'pause'
        ? ctx.scheduler.pauseOrRestore(1, 'doc-1', 'pause')
        : boundary === 'hidden'
          ? ctx.scheduler.visibleTabChanged(null)
          : ctx.scheduler.stopOrigin('https://news.example', 'rule-disabled');
      load.resolve([rule('https://news.example')]);
      await Promise.all([navigation, boundaryWork]);
      expect(ctx.starts).toEqual([]);
    },
  );

  it.each(['pause', 'restore', 'rule-disabled', 'rule-removed', 'settings-clear'] as const)(
    'suppresses an immediate SPA navigation when %s overtakes deferred rule loading',
    async reason => {
      const ctx = schedulerFixture();
      const load = deferred<readonly SiteRule[]>();
      const loadStarted = deferred<void>();
      vi.mocked(ctx.callbacks.load).mockImplementation(async () => {
        loadStarted.resolve();
        return load.promise;
      });
      await ctx.scheduler.visibleTabChanged(1);
      const navigation = ctx.scheduler.documentCommitted({
        tabId: 1,
        documentId: 'doc-1',
        url: 'https://news.example/page',
      });
      await loadStarted.promise;
      const suppression = reason === 'settings-clear'
        ? ctx.scheduler.stopAll(reason)
        : reason === 'rule-disabled' || reason === 'rule-removed'
          ? ctx.scheduler.stopOrigin('https://news.example', reason)
          : ctx.scheduler.pauseOrRestore(1, 'doc-1', reason);
      const spa = ctx.scheduler.sameDocumentNavigated({
        tabId: 1,
        documentId: 'doc-1',
        url: 'https://news.example/page#later',
      });
      load.resolve([rule('https://news.example')]);
      await Promise.all([navigation, suppression, spa]);
      expect(ctx.starts).toEqual([]);
    },
  );

  it.each(['pause', 'restore'] as const)(
    'does not start again when an immediate SPA navigation follows %s during an entered start',
    async reason => {
      const ctx = schedulerFixture();
      const startEntered = deferred<void>();
      const releaseStart = deferred<void>();
      vi.mocked(ctx.callbacks.start).mockImplementation(async request => {
        ctx.starts.push(request);
        startEntered.resolve();
        await releaseStart.promise;
      });
      await ctx.scheduler.visibleTabChanged(1);
      const navigation = ctx.scheduler.documentCommitted({
        tabId: 1,
        documentId: 'doc-1',
        url: 'https://news.example/page',
      });
      await startEntered.promise;
      const suppression = ctx.scheduler.pauseOrRestore(1, 'doc-1', reason);
      const spa = ctx.scheduler.sameDocumentNavigated({
        tabId: 1,
        documentId: 'doc-1',
        url: 'https://news.example/page#later',
      });
      releaseStart.resolve();
      await Promise.all([navigation, suppression, spa]);
      expect(ctx.starts).toHaveLength(1);
      expect(ctx.starts[0].signal.aborted).toBe(true);
    },
  );

  it('invalidates deferred authorization for an old document while allowing the replacement document', async () => {
    const ctx = schedulerFixture();
    const authorization = deferred<boolean>();
    const authorizationStarted = deferred<void>();
    vi.mocked(ctx.callbacks.authorize)
      .mockImplementationOnce(async () => {
        authorizationStarted.resolve();
        return authorization.promise;
      })
      .mockResolvedValue(true);
    await ctx.scheduler.visibleTabChanged(1);
    const oldNavigation = ctx.scheduler.documentCommitted({
      tabId: 1,
      documentId: 'doc-old',
      url: 'https://news.example/old',
    });
    await authorizationStarted.promise;
    const newNavigation = ctx.scheduler.documentCommitted({
      tabId: 1,
      documentId: 'doc-new',
      url: 'https://news.example/new',
    });
    authorization.resolve(true);
    await Promise.all([oldNavigation, newNavigation]);
    expect(ctx.starts.map(start => start.documentId)).toEqual(['doc-new']);
  });

  it.each(['pause', 'navigation'] as const)(
    'aborts an entered asynchronous start immediately on %s',
    async boundary => {
      const ctx = schedulerFixture();
      const ready = deferred<void>();
      const startEntered = deferred<SiteTranslationStart>();
      let grants = 0;
      vi.mocked(ctx.callbacks.start)
        .mockImplementationOnce(async request => {
          ctx.starts.push(request);
          startEntered.resolve(request);
          await ready.promise;
          if (!request.signal.aborted) grants += 1;
        })
        .mockImplementation(async request => { ctx.starts.push(request); });
      await ctx.scheduler.visibleTabChanged(1);
      const oldNavigation = ctx.scheduler.documentCommitted({
        tabId: 1,
        documentId: 'doc-old',
        url: 'https://news.example/old',
      });
      const oldStart = await startEntered.promise;
      expect(oldStart.signal.aborted).toBe(false);
      const boundaryWork = boundary === 'pause'
        ? ctx.scheduler.pauseOrRestore(1, 'doc-old', 'pause')
        : ctx.scheduler.documentCommitted({
          tabId: 1,
          documentId: 'doc-new',
          url: 'https://news.example/new',
        });
      expect(oldStart.signal.aborted).toBe(true);
      expect(grants).toBe(0);
      ready.resolve();
      await Promise.all([oldNavigation, boundaryWork]);
      expect(grants).toBe(0);
      expect(ctx.starts.map(start => start.documentId)).toEqual(
        boundary === 'pause' ? ['doc-old'] : ['doc-old', 'doc-new'],
      );
    },
  );

  it('atomically disables only the checked origin without restoring a concurrent deletion', async () => {
    const first = rule('https://news.example');
    const second = rule('https://other.example');
    const ctx = schedulerFixture([first, second]);
    const settings = deferred<SiteServiceBinding>();
    const settingsStarted = deferred<void>();
    vi.mocked(ctx.callbacks.currentSettings).mockImplementation(async () => {
      settingsStarted.resolve();
      return settings.promise;
    });
    await ctx.scheduler.visibleTabChanged(1);
    const navigation = ctx.scheduler.documentCommitted({
      tabId: 1,
      documentId: 'doc-1',
      url: 'https://news.example/page',
    });
    await settingsStarted.promise;
    ctx.replaceRules([first]);
    settings.resolve(otherService);
    await navigation;
    expect(ctx.callbacks.disableRule).toHaveBeenCalledWith('https://news.example');
    expect(ctx.rules()).toEqual([{ ...first, enabled: false }]);
  });

  it('rechecks the host permission and disables the exact-origin rule when authorization is absent', async () => {
    const ctx = schedulerFixture([rule('https://news.example:8443')]);
    vi.mocked(ctx.callbacks.authorize).mockResolvedValue(false);
    await ctx.scheduler.visibleTabChanged(1);
    await ctx.scheduler.documentCommitted({ tabId: 1, documentId: 'doc-1', url: 'https://news.example:8443/page' });
    expect(ctx.callbacks.authorize).toHaveBeenCalledWith('https://news.example:8443', 'https://news.example/*');
    expect(ctx.starts).toEqual([]);
    expect(ctx.rules()[0].enabled).toBe(false);
  });

  it('disables a rule instead of sending when the receiver or model changed', async () => {
    const ctx = schedulerFixture();
    vi.mocked(ctx.callbacks.currentSettings).mockResolvedValue(otherService);
    await ctx.scheduler.visibleTabChanged(1);
    await ctx.scheduler.documentCommitted({ tabId: 1, documentId: 'doc-1', url: 'https://news.example/page' });
    expect(ctx.callbacks.authorize).not.toHaveBeenCalled();
    expect(ctx.starts).toEqual([]);
    expect(ctx.rules()[0].enabled).toBe(false);
  });

  it('cancels before same-document work and preserves the same 100-request budget', async () => {
    const events: string[] = [];
    const ctx = schedulerFixture();
    vi.mocked(ctx.callbacks.start).mockImplementation(async request => {
      events.push(`start:${request.budget.remaining}`);
      ctx.starts.push(request);
    });
    vi.mocked(ctx.callbacks.stop).mockImplementation(async request => {
      events.push(`stop:${request.reason}`);
      ctx.stops.push(request);
    });
    await ctx.scheduler.visibleTabChanged(1);
    await ctx.scheduler.documentCommitted({ tabId: 1, documentId: 'doc-1', url: 'https://news.example/page' });
    expect(ctx.starts[0].budget.take(60)).toBe(true);
    await ctx.scheduler.sameDocumentNavigated({ tabId: 1, documentId: 'doc-1', url: 'https://news.example/page#new' });
    expect(ctx.starts).toHaveLength(2);
    expect(ctx.starts[1].budget).toBe(ctx.starts[0].budget);
    expect(ctx.starts[1].budget.remaining).toBe(40);
    expect(events).toEqual([`start:${SITE_DOCUMENT_REQUEST_LIMIT}`, 'stop:same-document', 'start:40']);
    expect(ctx.starts[1].budget.take(41)).toBe(false);
  });

  it('allocates a fresh budget only for a full document navigation', async () => {
    const ctx = schedulerFixture();
    await ctx.scheduler.visibleTabChanged(1);
    await ctx.scheduler.documentCommitted({ tabId: 1, documentId: 'doc-1', url: 'https://news.example/one' });
    ctx.starts[0].budget.take(100);
    await ctx.scheduler.documentCommitted({ tabId: 1, documentId: 'doc-2', url: 'https://news.example/two' });
    expect(ctx.starts).toHaveLength(2);
    expect(ctx.starts[1].budget).not.toBe(ctx.starts[0].budget);
    expect(ctx.starts[1].budget.remaining).toBe(SITE_DOCUMENT_REQUEST_LIMIT);
  });

  it.each(['pause', 'restore'] as const)('does not restart the same document after %s', async reason => {
    const ctx = schedulerFixture();
    await ctx.scheduler.visibleTabChanged(1);
    await ctx.scheduler.documentCommitted({ tabId: 1, documentId: 'doc-1', url: 'https://news.example/page' });
    await ctx.scheduler.pauseOrRestore(1, 'doc-1', reason);
    await ctx.scheduler.sameDocumentNavigated({ tabId: 1, documentId: 'doc-1', url: 'https://news.example/page#later' });
    await ctx.scheduler.visibleTabChanged(null);
    await ctx.scheduler.visibleTabChanged(1);
    expect(ctx.starts).toHaveLength(1);
    expect(ctx.stops.at(-1)?.reason).toBe(reason);
  });

  it('does not restart a previously processed document merely because the tab becomes visible again', async () => {
    const ctx = schedulerFixture();
    await ctx.scheduler.visibleTabChanged(1);
    await ctx.scheduler.documentCommitted({ tabId: 1, documentId: 'doc-1', url: 'https://news.example/page' });
    await ctx.scheduler.visibleTabChanged(null);
    await ctx.scheduler.visibleTabChanged(1);
    expect(ctx.starts).toHaveLength(1);
    expect(ctx.stops.at(-1)?.reason).toBe('hidden');
  });
});
