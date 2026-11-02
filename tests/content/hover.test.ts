// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentRequest, Reply } from '../../src/shared/contracts';
import { PageText } from '../../src/content/dom';
import { HoverTranslation, hoverEligible } from '../../src/content/hover';
import { deferred, fixture, grant, success } from './helpers';

const active: HoverTranslation[] = [];

function hoverFixture(html: string, transport?: (request: Extract<ContentRequest, { type: 'hover.translate' | 'hover.cancel' }>) => Promise<Reply<string>>) {
  document.body.innerHTML = html;
  const page = new PageText(document, () => undefined);
  const send = vi.fn(transport ?? (async request => request.type === 'hover.translate' ? success(`译:${request.text}`) : success('')));
  const interrupted = vi.fn();
  const hover = new HoverTranslation(document, send, node => page.eligible(node), interrupted);
  active.push(hover);
  hover.start(grant());
  return { hover, send, interrupted };
}

afterEach(() => {
  for (const hover of active.splice(0)) hover.stop();
  document.body.replaceChildren();
});

describe('explicit hover content behavior', () => {
  it('adds interaction exclusions only to hover targets', () => {
    const { hover } = hoverFixture('<a>Link</a><button>Button</button><p>Plain</p><div role="button">Role</div>');
    const ordinary = (node: Text) => node.isConnected;
    expect(hoverEligible(document.querySelector('a')!.firstChild as Text, ordinary)).toBe(false);
    expect(hoverEligible(document.querySelector('button')!.firstChild as Text, ordinary)).toBe(false);
    expect(hoverEligible(document.querySelector('[role=button]')!.firstChild as Text, ordinary)).toBe(false);
    const plain = document.querySelector('p')!.firstChild as Text;
    expect(hoverEligible(plain, ordinary)).toBe(true);
    document.body.onclick = () => undefined;
    expect(hoverEligible(plain, ordinary)).toBe(true);
    document.body.onclick = null;
    hover.stop();
  });

  it('sends exactly one pointed Text node and renders service markup as text', async () => {
    const { hover, send } = hoverFixture('<p>Exact node</p><p>Surrounding text</p>', async request =>
      request.type === 'hover.translate' ? success('<img src=x onerror=alert(1)>') : success(''));
    await hover.translateTarget(document.querySelector('p')!.firstChild as Text, 20, 20);
    expect(send).toHaveBeenCalledWith({ type: 'hover.translate', sessionId: 'session', sequence: 1, text: 'Exact node' });
    const overlay = document.querySelector('[data-browser-fanyi="hover"]')!;
    expect(overlay.textContent).toContain('Exact node');
    expect(overlay.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(overlay.querySelector('img')).toBeNull();
  });

  it('cancels a changed node, advances sequence and ignores the late result', async () => {
    const late = deferred<Reply<string>>();
    const { hover, send } = hoverFixture('<p>Original</p>', request =>
      request.type === 'hover.translate' && request.sequence === 1 ? late.promise : Promise.resolve(success('fresh')));
    const node = document.querySelector('p')!.firstChild as Text;
    const translating = hover.translateTarget(node, 20, 20);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'hover.translate', sequence: 1 })));
    node.data = 'Changed';
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'hover.cancel', sessionId: 'session', sequence: 2 }));
    late.resolve(success('stale'));
    await translating;
    expect(document.querySelector('[data-browser-fanyi="hover"]')).toBeNull();
    await hover.translateTarget(node, 20, 20);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'hover.translate', sequence: 3, text: 'Changed' }));
  });

  it('Esc cancels only the current operation and keeps the same grant usable', async () => {
    const late = deferred<Reply<string>>();
    const { hover, send } = hoverFixture('<p>First</p><p>Second</p>', request =>
      request.type === 'hover.translate' && request.text === 'First' ? late.promise : Promise.resolve(success('second result')));
    const translating = hover.translateTarget(document.querySelectorAll('p')[0]!.firstChild as Text, 20, 20);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'hover.cancel', sessionId: 'session', sequence: 2 }));
    await hover.translateTarget(document.querySelectorAll('p')[1]!.firstChild as Text, 20, 20);
    expect(send).toHaveBeenCalledWith({ type: 'hover.translate', sessionId: 'session', sequence: 3, text: 'Second' });
    late.resolve(success('late'));
    await translating;
    expect(document.querySelector('[data-browser-fanyi="hover"]')!.textContent).toContain('second result');
  });

  it('cancels prior backend work when an over-2000-codepoint target keeps local selection guidance', async () => {
    const late = deferred<Reply<string>>();
    const source = '😀'.repeat(2001);
    const { hover, send } = hoverFixture('<p id="short">Pending</p><p id="long"></p>', request =>
      request.type === 'hover.translate' ? late.promise : Promise.resolve(success('')));
    const pending = hover.translateTarget(document.querySelector('#short')!.firstChild as Text, 20, 20);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'hover.translate', sequence: 1 })));
    const node = document.querySelector('#long')!.appendChild(document.createTextNode(source));
    await hover.translateTarget(node, 20, 20);
    expect(send).toHaveBeenCalledWith({ type: 'hover.cancel', sessionId: 'session', sequence: 2 });
    expect(document.querySelector('[data-browser-fanyi="hover"]')!.textContent).toContain('请使用选区翻译');
    late.resolve(success('stale'));
    await pending;
    expect(document.querySelector('[data-browser-fanyi="hover"]')!.textContent).not.toContain('stale');
  });

  it('rejects a response immediately after pushState without waiting for status polling', async () => {
    const late = deferred<Reply<string>>();
    const { hover, send } = hoverFixture('<p>Old route</p>', request =>
      request.type === 'hover.translate' ? late.promise : Promise.resolve(success('')));
    const previous = window.location.href;
    const translating = hover.translateTarget(document.querySelector('p')!.firstChild as Text, 20, 20);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'hover.translate', sequence: 1 })));
    window.history.replaceState(null, '', '#response-race');
    late.resolve(success('stale route result'));
    await translating;
    expect(send).toHaveBeenCalledWith({ type: 'hover.cancel', sessionId: 'session', sequence: 2 });
    expect(document.querySelector('[data-browser-fanyi="hover"]')).toBeNull();
    window.history.replaceState(null, '', previous);
  });

  it('invalidates hover state on navigation and background configuration invalidation', async () => {
    const { engine } = fixture('<p>Route text</p>');
    await engine.handle({ type: 'hover.command', enabled: true, grant: grant('hover-route') });
    const previous = window.location.href;
    window.history.replaceState(null, '', '#hover-next');
    expect(await engine.handle({ type: 'content.status' })).toMatchObject({
      ok: true, value: { phase: 'interrupted', hoverEnabled: false },
    });
    window.history.replaceState(null, '', previous);
    await engine.handle({ type: 'hover.command', enabled: true, grant: grant('hover-config') });
    expect(await engine.handle({ type: 'content.invalidate', error: { code: 'configuration', message: 'changed' } }))
      .toMatchObject({ ok: true, value: { phase: 'interrupted', hoverEnabled: false } });
  });

  it('restores whole-page output when enabled and disables hover before a new page session', async () => {
    const { engine, send, start } = fixture('<a>Link</a><button>Button</button>');
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(2));
    expect(send.mock.calls.map(call => call[0])).toEqual(['Link', 'Button']);
    await engine.handle({ type: 'hover.command', enabled: true, grant: grant('hover') });
    expect(engine.status()).toMatchObject({ phase: 'idle', hoverEnabled: true });
    expect(document.querySelector('[data-browser-fanyi="translation"]')).toBeNull();
    await engine.handle({ type: 'content.command', action: 'start', grant: grant('page') });
    expect(engine.status().hoverEnabled).toBe(false);
    await vi.waitFor(() => expect(engine.status().completed).toBe(2));
  });
});
