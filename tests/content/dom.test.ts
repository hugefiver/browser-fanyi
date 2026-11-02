// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fixture, grant, success } from './helpers';

describe('content DOM ownership', () => {
  it('keeps Text, link/button listeners and input state through cached modes and restore', async () => {
    const { engine, send, start } = fixture('<a href="#">Hello</a><button>Go</button><input value="initial">');
    const link = document.querySelector('a')!;
    const text = link.firstChild;
    const click = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', click);
    const input = document.querySelector('input')!;
    input.value = 'user draft';
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(2));
    expect(link.firstChild).toBe(text);
    expect(link.querySelectorAll('[data-browser-fanyi]')).toHaveLength(1);
    await engine.handle({ type: 'content.command', action: 'mode', mode: 'translation' });
    expect(link.firstChild).toBe(text);
    expect(link.textContent).toBe('译:Hello');
    link.click();
    expect(click).toHaveBeenCalledOnce();
    await engine.handle({ type: 'content.command', action: 'mode', mode: 'bilingual' });
    expect(link.textContent).toBe('Hello译:Hello');
    expect(send).toHaveBeenCalledTimes(2);
    const extra = document.createElement('p');
    extra.textContent = 'Website addition';
    document.body.append(extra);
    await engine.handle({ type: 'content.command', action: 'restore' });
    expect(link.textContent).toBe('Hello');
    expect(input.value).toBe('user draft');
    expect(extra.isConnected).toBe(true);
    expect(extra.textContent).toBe('Website addition');
    expect(document.querySelector('[data-browser-fanyi]')).toBeNull();
  });

  it('scans added/visible text and invalidates website changes without feedback', async () => {
    const { engine, send, start } = fixture('<p>First</p><div hidden>Later</div>');
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(1));
    const first = document.querySelector('p')!.firstChild!;
    first.textContent = 'Changed';
    const next = document.createElement('p');
    next.textContent = 'New';
    document.body.append(next);
    document.querySelector('div')!.hidden = false;
    await vi.waitFor(() => expect(engine.status().completed).toBe(3));
    expect(send.mock.calls.map(call => call[0])).toEqual(['First', 'Changed', 'Later', 'New']);
    expect(document.querySelector('p')!.textContent).toBe('Changed译:Changed');
    expect(document.querySelectorAll('[data-browser-fanyi]')).toHaveLength(3);
  });

  it('never restores a website edit or resurrects a deleted node', async () => {
    const { engine, start } = fixture('<p>Source</p><a>Removed</a>');
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(2));
    await engine.handle({ type: 'content.command', action: 'mode', mode: 'translation' });
    const paragraph = document.querySelector('p')!;
    paragraph.firstChild!.textContent = 'Website replacement';
    document.querySelector('a')!.remove();
    await engine.handle({ type: 'content.command', action: 'restore' });
    expect(paragraph.textContent).toBe('Website replacement');
    expect(document.querySelector('a')).toBeNull();
  });

  it('treats an equal-valued website write as a source change', async () => {
    const { engine, send, start } = fixture('<p>Source</p>');
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(1));
    await engine.handle({ type: 'content.command', action: 'mode', mode: 'translation' });
    await engine.handle({ type: 'content.command', action: 'pause' });
    const text = document.querySelector('p')!.firstChild!;
    text.textContent = '译:Source';
    await vi.waitFor(() => expect(engine.status().total).toBe(1));
    await engine.handle({ type: 'content.command', action: 'restore' });
    expect(document.querySelector('p')!.textContent).toBe('译:Source');
    expect(send).toHaveBeenCalledOnce();
  });

  it('excludes hidden, editable, form, extension, iframe and shadow text', async () => {
    const { engine, send, start } = fixture('<p>Visible</p><div hidden>Hidden</div><div style="display:none">CSS</div><div aria-hidden="true">Aria</div><div contenteditable="true"><p>Draft</p></div><textarea>Input</textarea><select><option>Choice</option></select><script>Script</script><style>Style</style><div data-browser-fanyi>Extension</div><iframe></iframe><section></section>');
    document.querySelector('section')!.attachShadow({ mode: 'open' }).textContent = 'Shadow';
    document.querySelector('iframe')!.contentDocument!.body.textContent = 'Frame';
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(1));
    expect(send.mock.calls).toEqual([['Visible']]);
  });

  it('renders service markup only as text and keeps long nodes whole until every piece succeeds', async () => {
    const source = '😀'.repeat(4501);
    const { engine, send, start } = fixture('<p></p>', async text => {
      if (text.length === 1002) return { ok: false, error: { code: 'network', message: 'offline' } };
      return success('<img src=x onerror=alert(1)>');
    });
    document.querySelector('p')!.textContent = source;
    await start();
    await vi.waitFor(() => expect(engine.status().failed).toBe(1));
    expect(engine.status()).toMatchObject({ total: 3, completed: 2, failed: 1, pending: 0, phase: 'partial' });
    expect(send.mock.calls.every(call => Array.from(call[0]).length <= 2000)).toBe(true);
    expect(send.mock.calls.map(call => call[0]).join('')).toBe(source);
    expect(document.querySelector('p')!.textContent).toBe(source);
    send.mockImplementation(async () => success('<script>service text</script>'));
    await engine.handle({ type: 'content.command', action: 'retry', grant: grant('retry') });
    await vi.waitFor(() => expect(engine.status().completed).toBe(3));
    expect(send).toHaveBeenCalledTimes(4);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[data-browser-fanyi]')!.textContent).toContain('<script>service text</script>');
  });
});
