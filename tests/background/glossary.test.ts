import { describe, expect, it } from 'vitest';
import { appendGlossary, GlossaryError, matchGlossary, normalizeGlossaryDraft, upsertGlossary } from '../../src/background/glossary';
import { fail, type GlossaryEntry } from '../../src/shared/contracts';

const entry = (id: string, source: string, target: string, targetLanguage = 'zh-CN'): GlossaryEntry => ({
  id, source, target, targetLanguage,
});

describe('glossary validation and mutations', () => {
  it('trims values and counts Unicode codepoints', () => {
    expect(normalizeGlossaryDraft({ source: ` ${'😀'.repeat(80)} `, target: ' 译词 ', targetLanguage: ' zh-CN ' }))
      .toEqual({ source: '😀'.repeat(80), target: '译词', targetLanguage: 'zh-CN' });
    expect(() => normalizeGlossaryDraft({ source: '😀'.repeat(81), target: '译词', targetLanguage: 'zh-CN' }))
      .toThrow(GlossaryError);
  });

  it.each([
    { source: '', target: 'target', targetLanguage: 'en' },
    { source: 'source', target: '', targetLanguage: 'en' },
    { source: 'source', target: 'target', targetLanguage: '' },
    { source: 'source\nnext', target: 'target', targetLanguage: 'en' },
    { source: 'source', target: 'target\tvalue', targetLanguage: 'en' },
  ])('rejects invalid fields %#', (draft) => {
    expect(() => normalizeGlossaryDraft(draft)).toThrow(GlossaryError);
  });

  it('creates background ids, rejects duplicates, and requires an existing id for edits', () => {
    const created = upsertGlossary([], { source: 'source', target: 'target', targetLanguage: 'en' });
    expect(created[0].id).toMatch(/^[\da-f-]{36}$/);
    expect(() => upsertGlossary(created, { source: 'source', target: 'other', targetLanguage: 'en' })).toThrow(/重复/);
    expect(() => upsertGlossary(created, { id: 'missing', source: 'new', target: 'other', targetLanguage: 'en' }))
      .toThrow(/不存在/);
    expect(upsertGlossary(created, { id: created[0].id, source: ' source ', target: 'updated', targetLanguage: 'fr' })[0])
      .toMatchObject({ source: 'source', target: 'updated', targetLanguage: 'fr' });
  });

  it('reports the one-based import position and leaves the input collection unchanged', () => {
    const existing = [entry('one', 'alpha', '甲')];
    expect(() => appendGlossary(existing, [
      { source: 'beta', target: '乙', targetLanguage: 'zh-CN' },
      { source: 'alpha', target: '重复', targetLanguage: 'zh-CN' },
    ])).toThrow(/第 2 项/);
    expect(existing).toEqual([entry('one', 'alpha', '甲')]);
  });
});

describe('glossary matching', () => {
  it('matches case-sensitive literals left-to-right with longest overlap and output deduplication', () => {
    const entries = [
      entry('short', 'New', '新'), entry('long', 'New York', '纽约'), entry('inside', 'York', '约克'), entry('lower', 'new', '小写新'),
      entry('other-language', 'New York', 'New York', 'fr'),
    ];
    expect(matchGlossary(entries, 'New York New new New York', 'zh-CN')).toEqual({ ok: true, value: [
      { source: 'New York', target: '纽约' }, { source: 'New', target: '新' }, { source: 'new', target: '小写新' },
    ] });
  });

  it('walks Unicode text without splitting surrogate pairs', () => {
    expect(matchGlossary([entry('emoji', '😀术语', '表情术语')], '前😀术语后', 'zh-CN'))
      .toEqual({ ok: true, value: [{ source: '😀术语', target: '表情术语' }] });
  });

  it('fails instead of truncating more than 20 relevant mappings', () => {
    const entries = Array.from({ length: 21 }, (_, index) => entry(String(index), `term-${index}`, `target-${index}`));
    expect(matchGlossary(entries, entries.map(({ source }) => source).join(' '), 'zh-CN')).toEqual(fail('limit'));
  });

  it('fails instead of truncating mappings over 2000 combined codepoints', () => {
    const entries = Array.from({ length: 9 }, (_, index) => entry(String(index),
      `${String.fromCharCode(65 + index)}${'s'.repeat(79)}`, '译'.repeat(160)));
    expect(matchGlossary(entries, entries.map(({ source }) => source).join(' '), 'zh-CN')).toEqual(fail('limit'));
  });
});
