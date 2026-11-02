import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/shared/browser', () => ({ default: { runtime: { sendMessage: vi.fn() } } }));

import { MAX_GLOSSARY_IMPORT_BYTES, parseGlossaryImport } from '../../src/ui/glossary';

const document = (entries: unknown[]) => JSON.stringify({ version: 1, entries });

describe('version 1 glossary import parsing', () => {
  it('normalizes a valid local file for preview', () => {
    const text = document([
      { source: ' source ', target: ' target ', targetLanguage: ' en ' },
      { source: 'source', target: '译词', targetLanguage: 'zh-CN' },
    ]);
    expect(parseGlossaryImport(text, new TextEncoder().encode(text).byteLength)).toEqual([
      { source: 'source', target: 'target', targetLanguage: 'en' },
      { source: 'source', target: '译词', targetLanguage: 'zh-CN' },
    ]);
  });

  it('rejects files over 1 MiB before parsing', () => {
    expect(() => parseGlossaryImport('{}', MAX_GLOSSARY_IMPORT_BYTES + 1)).toThrow(/1 MiB/);
  });

  it.each([
    ['invalid JSON', '{'],
    ['wrong version', JSON.stringify({ version: 2, entries: [] })],
    ['missing entries', JSON.stringify({ version: 1 })],
    ['empty entries', document([])],
    ['id injection', document([{ id: 'caller-id', source: 'a', target: 'b', targetLanguage: 'en' }])],
    ['control characters', document([{ source: 'a\nb', target: 'b', targetLanguage: 'en' }])],
  ])('rejects %s', (_name, text) => {
    expect(() => parseGlossaryImport(text, text.length)).toThrow();
  });

  it('reports the one-based position of a duplicate in the batch', () => {
    const text = document([
      { source: 'same', target: 'first', targetLanguage: 'en' },
      { source: 'same', target: 'second', targetLanguage: 'en' },
    ]);
    expect(() => parseGlossaryImport(text, text.length)).toThrow(/第 2 项/);
  });

  it('uses Unicode codepoints for source and target limits', () => {
    const accepted = document([{ source: '😀'.repeat(80), target: '😀'.repeat(160), targetLanguage: 'en' }]);
    expect(parseGlossaryImport(accepted, accepted.length)).toHaveLength(1);
    const rejected = document([{ source: '😀'.repeat(81), target: 'target', targetLanguage: 'en' }]);
    expect(() => parseGlossaryImport(rejected, rejected.length)).toThrow(/第 1 项/);
  });
});
