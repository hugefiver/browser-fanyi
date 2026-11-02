// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fixture } from './helpers';

describe('content text relocation', () => {
  it('keeps the cached bilingual span with a moved Text and restores only owned DOM', async () => {
    const { engine, send, start } = fixture('<p>Moving text</p><a></a>');
    const originalParent = document.querySelector('p')!;
    const destination = document.querySelector('a')!;
    const text = originalParent.firstChild!;
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(1));
    const span = originalParent.querySelector('[data-browser-fanyi]')!;
    destination.append(text);
    await vi.waitFor(() => expect(span.parentElement).toBe(destination));
    expect(destination.firstChild).toBe(text);
    expect(text.nextSibling).toBe(span);
    expect(originalParent.textContent).toBe('');
    expect(send).toHaveBeenCalledOnce();
    await engine.handle({ type: 'content.command', action: 'restore' });
    expect(destination.firstChild).toBe(text);
    expect(destination.textContent).toBe('Moving text');
    expect(originalParent.childNodes).toHaveLength(0);
  });

  it('repositions an externally removed span without translating again', async () => {
    const { engine, send, start } = fixture('<p>Keep text</p>');
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(1));
    const paragraph = document.querySelector('p')!;
    const span = paragraph.querySelector('[data-browser-fanyi]')!;
    span.remove();
    await vi.waitFor(() => expect(span.parentElement).toBe(paragraph));
    expect(paragraph.firstChild!.nextSibling).toBe(span);
    expect(send).toHaveBeenCalledOnce();
  });

  it('preserves whitespace-only long pieces locally and sends the complete nonempty remainder', async () => {
    const { engine, send, start } = fixture('<p></p>');
    const source = ' '.repeat(2000) + 'Text';
    document.querySelector('p')!.textContent = source;
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(2));
    expect(send.mock.calls).toEqual([['Text']]);
    expect(document.querySelector('[data-browser-fanyi]')!.textContent).toBe(' '.repeat(2000) + '译:Text');
  });
});
