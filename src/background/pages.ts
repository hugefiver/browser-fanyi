import type browser from '../shared/browser';
import type { Runtime } from 'webextension-polyfill';
import { errorMessages, fail, idleStatus, type ContentCommand, type Failure, type PageStatus, type Reply, type UiRequest } from '../shared/contracts';
import type { StoredSettings } from './settings';

interface Session {
  id: string;
  url: string;
  requests: number;
  controllers: Set<AbortController>;
}

type PageRequest = Extract<UiRequest, { type: 'page.command' }>;
const INJECTED_TABS = 'injectedTabIds';

export class PageSessions {
  private sessions = new Map<number, Session>();
  private revisions = new Map<number, number>();
  private contentTabs = new Set<number>();
  private registryWrite = Promise.resolve();
  readonly initialized: Promise<void>;

  constructor(private readonly api: typeof browser) {
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
    current: () => boolean = () => true): Promise<Reply<PageStatus>> {
    if (loadSettings || ['pause', 'restore'].includes(input.action)) this.stop(input.tabId);
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
      const session: Session = { id: crypto.randomUUID(), url, requests: 0, controllers: new Set() };
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

  version(tabId: number): number { return this.revisions.get(tabId) ?? 0; }

  authorize(sender: Runtime.MessageSender, id: string): { tabId: number; session: Session } | undefined {
    const tabId = sender.tab?.id;
    if (sender.id !== this.api.runtime.id || sender.frameId !== 0 || tabId === undefined) return;
    const session = this.sessions.get(tabId);
    // sender.url can retain the document's initial URL after same-document navigation.
    if (!session || session.id !== id || sender.tab?.url !== session.url) return;
    return { tabId, session };
  }

  valid(tabId: number, session: Session): boolean { return this.sessions.get(tabId) === session; }

  stop(tabId: number): void {
    this.revisions.set(tabId, (this.revisions.get(tabId) ?? 0) + 1);
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
