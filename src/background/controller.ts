import type browser from '../shared/browser';
import type { Runtime } from 'webextension-polyfill';
import { errorMessages, fail, type Failure, type PublicSettings, type Reply, type UiRequest } from '../shared/contracts';
import { endpoint } from '../shared/endpoint';
import { GlossaryError, matchGlossary } from './glossary';
import { allowed, request, uiPage } from './messages';
import { PageSessions } from './pages';
import { RequestPool, translate } from './provider';
import { Selections } from './selections';
import { SettingsStore, type StoredSettings, type TranslationSnapshot } from './settings';

const interrupted: Failure = { code: 'interrupted', message: errorMessages.interrupted };
const permission: Failure = { code: 'permission', message: errorMessages.permission };

export class BackgroundController {
  readonly pages: PageSessions;
  readonly selections: Selections;
  private pool = new RequestPool();
  private controllers = new Set<AbortController>();
  private revision = 0;
  private updating = 0;

  constructor(private readonly api: typeof browser, private readonly store = new SettingsStore(),
    private readonly translator = translate) {
    this.pages = new PageSessions(api);
    this.selections = new Selections(api, () => this.ready(), (settings, text, signal) => this.send(settings, text, signal));
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

  private async send(settings: StoredSettings, text: string, signal: AbortSignal, includeGlossary = true): Promise<Reply<string>> {
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
      return await this.pool.run(controller.signal, () => this.translator(settings, text, controller.signal, matched.value));
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

  invalidate(error: Failure): void {
    this.revision++;
    this.pages.invalidateAll(error);
    this.selections.invalidate();
    this.controllers.forEach((controller) => controller.abort());
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
    authorized.session.requests++;
    const controller = new AbortController();
    authorized.session.controllers.add(controller);
    try { return await this.send(settings.value, text, controller.signal); }
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
      case 'selection.get': return this.selections.get(message.id, sender);
      case 'selection.retry': return this.selections.retry(message.id, sender);
      case 'selection.close': return this.selections.close(message.id, sender);
    }
  }

  install(): void {
    this.api.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => this.handle(message, sender));
    this.api.permissions.onRemoved.addListener(() => this.invalidate(permission));
    const navigate = (details: { tabId: number; frameId: number }) => {
      if (details.frameId === 0) this.pages.invalidate(details.tabId, interrupted);
    };
    this.api.webNavigation.onCommitted.addListener(navigate);
    this.api.webNavigation.onHistoryStateUpdated.addListener(navigate);
    this.api.webNavigation.onReferenceFragmentUpdated.addListener(navigate);
    this.api.tabs.onRemoved.addListener((tabId) => {
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
  }
}
