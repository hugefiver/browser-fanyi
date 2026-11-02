import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TranslationReview,
  type TranslationReviewCallbacks,
  type TranslationReviewEntry,
} from '../../src/content/translation-review';

const active: TranslationReview[] = [];

function entry(overrides: Partial<TranslationReviewEntry> = {}): TranslationReviewEntry {
  return {
    id: 'entry-1',
    source: 'Hello',
    serviceTranslation: '你好',
    translation: '你好',
    edited: false,
    revealed: false,
    ...overrides,
  };
}

function setup(initial: TranslationReviewEntry[] = [entry()]) {
  let entries = initial;
  let learning = false;
  const callbacks: TranslationReviewCallbacks = {
    getEntries: vi.fn(() => entries),
    edit: vi.fn((id, text) => {
      entries = entries.map(item => item.id === id
        ? { ...item, translation: text, edited: text !== item.serviceTranslation }
        : item);
    }),
    reset: vi.fn(id => {
      entries = entries.map(item => item.id === id
        ? { ...item, translation: item.serviceTranslation, edited: false }
        : item);
    }),
    reveal: vi.fn((id, revealed) => {
      entries = entries.map(item => item.id === id ? { ...item, revealed } : item);
    }),
    learning: vi.fn(enabled => { learning = enabled; }),
  };
  const review = new TranslationReview(document, callbacks);
  active.push(review);
  return {
    review,
    callbacks,
    get entries() { return entries; },
    get learning() { return learning; },
    replaceEntries(next: TranslationReviewEntry[]) { entries = next; },
  };
}

function root(): HTMLElement {
  return document.querySelector('[data-browser-fanyi="translation-review"]')!;
}

function button(name: string): HTMLButtonElement {
  return [...root().querySelectorAll('button')].find(candidate => candidate.textContent === name)!;
}

afterEach(() => {
  for (const review of active.splice(0)) review.destroy();
  document.body.replaceChildren();
  document.querySelectorAll('[data-browser-fanyi="translation-review"]').forEach(node => node.remove());
  vi.unstubAllGlobals();
});

describe('TranslationReview', () => {
  it('edits, restores, reveals, and toggles learning through local callbacks without network access', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const xhrSend = vi.spyOn(XMLHttpRequest.prototype, 'send');
    const fixture = setup();
    fixture.review.open();

    const textarea = root().querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = '人工译文';
    button('保存').click();
    expect(fixture.entries[0]).toMatchObject({ translation: '人工译文', edited: true });
    expect(fixture.callbacks.edit).toHaveBeenCalledWith('entry-1', '人工译文');

    button('恢复服务译文').click();
    expect(fixture.entries[0]).toMatchObject({ translation: '你好', edited: false });
    expect(fixture.callbacks.reset).toHaveBeenCalledWith('entry-1');

    button('揭示译文').click();
    expect(fixture.entries[0].revealed).toBe(true);
    expect(fixture.callbacks.reveal).toHaveBeenCalledWith('entry-1', true);

    const learning = root().querySelector<HTMLInputElement>('[data-translation-review-learning]')!;
    learning.checked = true;
    learning.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fixture.learning).toBe(true);
    expect(fixture.callbacks.learning).toHaveBeenCalledWith(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(xhrSend).not.toHaveBeenCalled();
  });

  it('renders source and translations as literal text without making the page editable', () => {
    const maliciousSource = '<img src=x onerror="globalThis.attacked=true">';
    const maliciousTranslation = '<script>globalThis.attacked=true</script> & literal';
    const fixture = setup([entry({ source: maliciousSource, serviceTranslation: maliciousTranslation,
      translation: maliciousTranslation })]);
    fixture.review.open();

    expect(root().querySelector('[data-translation-review-source]')!.textContent).toBe(maliciousSource);
    expect(root().querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(maliciousTranslation);
    expect(root().querySelector('img, script')).toBeNull();
    expect(root().querySelector('[contenteditable]')).toBeNull();
  });

  it('shows an empty state with no entry controls', () => {
    const fixture = setup([]);
    fixture.review.open();

    expect(root().querySelector('[data-translation-review-empty]')!.textContent).toBeTruthy();
    expect(root().querySelectorAll('[data-translation-review-entry]')).toHaveLength(0);
    expect(root().querySelector('[data-translation-review-page]')!.textContent).toBe('0 / 0');
    expect(button('上一页').disabled).toBe(true);
    expect(button('下一页').disabled).toBe(true);
  });

  it('discards an unsaved editor when refresh replaces stale entries', () => {
    const fixture = setup();
    fixture.review.open();
    const oldEditor = root().querySelector<HTMLTextAreaElement>('textarea')!;
    oldEditor.value = '未保存草稿';
    fixture.replaceEntries([entry({ id: 'entry-2', source: 'New source', serviceTranslation: '新译文', translation: '新译文' })]);

    fixture.review.refresh();

    expect(oldEditor.isConnected).toBe(false);
    expect(fixture.callbacks.edit).not.toHaveBeenCalled();
    expect(root().querySelector('[data-translation-review-entry="entry-1"]')).toBeNull();
    expect(root().querySelector('[data-translation-review-entry="entry-2"] textarea')!.textContent).toBe('');
    expect(root().querySelector<HTMLTextAreaElement>('[data-translation-review-entry="entry-2"] textarea')!.value).toBe('新译文');
  });

  it('renders at most 50 entries per page', () => {
    const entries = Array.from({ length: 51 }, (_, index) => entry({
      id: `entry-${index}`,
      source: `source ${index}`,
      serviceTranslation: `translation ${index}`,
      translation: `translation ${index}`,
    }));
    const fixture = setup(entries);
    fixture.review.open();

    expect(root().querySelectorAll('[data-translation-review-entry]')).toHaveLength(50);
    expect(root().querySelector('[data-translation-review-page]')!.textContent).toBe('1 / 2');
    button('下一页').click();
    expect(root().querySelectorAll('[data-translation-review-entry]')).toHaveLength(1);
    expect(root().querySelector('[data-translation-review-entry="entry-50"]')).not.toBeNull();
    expect(root().querySelector('[data-translation-review-page]')!.textContent).toBe('2 / 2');
  });

  it('close leaves local edits intact and exits learning display', () => {
    const fixture = setup();
    fixture.review.open();
    button('揭示译文').click();
    const learning = root().querySelector<HTMLInputElement>('[data-translation-review-learning]')!;
    learning.checked = true;
    learning.dispatchEvent(new Event('change', { bubbles: true }));

    button('关闭').click();

    expect(document.querySelector('[data-browser-fanyi="translation-review"]')).toBeNull();
    expect(fixture.entries[0].revealed).toBe(true);
    expect(fixture.learning).toBe(false);
    expect(fixture.callbacks.reveal).toHaveBeenCalledTimes(1);
    expect(fixture.callbacks.learning).toHaveBeenCalledTimes(2);

    fixture.review.open();
    expect(root().querySelector<HTMLInputElement>('[data-translation-review-learning]')!.checked).toBe(false);
    fixture.review.destroy();
    expect(document.querySelector('[data-browser-fanyi="translation-review"]')).toBeNull();
    expect(() => fixture.review.open()).toThrow('destroyed');
  });
});
