import type browser from '../shared/browser';
import type { Runtime } from 'webextension-polyfill';
import { errorMessages, fail, type Failure, type PublicSettings, type Reply, type UiRequest } from '../shared/contracts';
import { endpoint } from '../shared/endpoint';
import { GlossaryError, matchGlossary } from './glossary';
import { allowed, request, uiPage } from './messages';
import { PageSessions } from './pages';
import { RequestPool, translate, recognizeImage } from './provider';
import { Capture, decodeCaptureImage, type CaptureSelectionEnvelope, type CapturePageEnvelope } from './capture';
import { parseDataUrl, IMAGE_MAX_PIXELS } from '../shared/images';
import { Selections } from './selections';
import { SettingsStore, type StoredSettings, type TranslationSnapshot } from './settings';
import { Subtitles } from './subtitles';
import { Workbench } from './workbench';
import type { WorkbenchContext, WritingOperation } from '../shared/workbench';
import { SiteRuleScheduler, createSiteRule, deleteSiteRule, mayReleaseSitePermission, sameSiteService,
  setSiteRuleEnabled, siteOriginFromUrl, sitePermissionPattern, upsertSiteRule } from './site-rules';

const interrupted: Failure = { code: 'interrupted', message: errorMessages.interrupted };
const permission: Failure = { code: 'permission', message: errorMessages.permission };

export class BackgroundController {
  readonly pages: PageSessions;
  readonly selections: Selections;
  readonly subtitles: Subtitles;
  readonly workbench: Workbench;
  readonly sites: SiteRuleScheduler;
  private documents = new Map<number, string>();
  private pool = new RequestPool();
  private controllers = new Set<AbortController>();
  private readonly contextBase = crypto.randomUUID();
  private revision = 0;
  private updating = 0;

  constructor(private readonly api: typeof browser, private readonly store = new SettingsStore(),
    private readonly translator = translate) {
    this.pages = new PageSessions(api);
    this.sites = new SiteRuleScheduler({
      load: () => this.store.listSiteRules(),
      disableRule: async (origin) => { await this.store.changeSiteRules(rules => setSiteRuleEnabled(rules, origin, false)); },
      authorize: (_origin, permission) => api.permissions.contains({ origins: [permission] }),
      currentSettings: async () => { const settings = await this.ready(); return settings.ok ? settings.value : null; },
      start: async (request) => {
        const revision = this.revision;
        const current = () => !request.signal.aborted && revision === this.revision && !this.updating;
        if (!current()) return;
        await this.pages.command({ type: 'page.command', tabId: request.tabId, action: 'start', mode: request.mode },
          async () => {
            if (!current()) return fail('interrupted');
            const loaded = await this.ready();
            if (!current()) return fail('interrupted');
            return loaded.ok ? { ok: true, value: { ...loaded.value, targetLanguage: request.targetLanguage } } : loaded;
          }, current, request);
      },
      stop: async ({ tabId }) => this.pages.invalidate(tabId, interrupted),
    });
    this.selections = new Selections(api, () => this.ready(), (settings, text, signal) => this.send(settings, text, signal));
    this.subtitles = new Subtitles(api, () => this.ready(),
      (settings, text, signal) => this.send(settings, text, signal), () => this.context());
    this.workbench = new Workbench(api, this.pages, () => this.ready(),
      (settings, text, signal, operation) => this.send(settings, text, signal, operation === 'translate', operation),
      () => this.context(), (settings, dataUrl, signal) => this.sendImage(settings, dataUrl, signal));
  }

  private async sendImage(settings: TranslationSnapshot, dataUrl: string, signal: AbortSignal): Promise<Reply<string>> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal.aborted) return fail('interrupted');
    signal.addEventListener('abort', cancel, { once: true });
    this.controllers.add(controller);
    try {
      parseDataUrl(dataUrl, true);
      const image = await decodeCaptureImage(dataUrl);
      const valid = image.width * image.height <= IMAGE_MAX_PIXELS;
      image.dispose();
      if (!valid) return fail('limit');
      return await this.pool.run(controller.signal, () => recognizeImage(settings, dataUrl, controller.signal));
    } catch { return fail('invalid-response'); }
    finally { signal.removeEventListener('abort', cancel); this.controllers.delete(controller); }
  }

  private async captureImage(tabId: number): Promise<unknown> {
    const context = await this.context();
    const version = this.pages.version(tabId);
    const capture = new Capture(this.api, {
      select: async () => {
        await this.pages.inject(tabId);
        if (version !== this.pages.version(tabId)) throw new Error('navigation');
        const result = await this.api.tabs.sendMessage(tabId, { type: 'capture.select' }, { frameId: 0 }) as CaptureSelectionEnvelope;
        if (version !== this.pages.version(tabId)) throw new Error('navigation');
        return result;
      },
      inspect: async () => {
        if (version !== this.pages.version(tabId)) throw new Error('navigation');
        const result = await this.api.tabs.sendMessage(tabId, { type: 'capture.inspect' }, { frameId: 0 }) as CapturePageEnvelope;
        if (version !== this.pages.version(tabId)) throw new Error('navigation');
        return result;
      },
      cancel: async () => { await this.api.tabs.sendMessage(tabId, { type: 'capture.cancel' }, { frameId: 0 }); },
    });
    const reply = await capture.capture(tabId);
    if (!reply.ok) return reply;
    if (version !== this.pages.version(tabId)) return fail('interrupted');
    return this.workbench.openImage(reply.value.dataUrl, context.contextId);
  }

  private async ready(): Promise<Reply<TranslationSnapshot>> {
    await this.pages.initialized;
    const revision = this.revision;
    if (this.updating) return fail('interrupted');
    const settings = await this.store.snapshot();
    if (!settings.prefix || !settings.model) return fail('configuration');
    if (!await this.api.permissions.contains({ origins: [endpoint(settings.prefix).permission] })) return fail('permission');
    if (this.updating || revision !== this.revision) return fail('interrupted');
    return { ok: true, value: settings };
  }

  private async send(settings: StoredSettings, text: string, signal: AbortSignal, includeGlossary = true,
    operation: WritingOperation = 'translate'): Promise<Reply<string>> {
    const matched = includeGlossary
      ? matchGlossary((settings as TranslationSnapshot).glossary, text, settings.targetLanguage)
      : { ok: true as const, value: [] };
    if (!matched.ok) return matched;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal.aborted) return fail('interrupted');
    signal.addEventListener('abort', cancel, { once: true });
    this.controllers.add(controller);
    try {
      return await this.pool.run(controller.signal, () => this.translator(settings, text, controller.signal, matched.value, undefined, operation));
    } finally {
      signal.removeEventListener('abort', cancel);
      this.controllers.delete(controller);
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<Reply<T>> {
    this.updating++;
    this.invalidate(interrupted);
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return error instanceof GlossaryError
        ? { ok: false, error: { code: 'glossary', message: error.message } }
        : fail('configuration');
    } finally { this.updating--; this.invalidate(interrupted); }
  }

  private publicSettings(): Promise<PublicSettings> {
    return this.store.publicSettings((origin) => this.api.permissions.contains({ origins: [origin] }));
  }

  private async context(): Promise<WorkbenchContext> {
    for (;;) {
      const revision = this.revision;
      const settings = await this.publicSettings();
      if (revision === this.revision) return { contextId: `${this.contextBase}:${revision}`, settings };
    }
  }

  invalidate(error: Failure): void {
    this.revision++;
    void this.sites.stopAll('settings-clear');
    this.pages.invalidateAll(error);
    this.selections.invalidate();
    this.controllers.forEach((controller) => controller.abort());
    void this.subtitles.contextChanged();
    void this.workbench.contextChanged();
  }

  async handle(message: unknown, sender: Runtime.MessageSender): Promise<unknown> {
    try {
      if (!request(message)) return fail('permission');
      await this.pages.initialized;
      if (message.type === 'content.translate' || message.type === 'content.cancel') {
        const authorized = this.pages.authorize(sender, message.sessionId, 'page');
        if (!authorized) return fail('interrupted');
        if (message.type === 'content.cancel') {
          this.pages.stop(authorized.tabId);
          return { ok: true, value: null };
        }
        return this.translatePage(authorized, message.text);
      }
      if (message.type === 'video.end') {
        const authorized = this.pages.authorize(sender, message.sessionId, 'video');
        if (!authorized) return fail('interrupted');
        this.pages.stop(authorized.tabId);
        return { ok: true, value: null };
      }
      if (message.type === 'video.translate' || message.type === 'video.cancel') {
        const authorized = this.pages.authorize(sender, message.sessionId, 'video');
        if (!authorized || !this.pages.advance(authorized.session, message.sequence)) return fail('interrupted');
        if (message.type === 'video.cancel') return { ok: true, value: null };
        return this.translateHover(authorized, message.text, message.sequence);
      }
      if (message.type === 'hover.translate' || message.type === 'hover.cancel') {
        const authorized = this.pages.authorize(sender, message.sessionId, 'hover');
        if (!authorized || !this.pages.advance(authorized.session, message.sequence)) return fail('interrupted');
        if (message.type === 'hover.cancel') return { ok: true, value: null };
        return this.translateHover(authorized, message.text, message.sequence);
      }
      const page = uiPage(sender, this.api.runtime.getURL(''), this.api.runtime.id);
      if (!page || !allowed(page, message.type)) return fail('permission');
      return await this.ui(message, sender);
    } catch { return fail('configuration'); }
  }

  private async translatePage(authorized: NonNullable<ReturnType<PageSessions['authorize']>>, text: string): Promise<Reply<string>> {
    if (!text.trim() || Array.from(text).length > 2000) return fail('limit');
    const settings = await this.ready();
    if (!settings.ok) return settings;
    if (!this.pages.valid(authorized.tabId, authorized.session)) return fail('interrupted');
    if (authorized.session.requests >= 100) return fail('limit');
    const auto = authorized.session.auto;
    if (auto && (auto.signal.aborted || !sameSiteService(auto.service, settings.value))) return fail('interrupted');
    if (auto && !auto.budget.take()) return fail('limit');
    authorized.session.requests++;
    const controller = new AbortController();
    authorized.session.controllers.add(controller);
    try { return await this.send(auto ? { ...settings.value, targetLanguage: auto.targetLanguage } : settings.value, text, controller.signal); }
    finally { authorized.session.controllers.delete(controller); }
  }

  private async translateHover(authorized: NonNullable<ReturnType<PageSessions['authorize']>>, text: string,
    sequence: number): Promise<Reply<string>> {
    if (!text.trim() || Array.from(text).length > 2000) return fail('limit');
    if (authorized.session.requests >= 100) return fail('limit');
    const settings = await this.ready();
    if (!settings.ok) return settings;
    if (!this.pages.valid(authorized.tabId, authorized.session) || !this.pages.current(authorized.session, sequence)) return fail('interrupted');
    authorized.session.requests++;
    const controller = new AbortController();
    authorized.session.controllers.add(controller);
    try {
      const reply = await this.send(settings.value, text, controller.signal);
      return this.pages.valid(authorized.tabId, authorized.session) && this.pages.current(authorized.session, sequence)
        ? reply : fail('interrupted');
    } finally { authorized.session.controllers.delete(controller); }
  }

  private async ui(message: UiRequest, sender: Runtime.MessageSender): Promise<unknown> {
    switch (message.type) {
      case 'settings.get': return { ok: true, value: await this.publicSettings() };
      case 'settings.save': return this.mutate(async () => {
        await this.store.save(message.settings);
        return this.publicSettings();
      });
      case 'settings.clear': return this.mutate(async () => {
        await this.store.clear(message.all);
        return this.publicSettings();
      });
      case 'sites.list': return { ok: true, value: await this.store.listSiteRules() };
      case 'sites.save': {
        const url = await this.pages.activeTab(message.tabId);
        const settings = await this.ready();
        if (!url || !settings.ok) return fail('permission');
        const rule = createSiteRule({ tabUrl: url, targetLanguage: message.rule.targetLanguage,
          mode: message.rule.mode, service: message.rule.service });
        if (rule.origin !== message.rule.origin || !sameSiteService(rule.service, settings.value)
          || !await this.api.permissions.contains({ origins: [sitePermissionPattern(rule.origin)] })) return fail('permission');
        await this.sites.stopOrigin(rule.origin, 'rule-disabled');
        return { ok: true, value: await this.store.changeSiteRules((rules, current) => {
          if (!sameSiteService(current, rule.service)) throw new Error('configuration');
          return upsertSiteRule(rules, rule);
        }) };
      }
      case 'sites.change': {
        const origin = siteOriginFromUrl(message.origin);
        await this.sites.stopOrigin(origin, message.action === 'remove' ? 'rule-removed' : 'rule-disabled');
        if (message.action === 'enable' && !await this.api.permissions.contains({ origins: [sitePermissionPattern(origin)] })) return fail('permission');
        const rules = await this.store.changeSiteRules((rules, settings) => {
          if (message.action === 'remove') return deleteSiteRule(rules, origin);
          const rule = rules.find(rule => rule.origin === origin);
          if (message.action === 'enable' && (!rule || !settings.prefix || !sameSiteService(rule.service, settings))) throw new Error('configuration');
          return setSiteRuleEnabled(rules, origin, message.action === 'enable');
        });
        if (message.action === 'remove') {
          const settings = await this.store.read();
          if (mayReleaseSitePermission({ origin, remainingRules: rules,
            currentService: settings.prefix ? settings : null, otherFeatureOrigins: [] })) {
            await this.api.permissions.remove({ origins: [sitePermissionPattern(origin)] });
          }
        }
        return { ok: true, value: rules };
      }
      case 'glossary.list': return { ok: true, value: await this.store.listGlossary() };
      case 'glossary.upsert': return this.mutate(() => this.store.upsertGlossary(message.entry));
      case 'glossary.delete': return this.mutate(() => this.store.deleteGlossary(message.id));
      case 'glossary.import': return this.mutate(() => this.store.importGlossary(message.entries));
      case 'service.test': {
        const settings = await this.ready();
        if (!settings.ok) return settings;
        return this.send(settings.value, 'Hello.', new AbortController().signal, false);
      }
      case 'page.status': {
        if (!await this.pages.activeTab(message.tabId)) return fail('unsupported');
        return this.pages.status(message.tabId);
      }
      case 'page.command': {
        const documentId = this.documents.get(message.tabId);
        if (documentId && (message.action === 'pause' || message.action === 'restore')) {
          await this.sites.pauseOrRestore(message.tabId, documentId, message.action);
        }
        if (['pause', 'restore', 'mode'].includes(message.action)) return this.pages.command(message);
        const revision = this.revision;
        return this.pages.command(message, () => this.ready(), () => this.revision === revision && !this.updating);
      }
      case 'hover.command': {
        const revision = this.revision;
        return this.pages.hover(message, () => this.ready(), () => this.revision === revision && !this.updating);
      }
      case 'selection.start': {
        const url = await this.pages.activeTab(message.tabId);
        if (!url) return fail('unsupported');
        const revision = this.revision;
        const pageVersion = this.pages.version(message.tabId);
        const settings = await this.ready();
        if (!settings.ok) return settings;
        try {
          await this.pages.inject(message.tabId);
          const selection: Reply<string> = await this.api.tabs.sendMessage(message.tabId, { type: 'content.selection' }, { frameId: 0 });
          const tab = await this.api.tabs.get(message.tabId);
          if (revision !== this.revision || pageVersion !== this.pages.version(message.tabId) || tab.url !== url) return fail('interrupted');
          return selection.ok ? this.selections.start(selection.value) : selection;
        } catch { return fail('unsupported'); }
      }
      case 'video.list': case 'video.command': {
        const revision = this.revision;
        return this.pages.video(message, () => this.ready(), () => revision === this.revision && !this.updating);
      }
      case 'input.start': return this.workbench.capture(message.tabId);
      case 'capture.start': return this.captureImage(message.tabId);
      case 'selection.get': return this.selections.get(message.id, sender);
      case 'selection.retry': return this.selections.retry(message.id, sender);
      case 'selection.close': return this.selections.close(message.id, sender);
    }
  }

  install(): void {
    this.subtitles.install();
    this.api.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => this.handle(message, sender));
    this.api.permissions.onRemoved.addListener(() => this.invalidate(permission));
    const visible = async () => {
      const [tab] = await this.api.tabs.query({ active: true, lastFocusedWindow: true });
      const window = tab?.windowId === undefined ? undefined : await this.api.windows.get(tab.windowId);
      await this.sites.visibleTabChanged(window?.focused === false ? null : tab?.id ?? null);
    };
    const navigate = (details: { tabId: number; frameId: number; url?: string }, sameDocument: boolean) => {
      if (details.frameId !== 0) return;
      this.pages.invalidate(details.tabId, interrupted);
      const documentId = sameDocument ? this.documents.get(details.tabId) : crypto.randomUUID();
      if (!documentId) return;
      this.documents.set(details.tabId, documentId);
      if (!details.url || !/^https?:\/\//.test(details.url)) {
        void this.sites.tabClosed(details.tabId);
        return;
      }
      // Invalidate a pending start before waiting for browser tab/window state.
      const stopped = sameDocument
        ? this.sites.sameDocumentNavigated({ ...details, documentId, url: details.url })
        : this.sites.documentCommitted({ ...details, documentId, url: details.url });
      void stopped.then(visible).catch(() => undefined);
    };
    this.api.webNavigation.onCommitted.addListener(details => navigate(details, false));
    this.api.webNavigation.onHistoryStateUpdated.addListener(details => navigate(details, true));
    this.api.webNavigation.onReferenceFragmentUpdated.addListener(details => navigate(details, true));
    this.api.tabs.onActivated.addListener(() => { void this.sites.visibleTabChanged(null).then(visible); });
    this.api.windows.onFocusChanged.addListener(() => { void this.sites.visibleTabChanged(null).then(visible); });
    void visible();
    this.api.tabs.onRemoved.addListener((tabId) => {
      this.documents.delete(tabId);
      void this.sites.tabClosed(tabId);
      void this.pages.removed(tabId).catch(() => undefined);
      this.selections.removed(tabId);
    });
    this.api.contextMenus.onClicked.addListener((info) => {
      if (info.menuItemId !== 'translate-selection' || !info.selectionText) return;
      void this.selections.start(info.selectionText, true).then((reply) => {
        if (!reply.ok && ['configuration', 'permission'].includes(reply.error.code)) void this.api.runtime.openOptionsPage();
      }).catch(() => undefined);
    });
    const createMenu = () => {
      void this.api.contextMenus.removeAll().then(() => {
        this.api.contextMenus.create({ id: 'translate-selection', title: '翻译选中文字', contexts: ['selection'] });
      }).catch(() => undefined);
    };
    this.api.runtime.onInstalled.addListener(createMenu);
    this.api.runtime.onStartup.addListener(createMenu);
    this.workbench.install();
  }
}
