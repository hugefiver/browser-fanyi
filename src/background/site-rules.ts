export const SITE_DOCUMENT_REQUEST_LIMIT = 100;

export type SiteTranslationMode = 'bilingual' | 'translation';

export interface SiteServiceBinding {
  prefix: string;
  model: string;
}

export interface SiteRule {
  origin: string;
  enabled: boolean;
  targetLanguage: string;
  mode: SiteTranslationMode;
  service: SiteServiceBinding;
}

export interface SiteRuleCandidate {
  tabUrl: string;
  targetLanguage: string;
  mode: SiteTranslationMode;
  service: SiteServiceBinding;
}

export interface SiteRuleStoreCallbacks {
  load: () => Promise<readonly SiteRule[]>;
  save: (rules: readonly SiteRule[]) => Promise<void>;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function siteOriginFromUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS sites can have automatic translation rules');
  }
  if (parsed.username || parsed.password) throw new Error('Site URLs cannot contain credentials');
  return parsed.origin;
}

export function normalizeSiteOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (siteOriginFromUrl(origin) !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('A site rule origin must be an exact URL.origin value');
  }
  return origin;
}

export function sitePermissionPattern(origin: string): string {
  const parsed = new URL(normalizeSiteOrigin(origin));
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function normalizeServiceBinding(service: SiteServiceBinding): SiteServiceBinding {
  const prefix = required(service.prefix, 'service prefix');
  const parsed = new URL(prefix);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Service prefix must use HTTP or HTTPS');
  }
  return { prefix, model: required(service.model, 'service model') };
}

export function createSiteRule(candidate: SiteRuleCandidate): SiteRule {
  return {
    origin: siteOriginFromUrl(candidate.tabUrl),
    enabled: true,
    targetLanguage: required(candidate.targetLanguage, 'target language'),
    mode: candidate.mode,
    service: normalizeServiceBinding(candidate.service),
  };
}

export function sameSiteService(left: SiteServiceBinding, right: SiteServiceBinding): boolean {
  const normalizedLeft = normalizeServiceBinding(left);
  const normalizedRight = normalizeServiceBinding(right);
  return normalizedLeft.prefix === normalizedRight.prefix && normalizedLeft.model === normalizedRight.model;
}

export function upsertSiteRule(rules: readonly SiteRule[], rule: SiteRule): SiteRule[] {
  normalizeSiteOrigin(rule.origin);
  const next = rules.filter(existing => existing.origin !== rule.origin);
  return [...next, rule];
}

export function setSiteRuleEnabled(rules: readonly SiteRule[], origin: string, enabled: boolean): SiteRule[] {
  const exactOrigin = normalizeSiteOrigin(origin);
  let found = false;
  const next = rules.map(rule => {
    if (rule.origin !== exactOrigin) return rule;
    found = true;
    return { ...rule, enabled };
  });
  if (!found) throw new Error(`No site rule exists for ${exactOrigin}`);
  return next;
}

export function deleteSiteRule(rules: readonly SiteRule[], origin: string): SiteRule[] {
  const exactOrigin = normalizeSiteOrigin(origin);
  return rules.filter(rule => rule.origin !== exactOrigin);
}

export function reconcileSiteRulesForService(
  rules: readonly SiteRule[],
  service: SiteServiceBinding,
): SiteRule[] {
  const normalizedService = normalizeServiceBinding(service);
  return rules.map(rule => sameSiteService(rule.service, normalizedService) ? rule : { ...rule, enabled: false });
}

export function applySettingsClearToSiteRules(rules: readonly SiteRule[], clearAll: boolean): SiteRule[] {
  return clearAll ? [] : rules.map(rule => rule.enabled ? { ...rule, enabled: false } : rule);
}

export function serviceOrigin(service: SiteServiceBinding): string {
  return new URL(normalizeServiceBinding(service).prefix).origin;
}

export function mayReleaseSitePermission(input: {
  origin: string;
  remainingRules: readonly SiteRule[];
  currentService: SiteServiceBinding | null;
  otherFeatureOrigins: readonly string[];
}): boolean {
  const permission = sitePermissionPattern(input.origin);
  if (input.remainingRules.some(rule => sitePermissionPattern(rule.origin) === permission)) return false;
  if (input.currentService && sitePermissionPattern(serviceOrigin(input.currentService)) === permission) return false;
  return !input.otherFeatureOrigins.some(origin => sitePermissionPattern(origin) === permission);
}

export async function stopAndRemoveSiteRule(input: {
  origin: string;
  store: SiteRuleStoreCallbacks;
  stop: (origin: string) => Promise<void>;
}): Promise<SiteRule[]> {
  const origin = normalizeSiteOrigin(input.origin);
  await input.stop(origin);
  const remaining = deleteSiteRule(await input.store.load(), origin);
  await input.store.save(remaining);
  return remaining;
}

export class SiteRequestBudget {
  #remaining = SITE_DOCUMENT_REQUEST_LIMIT;

  get remaining(): number {
    return this.#remaining;
  }

  take(count = 1): boolean {
    if (!Number.isInteger(count) || count < 1) throw new Error('Request count must be a positive integer');
    if (count > this.#remaining) return false;
    this.#remaining -= count;
    return true;
  }
}

export type SiteStopReason =
  | 'navigation'
  | 'same-document'
  | 'hidden'
  | 'pause'
  | 'restore'
  | 'rule-disabled'
  | 'rule-removed'
  | 'settings-clear'
  | 'tab-closed';

export interface SiteDocumentNavigation {
  tabId: number;
  documentId: string;
  url: string;
}

export interface SiteTranslationStart {
  tabId: number;
  documentId: string;
  origin: string;
  targetLanguage: string;
  mode: SiteTranslationMode;
  service: SiteServiceBinding;
  budget: SiteRequestBudget;
  signal: AbortSignal;
}

export interface SiteTranslationStop {
  tabId: number;
  documentId: string;
  reason: SiteStopReason;
}

export interface SiteRuleSchedulerCallbacks {
  load: () => Promise<readonly SiteRule[]>;
  disableRule: (origin: string) => Promise<void>;
  authorize: (origin: string, permission: string) => Promise<boolean>;
  currentSettings: () => Promise<SiteServiceBinding | null>;
  start: (request: SiteTranslationStart) => Promise<void>;
  stop: (request: SiteTranslationStop) => Promise<void>;
}

interface TrackedDocument {
  tabId: number;
  documentId: string;
  url: string;
  origin: string;
  budget: SiteRequestBudget;
  generation: number;
  controller: AbortController | null;
  pending: boolean;
  suppressed: boolean;
  running: boolean;
}

export class SiteRuleScheduler {
  readonly #callbacks: SiteRuleSchedulerCallbacks;
  readonly #documents = new Map<number, TrackedDocument>();
  readonly #tabGenerations = new Map<number, number>();
  #visibleTabId: number | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(callbacks: SiteRuleSchedulerCallbacks) {
    this.#callbacks = callbacks;
  }

  documentCommitted(navigation: SiteDocumentNavigation): Promise<void> {
    const generation = this.#invalidateTab(navigation.tabId);
    return this.#enqueue(async () => {
      if (!this.#isCurrentGeneration(navigation.tabId, generation)) return;
      const previous = this.#documents.get(navigation.tabId);
      if (previous) await this.#stop(previous, 'navigation');
      if (!this.#isCurrentGeneration(navigation.tabId, generation)) return;
      const document: TrackedDocument = {
        ...navigation,
        origin: siteOriginFromUrl(navigation.url),
        budget: new SiteRequestBudget(),
        generation,
        controller: null,
        pending: true,
        suppressed: false,
        running: false,
      };
      this.#documents.set(navigation.tabId, document);
      await this.#startPending(document);
    });
  }

  sameDocumentNavigated(navigation: SiteDocumentNavigation): Promise<void> {
    const generation = this.#invalidateTab(navigation.tabId);
    return this.#enqueue(async () => {
      if (!this.#isCurrentGeneration(navigation.tabId, generation)) return;
      const document = this.#documents.get(navigation.tabId);
      if (!document || document.documentId !== navigation.documentId) return;
      const origin = siteOriginFromUrl(navigation.url);
      if (origin !== document.origin) throw new Error('A same-document navigation cannot change origin');
      await this.#stop(document, 'same-document');
      if (!this.#isTracked(document, generation)) return;
      document.url = navigation.url;
      if (document.suppressed) return;
      document.pending = true;
      await this.#startPending(document);
    });
  }

  visibleTabChanged(tabId: number | null): Promise<void> {
    if (this.#visibleTabId === tabId) return Promise.resolve();
    const previousTabId = this.#visibleTabId;
    this.#visibleTabId = tabId;
    if (previousTabId !== null) this.#invalidateTab(previousTabId);
    const generation = tabId === null ? null : this.#invalidateTab(tabId);
    return this.#enqueue(async () => {
      if (previousTabId !== null && this.#visibleTabId !== previousTabId) {
        const previous = this.#documents.get(previousTabId);
        if (previous) await this.#stop(previous, 'hidden');
      }
      if (tabId === null || generation === null || this.#visibleTabId !== tabId
        || !this.#isCurrentGeneration(tabId, generation)) return;
      const document = this.#documents.get(tabId);
      if (document) await this.#startPending(document);
    });
  }

  pauseOrRestore(tabId: number, documentId: string, reason: 'pause' | 'restore'): Promise<void> {
    const generation = this.#invalidateTab(tabId);
    return this.#enqueue(async () => {
      if (!this.#isCurrentGeneration(tabId, generation)) return;
      const document = this.#documents.get(tabId);
      if (!document || document.documentId !== documentId) return;
      document.suppressed = true;
      document.pending = false;
      await this.#stop(document, reason);
    });
  }

  stopOrigin(origin: string, reason: 'rule-disabled' | 'rule-removed'): Promise<void> {
    const exactOrigin = normalizeSiteOrigin(origin);
    const affected = [...this.#documents.values()]
      .filter(document => document.origin === exactOrigin)
      .map(document => ({ tabId: document.tabId, generation: this.#invalidateTab(document.tabId) }));
    return this.#enqueue(async () => {
      for (const { tabId, generation } of affected) {
        if (!this.#isCurrentGeneration(tabId, generation)) continue;
        const document = this.#documents.get(tabId);
        if (!document || document.origin !== exactOrigin) continue;
        document.suppressed = true;
        document.pending = false;
        await this.#stop(document, reason);
      }
    });
  }

  stopAll(reason: 'settings-clear'): Promise<void> {
    const affected = [...this.#documents.values()]
      .map(document => ({ tabId: document.tabId, generation: this.#invalidateTab(document.tabId) }));
    return this.#enqueue(async () => {
      for (const { tabId, generation } of affected) {
        if (!this.#isCurrentGeneration(tabId, generation)) continue;
        const document = this.#documents.get(tabId);
        if (!document) continue;
        document.suppressed = true;
        document.pending = false;
        await this.#stop(document, reason);
      }
    });
  }

  tabClosed(tabId: number): Promise<void> {
    const generation = this.#invalidateTab(tabId);
    if (this.#visibleTabId === tabId) this.#visibleTabId = null;
    return this.#enqueue(async () => {
      if (!this.#isCurrentGeneration(tabId, generation)) return;
      const document = this.#documents.get(tabId);
      if (!document) return;
      await this.#stop(document, 'tab-closed');
      if (this.#isTracked(document, generation)) this.#documents.delete(tabId);
    });
  }

  #invalidateTab(tabId: number): number {
    const generation = (this.#tabGenerations.get(tabId) ?? 0) + 1;
    this.#tabGenerations.set(tabId, generation);
    const document = this.#documents.get(tabId);
    if (document) {
      document.controller?.abort();
      document.controller = null;
      document.generation = generation;
    }
    return generation;
  }

  #isCurrentGeneration(tabId: number, generation: number): boolean {
    return this.#tabGenerations.get(tabId) === generation;
  }

  #isTracked(document: TrackedDocument, generation: number): boolean {
    return this.#documents.get(document.tabId) === document
      && document.generation === generation
      && this.#isCurrentGeneration(document.tabId, generation);
  }

  #canStart(document: TrackedDocument, generation: number): boolean {
    return this.#isTracked(document, generation)
      && this.#visibleTabId === document.tabId
      && document.pending
      && !document.suppressed
      && !document.running;
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #stop(document: TrackedDocument, reason: SiteStopReason): Promise<void> {
    document.controller?.abort();
    document.controller = null;
    if (!document.running) return;
    document.running = false;
    await this.#callbacks.stop({ tabId: document.tabId, documentId: document.documentId, reason });
  }

  async #startPending(document: TrackedDocument): Promise<void> {
    const generation = document.generation;
    if (!this.#canStart(document, generation)) return;
    const rules = await this.#callbacks.load();
    if (!this.#canStart(document, generation)) return;
    const rule = rules.find(candidate => candidate.origin === document.origin && candidate.enabled);
    if (!rule) {
      document.pending = false;
      return;
    }
    const currentSettings = await this.#callbacks.currentSettings();
    if (!this.#canStart(document, generation)) return;
    if (!currentSettings || !sameSiteService(rule.service, currentSettings)) {
      await this.#callbacks.disableRule(rule.origin);
      if (this.#canStart(document, generation)) document.pending = false;
      return;
    }
    const service = normalizeServiceBinding(currentSettings);
    const authorized = await this.#callbacks.authorize(rule.origin, sitePermissionPattern(rule.origin));
    if (!this.#canStart(document, generation)) return;
    if (!authorized) {
      await this.#callbacks.disableRule(rule.origin);
      if (this.#canStart(document, generation)) document.pending = false;
      return;
    }
    if (!this.#canStart(document, generation)) return;
    const controller = new AbortController();
    document.controller = controller;
    document.pending = false;
    document.running = true;
    try {
      await this.#callbacks.start({
        tabId: document.tabId,
        documentId: document.documentId,
        origin: document.origin,
        targetLanguage: rule.targetLanguage,
        mode: rule.mode,
        service,
        budget: document.budget,
        signal: controller.signal,
      });
    } catch (error) {
      if (!this.#isTracked(document, generation) || controller.signal.aborted) return;
      if (document.controller === controller) document.controller = null;
      document.running = false;
      throw error;
    }
    if (!this.#isTracked(document, generation)) return;
  }
}
