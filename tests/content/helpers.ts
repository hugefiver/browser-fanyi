import { afterEach, vi } from 'vitest';
import type { ContentRequest, Grant, Reply } from '../../src/shared/contracts';
import { createContentEngine } from '../../src/content/engine';

const engines: ReturnType<typeof createContentEngine>[] = [];
export const grant = (id = 'session'): Grant => ({ sessionId: id, preferences: { sourceLanguage: 'auto', targetLanguage: 'zh-CN', mode: 'bilingual' } });
export const success = (text: string): Reply<string> => ({ ok: true, value: text });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
export function fixture(html: string, translate: (text: string) => Promise<Reply<string>> = async text => success(`译:${text}`)) {
  document.body.innerHTML = html;
  const send = vi.fn(translate);
  const cancel = vi.fn();
  const engine = createContentEngine(document, (request: ContentRequest) => {
    if (request.type === 'content.translate') return send(request.text);
    cancel(request.sessionId);
    return Promise.resolve(success(''));
  });
  engines.push(engine);
  return { engine, send, cancel, start: () => engine.handle({ type: 'content.command', action: 'start', grant: grant() }) };
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  document.body.replaceChildren();
  document.designMode = 'off';
  vi.useRealTimers();
});
