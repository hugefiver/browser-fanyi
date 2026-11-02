import type { ContentCommand, ContentRequest, DisplayMode, Failure, Grant, PageStatus, Reply } from '../shared/contracts';
import { errorMessages, fail } from '../shared/contracts';
import { PageText, type Piece, type TextEntry } from './dom';
import { HoverTranslation } from './hover';
import { TranslationReview } from './translation-review';

export type ContentTransport = (request: ContentRequest) => Promise<Reply<string>>;
const requestTimeout = 30_000;
const requestBudget = 100;

export function createContentEngine(document: Document, request: ContentTransport) {
  const window = document.defaultView!;
  let grant: Grant | undefined;
  let mode: DisplayMode = 'bilingual';
  let phase: 'idle' | 'active' | 'paused' | 'interrupted' | 'limit' = 'idle';
  let error: Failure | undefined;
  let generation = 0;
  let sent = 0;
  let inFlight = 0;
  let sessionUrl = window.location.href;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let urlTimer: ReturnType<typeof setInterval> | undefined;
  const localCancels = new Set<() => void>();
  const page = new PageText(document, () => { review.refresh(); scheduleScan(); });
  const review = new TranslationReview(document, {
    getEntries: () => [...page.entries.values()].filter(entry => entry.pieces.every(piece => piece.phase === 'complete'))
      .map(entry => ({ id: entry.id, source: entry.source, serviceTranslation: entry.pieces.map(piece => piece.result).join(''),
        translation: entry.edited ?? entry.pieces.map(piece => piece.result).join(''), edited: entry.edited !== undefined,
        revealed: !!entry.revealed })),
    edit: (id, text) => updateEntry(id, entry => { entry.edited = text === entry.pieces.map(piece => piece.result).join('') ? undefined : text; }),
    reset: id => updateEntry(id, entry => { entry.edited = undefined; }),
    reveal: (id, revealed) => updateEntry(id, entry => { entry.revealed = revealed; }),
    learning: enabled => {
      page.learning = enabled;
      for (const entry of page.entries.values()) {
        if (enabled) entry.revealed = false;
        page.show(entry, mode);
      }
    },
  });
  function updateEntry(id: string, change: (entry: TextEntry) => void): void {
    page.flush();
    const entry = [...page.entries.values()].find(entry => entry.id === id);
    if (!entry) return;
    change(entry);
    page.show(entry, mode);
  }
  const hover = new HoverTranslation(document, request, node => page.eligible(node), failure => {
    phase = 'interrupted';
    error = failure;
    if (urlTimer !== undefined) clearInterval(urlTimer);
    urlTimer = undefined;
  });

  function status(): PageStatus {
    const pieces = [...page.entries.values()].flatMap(entry => entry.pieces);
    const completed = pieces.filter(piece => piece.phase === 'complete').length;
    const failed = pieces.filter(piece => piece.phase === 'failed').length;
    const pending = pieces.length - completed - failed;
    const failure = error ?? pieces.find(piece => piece.error)?.error;
    let state: PageStatus['phase'];
    if (phase !== 'active') state = phase;
    else if (pending > 0) state = 'running';
    else if (failed > 0) state = 'partial';
    else state = pieces.length ? 'complete' : 'empty';
    return { phase: state, mode, total: pieces.length, completed, failed, pending, hoverEnabled: hover.enabled,
      ...(failure ? { error: failure } : {}) };
  }

  function cancel(): void {
    ++generation;
    for (const stop of localCancels) stop();
    localCancels.clear();
    inFlight = 0;
    for (const entry of page.entries.values()) {
      for (const piece of entry.pieces) if (piece.phase === 'running') piece.phase = 'pending';
    }
    if (grant) void request({ type: 'content.cancel', sessionId: grant.sessionId }).catch(() => undefined);
  }

  function end(failure?: Failure): void {
    phase = failure ? 'interrupted' : 'idle';
    error = failure;
    cancel();
    grant = undefined;
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = undefined;
    if (urlTimer !== undefined) clearInterval(urlTimer);
    urlTimer = undefined;
    page.clear();
    review.close();
    page.disconnect();
  }

  function checkUrl(): boolean {
    if ((phase !== 'idle' || hover.enabled) && window.location.href !== sessionUrl) {
      end({ code: 'interrupted', message: '页面地址已改变，请主动重新开始。' });
      hover.stop();
      return false;
    }
    return true;
  }

  function scheduleScan(): void {
    if (phase === 'idle' || phase === 'interrupted' || scanTimer !== undefined) return;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      void scan();
    }, 0);
  }

  async function scan(): Promise<void> {
    if (!checkUrl() || phase === 'idle' || phase === 'interrupted') return;
    await page.scan();
    pump();
  }

  function pump(): void {
    if (!checkUrl() || phase !== 'active' || !grant) return;
    page.flush();
    const pending = [...page.entries.values()].flatMap(entry => entry.pieces.filter(piece => piece.phase === 'pending').map(piece => ({ entry, piece })));
    while (inFlight < 2 && pending.length && sent < requestBudget) {
      const next = pending.shift()!;
      if (page.entries.get(next.entry.node) !== next.entry) continue;
      if (!page.eligible(next.entry.node)) {
        page.remove(next.entry);
        continue;
      }
      next.piece.phase = 'running';
      ++inFlight;
      ++sent;
      void translate(next.entry, next.piece, generation, grant.sessionId);
    }
    if (pending.length && sent >= requestBudget && inFlight === 0) {
      phase = 'limit';
      error = { code: 'limit', message: errorMessages.limit };
    }
  }

  async function translate(entry: TextEntry, piece: Piece, currentGeneration: number, sessionId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: () => void = () => undefined;
    const stopped = new Promise<Reply<string>>(resolve => {
      stop = () => resolve(fail('interrupted'));
      localCancels.add(stop);
      timer = setTimeout(() => resolve(fail('timeout')), requestTimeout);
    });
    let reply: Reply<string>;
    try {
      reply = await Promise.race([request({ type: 'content.translate', sessionId, text: piece.source }), stopped]);
    } catch {
      reply = fail('network');
    } finally {
      clearTimeout(timer);
      localCancels.delete(stop);
    }
    if (currentGeneration !== generation || !checkUrl() || phase !== 'active') return;
    --inFlight;
    page.flush();
    if (!reply.ok && reply.error.code === 'interrupted') {
      phase = 'interrupted';
      error = reply.error;
      cancel();
      return;
    }
    if (page.entries.get(entry.node) === entry && !page.eligible(entry.node)) page.remove(entry);
    if (page.entries.get(entry.node) === entry) {
      if (reply.ok) {
        piece.phase = 'complete';
        piece.result = reply.value;
        page.show(entry, mode);
        review.refresh();
      } else {
        piece.phase = 'failed';
        piece.error = reply.error;
        if (reply.error.code === 'limit') {
          piece.phase = 'pending';
          piece.error = undefined;
          phase = 'limit';
          error = reply.error;
          cancel();
        }
      }
    }
    pump();
  }

  function navigation(): void {
    if (phase !== 'idle' || hover.enabled) {
      end({ code: 'interrupted', message: '页面导航已结束翻译，请主动重新开始。' });
      hover.stop();
    }
  }
  window.addEventListener('pagehide', navigation);
  window.addEventListener('popstate', navigation);
  window.addEventListener('hashchange', navigation);

  function handle(command: Extract<ContentCommand, { type: 'content.selection' }>): Promise<Reply<string>>;
  function handle(command: Exclude<ContentCommand, { type: 'content.selection' }>): Promise<Reply<PageStatus>>;
  function handle(command: ContentCommand): Promise<Reply<PageStatus> | Reply<string>>;
  async function handle(command: ContentCommand): Promise<Reply<PageStatus> | Reply<string>> {
    checkUrl();
    page.flush();
    if (command.type === 'content.selection') {
      const text = window.getSelection()?.toString() ?? '';
      if (!text.trim()) return { ok: false, error: { code: 'unsupported', message: '请先选择要翻译的文字。' } };
      if (Array.from(text).length > 2000) return fail('limit');
      return { ok: true, value: text };
    }
    if (command.type === 'content.invalidate') {
      end(command.error);
      hover.stop();
      return { ok: true, value: status() };
    }
    if (command.type === 'content.status') return { ok: true, value: status() };
    if (command.type === 'hover.command') {
      if (!command.enabled) {
        hover.stop();
        if (!grant) { phase = 'idle'; error = undefined; }
        if (!grant && urlTimer !== undefined) clearInterval(urlTimer);
        if (!grant) urlTimer = undefined;
        return { ok: true, value: status() };
      }
      if (!command.grant) return fail('interrupted');
      end();
      sessionUrl = window.location.href;
      hover.start(command.grant);
      if (urlTimer === undefined) urlTimer = setInterval(checkUrl, 250);
      return { ok: true, value: status() };
    }
    return execute(command);
  }

  async function execute(command: Extract<ContentCommand, { type: 'content.command' }>): Promise<Reply<PageStatus>> {
    if (command.action === 'review') {
      review.open();
    } else if (command.action === 'restore') {
      if (grant || phase !== 'idle') end();
    } else if (command.action === 'mode') {
      if (command.mode) mode = command.mode;
      for (const entry of page.entries.values()) page.show(entry, mode);
    } else if (command.action === 'pause') {
      if (phase === 'active' || phase === 'limit' || (phase === 'interrupted' && grant)) {
        if (phase === 'interrupted') error = undefined;
        phase = 'paused';
        cancel();
      }
    } else {
      if (!command.grant) return fail('interrupted');
      if (command.action === 'start') {
        hover.stop();
        end();
        sessionUrl = window.location.href;
        mode = command.mode ?? command.grant.preferences.mode;
      } else {
        if (phase === 'idle' || !grant || (phase === 'interrupted' && command.action !== 'retry')) return fail('interrupted');
        if (grant.preferences.sourceLanguage !== command.grant.preferences.sourceLanguage || grant.preferences.targetLanguage !== command.grant.preferences.targetLanguage) return fail('interrupted');
        cancel();
      }
      grant = command.grant;
      phase = 'active';
      error = undefined;
      sent = 0;
      if (command.action === 'retry') {
        for (const entry of page.entries.values()) {
          for (const piece of entry.pieces) {
            if (piece.phase === 'failed') {
              piece.phase = 'pending';
              piece.error = undefined;
            }
          }
        }
      }
      page.observe();
      if (urlTimer === undefined) urlTimer = setInterval(checkUrl, 250);
      await scan();
    }
    return { ok: true, value: status() };
  }

  return { handle, status, dispose: () => {
    end();
    hover.stop();
    window.removeEventListener('pagehide', navigation);
    window.removeEventListener('popstate', navigation);
    window.removeEventListener('hashchange', navigation);
  } };
}
