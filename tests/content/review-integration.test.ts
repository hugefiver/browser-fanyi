import { describe, expect, it, vi } from 'vitest';
import { fixture, deferred, success } from './helpers';
import type { Reply } from '../../src/shared/contracts';

const panel = () => document.querySelector<HTMLElement>('[data-browser-fanyi="translation-review"]')!;
const editor = () => panel().querySelector<HTMLTextAreaElement>('textarea')!;
const button = (name: string) => [...panel().querySelectorAll('button')].find(button => button.textContent === name)!;
const learning = (enabled: boolean) => {
  const input = panel().querySelector<HTMLInputElement>('[data-translation-review-learning]')!;
  input.checked = enabled; input.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('review bound to actual page entries', () => {
  it('edits only the selected node, restores service text and reveals without network', async () => {
    const f = fixture('<p>Same</p><p>Same</p><textarea>Draft</textarea>');
    await f.start(); await vi.waitFor(() => expect(f.engine.status().completed).toBe(2));
    await f.engine.handle({ type: 'content.command', action: 'review' });
    editor().value = '<img src=x onerror=bad()>edited'; button('保存').click();
    expect(document.querySelectorAll('p')[0].textContent).toBe('Same<img src=x onerror=bad()>edited');
    expect(document.querySelectorAll('p')[1].textContent).toBe('Same译:Same');
    expect(document.querySelector('img')).toBeNull();
    button('恢复服务译文').click();
    expect(document.querySelector('p')!.textContent).toBe('Same译:Same');
    await f.engine.handle({ type: 'content.command', action: 'mode', mode: 'translation' });
    learning(true);
    expect(document.querySelector('p')!.textContent).toBe('Same');
    expect(editor().hidden).toBe(true);
    button('揭示译文').click();
    expect(document.querySelector('p')!.textContent).toBe('Same译:Same');
    button('关闭').click();
    expect(document.querySelector('p')!.textContent).toBe('译:Same');
    expect(document.querySelector('textarea')!.value).toBe('Draft');
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('keeps empty and whitespace edits owned across mode, learning, and reset operations', async () => {
    const f = fixture('<p>Editable source</p>');
    const paragraph = document.querySelector('p')!;
    await f.start();
    await vi.waitFor(() => expect(f.engine.status().completed).toBe(1));
    await f.engine.handle({ type: 'content.command', action: 'mode', mode: 'translation' });
    await f.engine.handle({ type: 'content.command', action: 'review' });

    for (const text of ['', '   ']) {
      editor().value = text;
      button('保存').click();
      expect(paragraph.firstChild!.textContent).toBe(text);

      await f.engine.handle({ type: 'content.command', action: 'mode', mode: 'bilingual' });
      expect(paragraph.firstChild!.textContent).toBe('Editable source');
      await f.engine.handle({ type: 'content.command', action: 'mode', mode: 'translation' });
      expect(paragraph.firstChild!.textContent).toBe(text);

      learning(true);
      expect(paragraph.firstChild!.textContent).toBe('Editable source');
      expect(editor().hidden).toBe(true);
      button('揭示译文').click();
      expect(paragraph.firstChild!.textContent).toBe('Editable source');
      learning(false);
      expect(paragraph.firstChild!.textContent).toBe(text);

      button('恢复服务译文').click();
      expect(paragraph.firstChild!.textContent).toBe('译:Editable source');
    }
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('does not reclaim a whitespace website update after an owned empty edit', async () => {
    const f = fixture('<p>Website source</p>');
    const paragraph = document.querySelector('p')!;
    await f.start();
    await vi.waitFor(() => expect(f.engine.status().completed).toBe(1));
    await f.engine.handle({ type: 'content.command', action: 'mode', mode: 'translation' });
    await f.engine.handle({ type: 'content.command', action: 'review' });
    editor().value = '';
    button('保存').click();

    paragraph.firstChild!.textContent = '   ';
    await vi.waitFor(() => expect(panel().querySelectorAll('[data-translation-review-entry]')).toHaveLength(0));
    await f.engine.handle({ type: 'content.command', action: 'mode', mode: 'bilingual' });
    learning(true);
    await f.engine.handle({ type: 'content.command', action: 'restore' });

    expect(paragraph.textContent).toBe('   ');
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('preserves an unsaved draft across unrelated mutations and completed entries', async () => {
    const late = deferred<Reply<string>>();
    const f = fixture('<p>First</p><p>Second</p>', text => text === 'First' ? Promise.resolve(success('一')) : late.promise);
    await f.start(); await vi.waitFor(() => expect(f.engine.status().completed).toBe(1));
    await f.engine.handle({ type: 'content.command', action: 'review' });
    const initial = editor(); initial.value = 'Unfinished'; initial.dispatchEvent(new Event('input', { bubbles: true }));
    document.body.classList.add('website-update');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(editor()).toBe(initial);
    late.resolve(success('二'));
    await vi.waitFor(() => expect(panel().querySelectorAll('textarea')).toHaveLength(2));
    expect(editor().value).toBe('Unfinished');
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('drops edit identity after a website source change, and restore keeps website events', async () => {
    const f = fixture('<p>Old</p><input value="Draft">');
    const input = document.querySelector('input')!;
    const listener = vi.fn(); input.addEventListener('input', listener);
    await f.start(); await vi.waitFor(() => expect(f.engine.status().completed).toBe(1));
    await f.engine.handle({ type: 'content.command', action: 'review' });
    const oldId = panel().querySelector('[data-translation-review-entry]')!.getAttribute('data-translation-review-entry');
    editor().value = 'Edited'; button('保存').click();
    document.querySelector('p')!.firstChild!.textContent = 'New';
    await vi.waitFor(() => expect(document.querySelector('p')!.textContent).toBe('New译:New'));
    expect(panel().querySelector('[data-translation-review-entry]')!.getAttribute('data-translation-review-entry')).not.toBe(oldId);
    expect(editor().value).toBe('译:New');
    await f.engine.handle({ type: 'content.command', action: 'restore' });
    expect(document.querySelector('p')!.textContent).toBe('New');
    expect(document.querySelector('[data-browser-fanyi]')).toBeNull();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(listener).toHaveBeenCalledOnce();
  });
});
