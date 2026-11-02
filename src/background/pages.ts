import type browser from '../shared/browser';
import type { Runtime } from 'webextension-polyfill';
import { errorMessages, fail, idleStatus, type ContentCommand, type Failure, type PageStatus, type Reply, type UiRequest } from '../shared/contracts';
import type { StoredSettings } from './settings';
import type { SiteTranslationStart } from './site-rules';

interface Session {
  id: string;
  kind: 'page' | 'hover' | 'video';
  url: string;
  requests: number;
  sequence: number;
  controllers: Set<AbortController>;
  auto?: SiteTranslationStart;
}

type PageRequest = Extract<UiRequest, { type: 'page.command' }>;
type HoverRequest = Extract<UiRequest, { type: 'hover.command' }>;
const INJECTED_TABS = 'injectedTabIds';

export class PageSessions {
  private sessions = new Map<number, Session>();
  private pendingHover = new Map<number, object>();
  private revisions = new Map<number, number>();
  private contentTabs = new Set<number>();
  private registryWrite = Promise.resolve();
  readonly initialized: Promise<void>;

  constructor(private readonly api: typeof browser,
    private readonly suppressAuto: (tabId: number, reason: 'pause' | 'restore') => Promise<void>) {
    this.initialized = this.invalidatePreviousPages();
  }

  private async invalidatePreviousPages(): Promise<void> {
    const stored = await this.api.storage.session.get(INJECTED_TABS);
    const tabIds = (stored[INJECTED_TABS] as number[] | undefined) ?? [];
    await Promise.all(tabIds.map((tabId) => this.api.tabs.sendMessage(tabId, {
      type: 'content.invalidate', error: { code: 'interrupted', message: errorMessages.interrupted },
    } satisfies ContentCommand, { frameId: 0 }).catch(() => undefined)));
    await this.api.storage.session.remove(INJECTED_TABS);
  }

  private persistContentTabs(): Promise<void> {
    this.registryWrite = this.registryWrite.then(() => this.api.storage.session.set({ [INJECTED_TABS]: [...this.contentTabs] }));
    return this.registryWrite;
  }

  async activeTab(tabId: number): Promise<string | undefined> {
    const [tab] = await this.api.tabs.query({ active: true, currentWindow: true });
    return tab?.id === tabId && tab.url && /^https?:\/\//.test(tab.url) ? tab.url : undefined;
  }

  async inject(tabId: number): Promise<void> {
    await this.initialized;
    const revision = this.version(tabId);
    this.revisions.set(tabId, revision);
    await this.api.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
    if (this.revisions.get(tabId) !== revision) return;
    this.contentTabs.add(tabId);
    await this.persistContentTabs();
  }

  async status(tabId: number): Promise<Reply<PageStatus>> {
    try { return await this.api.tabs.sendMessage(tabId, { type: 'content.status' } satisfies ContentCommand, { frameId: 0 }); }
    catch { return { ok: true, value: idleStatus() }; }
  }

  async command(input: PageRequest, loadSettings?: () => Promise<Reply<StoredSettings>>,
    current: () => boolean = () => true, auto?: SiteTranslationStart): Promise<Reply<PageStatus>> {
    if (input.action === 'pause' || input.action === 'restore') await this.suppressAuto(input.tabId, input.action);
    const active = this.sessions.get(input.tabId);
    if (loadSettings || (active?.kind !== 'hover' && ['pause', 'restore'].includes(input.action))) this.stop(input.tabId);
    const revision = this.version(input.tabId);
    const url = await this.activeTab(input.tabId);
    if (!url) return fail('unsupported');
    if (!current() || this.version(input.tabId) !== revision) return fail('interrupted');
    if (!loadSettings) {
      try {
        return await this.api.tabs.sendMessage(input.tabId,
          { type: 'content.command', action: input.action, mode: input.mode } satisfies ContentCommand, { frameId: 0 });
      } catch { return input.action === 'restore' ? { ok: true, value: idleStatus() } : fail('unsupported'); }
    }
    const loaded = await loadSettings();
    if (!loaded.ok) return loaded;
    if (!current() || this.version(input.tabId) !== revision) return fail('interrupted');
    const settings = loaded.value;
    try {
      await this.inject(input.tabId);
      const tab = await this.api.tabs.get(input.tabId);
      if (!current() || this.revisions.get(input.tabId) !== revision || tab.url !== url) return fail('interrupted');
      const session: Session = { id: crypto.randomUUID(), kind: 'page', url, requests: 0, sequence: 0, controllers: new Set(), auto };
      if (auto) auto.signal.addEventListener('abort', () => {
        if (this.sessions.get(input.tabId) === session) this.invalidate(input.tabId,
          { code: 'interrupted', message: errorMessages.interrupted });
      }, { once: true });
      this.sessions.set(input.tabId, session);
      const preferences = { sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage,
        mode: input.mode ?? settings.mode };
      return await this.api.tabs.sendMessage(input.tabId, { type: 'content.command', action: input.action,
        mode: input.mode, grant: { sessionId: session.id, preferences } } satisfies ContentCommand, { frameId: 0 });
    } catch {
      if (this.revisions.get(input.tabId) === revision) this.stop(input.tabId);
      return fail('unsupported');
    }
  }

  async hover(input: HoverRequest, loadSettings: () => Promise<Reply<StoredSettings>>,
    current: () => boolean = () => true): Promise<Reply<PageStatus>> {
    if (!input.enabled) {
      if (this.sessions.get(input.tabId)?.kind === 'hover' || this.pendingHover.has(input.tabId)) this.stop(input.tabId);
      const url = await this.activeTab(input.tabId);
      if (!url) return fail('unsupported');
      try {
        return await this.api.tabs.sendMessage(input.tabId,
          { type: 'hover.command', enabled: false } satisfies ContentCommand, { frameId: 0 });
      } catch { return { ok: true, value: idleStatus() }; }
    }

    this.stop(input.tabId);
    const revision = this.version(input.tabId);
    const pending = {};
    this.pendingHover.set(input.tabId, pending);
    try {
      const url = await this.activeTab(input.tabId);
      if (!url) return fail('unsupported');
      if (!current() || this.version(input.tabId) !== revision) return fail('interrupted');
      const loaded = await loadSettings();
      if (!loaded.ok) return loaded;
      if (!current() || this.version(input.tabId) !== revision) return fail('interrupted');
      try {
        await this.inject(input.tabId);
        const tab = await this.api.tabs.get(input.tabId);
        if (!current() || this.revisions.get(input.tabId) !== revision || tab.url !== url) return fail('interrupted');
        const session: Session = { id: crypto.randomUUID(), kind: 'hover', url, requests: 0, sequence: 0, controllers: new Set() };
        this.sessions.set(input.tabId, session);
        const settings = loaded.value;
        const preferences = { sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage, mode: settings.mode };
        return await this.api.tabs.sendMessage(input.tabId,
          { type: 'hover.command', enabled: true, grant: { sessionId: session.id, preferences } } satisfies ContentCommand,
          { frameId: 0 });
      } catch {
        if (this.revisions.get(input.tabId) === revision) this.stop(input.tabId);
        return fail('unsupported');
      }
    } finally {
      if (this.pendingHover.get(input.tabId) === pending) this.pendingHover.delete(input.tabId);
    }
  }

  async video(input: Extract<UiRequest, { type: 'video.list' | 'video.command' }>,
    loadSettings: () => Promise<Reply<StoredSettings>>, current: () => boolean): Promise<Reply<import('../shared/video').VideoInfo>> {
    if (input.type === 'video.command' && input.action === 'start') this.invalidate(input.tabId,
      { code: 'interrupted', message: errorMessages.interrupted });
    const version = this.version(input.tabId);
    const url = await this.activeTab(input.tabId);
    if (!url) return fail('unsupported');
    try {
      await this.inject(input.tabId);
      let tab = await this.api.tabs.get(input.tabId);
      if (!current() || this.version(input.tabId) !== version || tab.url !== url) return fail('interrupted');
      if (input.type === 'video.list') return { ok: true, value: await this.api.tabs.sendMessage(input.tabId, { type: 'video.inspect' }, { frameId: 0 }) };
      if (input.action !== 'start') {
        const session = this.sessions.get(input.tabId);
        if (session?.kind === 'video') {
          if (input.action === 'stop') this.stop(input.tabId);
          else session.requests = 0;
        } else if (input.action === 'continue') return fail('interrupted');
        return { ok: true, value: await this.api.tabs.sendMessage(input.tabId, { type: 'video.control', action: input.action }, { frameId: 0 }) };
      }
      const settings = await loadSettings();
      if (!settings.ok) return settings;
      tab = await this.api.tabs.get(input.tabId);
      if (!current() || this.version(input.tabId) !== version || tab.url !== url) return fail('interrupted');
      const session: Session = { id: crypto.randomUUID(), kind: 'video', url, requests: 0, sequence: 0, controllers: new Set() };
      this.sessions.set(input.tabId, session);
      const { sourceLanguage, targetLanguage } = settings.value;
      return { ok: true, value: await this.api.tabs.sendMessage(input.tabId, { type: 'video.control', action: 'start',
        choiceId: input.choiceId,
        grant: { sessionId: session.id, preferences: { sourceLanguage, targetLanguage, mode: input.mode } } }, { frameId: 0 }) };
    } catch { return fail('unsupported'); }
  }

  version(tabId: number): number { return this.revisions.get(tabId) ?? 0; }

  authorize(sender: Runtime.MessageSender, id: string, kind: Session['kind']): { tabId: number; session: Session } | undefined {
    const tabId = sender.tab?.id;
    if (sender.id !== this.api.runtime.id || sender.frameId !== 0 || tabId === undefined) return;
    const session = this.sessions.get(tabId);
    // sender.url can retain the document's initial URL after same-document navigation.
    if (!session || session.id !== id || session.kind !== kind || sender.tab?.url !== session.url) return;
    return { tabId, session };
  }

  advance(session: Session, sequence: number): boolean {
    if (session.kind === 'page' || sequence <= session.sequence) return false;
    session.sequence = sequence;
    session.controllers.forEach((controller) => controller.abort());
    return true;
  }

  current(session: Session, sequence: number): boolean {
    return session.kind !== 'page' && session.sequence === sequence;
  }

  valid(tabId: number, session: Session): boolean { return this.sessions.get(tabId) === session; }

  stop(tabId: number): void {
    this.revisions.set(tabId, (this.revisions.get(tabId) ?? 0) + 1);
    this.pendingHover.delete(tabId);
    const session = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    session?.controllers.forEach((controller) => controller.abort());
  }

  invalidate(tabId: number, error: Failure): void {
    const hasContent = this.contentTabs.has(tabId);
    this.stop(tabId);
    if (hasContent) void this.api.tabs.sendMessage(tabId,
      { type: 'content.invalidate', error } satisfies ContentCommand, { frameId: 0 }).catch(() => undefined);
  }

  invalidateAll(error: Failure): void {
    for (const tabId of this.revisions.keys()) this.invalidate(tabId, error);
  }

  async removed(tabId: number): Promise<void> {
    this.stop(tabId);
    this.revisions.delete(tabId);
    this.contentTabs.delete(tabId);
    await this.initialized;
    await this.persistContentTabs();
  }
}
