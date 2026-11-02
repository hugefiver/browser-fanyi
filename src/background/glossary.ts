import { fail, type GlossaryDraft, type GlossaryEntry, type GlossaryMapping, type Reply } from '../shared/contracts';

export const MAX_GLOSSARY_ENTRIES = 200;
const MAX_SOURCE_CODEPOINTS = 80;
const MAX_TARGET_CODEPOINTS = 160;
const MAX_MATCHES = 20;
const MAX_MAPPING_CODEPOINTS = 2000;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export class GlossaryError extends Error {}

function label(position?: number): string {
  return position === undefined ? '术语' : `第 ${position} 项`;
}

export function normalizeGlossaryDraft(input: GlossaryDraft, position?: number): GlossaryDraft {
  const source = input.source.trim();
  const target = input.target.trim();
  const targetLanguage = input.targetLanguage.trim();
  const prefix = label(position);
  if (!source || Array.from(source).length > MAX_SOURCE_CODEPOINTS) {
    throw new GlossaryError(`${prefix}原词须为 1–${MAX_SOURCE_CODEPOINTS} 个字符。`);
  }
  if (!target || Array.from(target).length > MAX_TARGET_CODEPOINTS) {
    throw new GlossaryError(`${prefix}译词须为 1–${MAX_TARGET_CODEPOINTS} 个字符。`);
  }
  if (!targetLanguage) throw new GlossaryError(`${prefix}目标语言不能为空。`);
  if ([source, target, targetLanguage].some((value) => CONTROL_CHARACTER.test(value))) {
    throw new GlossaryError(`${prefix}字段须为不含控制字符的单行文本。`);
  }
  return { source, target, targetLanguage };
}

function duplicate(entries: GlossaryEntry[], draft: GlossaryDraft, ignoredId?: string): boolean {
  return entries.some((entry) => entry.id !== ignoredId
    && entry.targetLanguage === draft.targetLanguage && entry.source === draft.source);
}

export function upsertGlossary(entries: GlossaryEntry[], input: GlossaryDraft & { id?: string }): GlossaryEntry[] {
  const draft = normalizeGlossaryDraft(input);
  if (duplicate(entries, draft, input.id)) throw new GlossaryError('同一目标语言不能包含重复原词。');
  if (input.id !== undefined) {
    const index = entries.findIndex((entry) => entry.id === input.id);
    if (index < 0) throw new GlossaryError('要编辑的术语不存在。');
    return entries.map((entry, entryIndex) => entryIndex === index ? { id: input.id!, ...draft } : entry);
  }
  if (entries.length >= MAX_GLOSSARY_ENTRIES) throw new GlossaryError(`术语最多 ${MAX_GLOSSARY_ENTRIES} 项。`);
  return [...entries, { id: crypto.randomUUID(), ...draft }];
}

export function deleteGlossary(entries: GlossaryEntry[], id: string): GlossaryEntry[] {
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) throw new GlossaryError('要删除的术语不存在。');
  return next;
}

export function appendGlossary(entries: GlossaryEntry[], inputs: GlossaryDraft[]): GlossaryEntry[] {
  const next = [...entries];
  for (const [index, input] of inputs.entries()) {
    const position = index + 1;
    if (next.length >= MAX_GLOSSARY_ENTRIES) {
      throw new GlossaryError(`第 ${position} 项使术语总数超过 ${MAX_GLOSSARY_ENTRIES} 项。`);
    }
    const draft = normalizeGlossaryDraft(input, position);
    if (duplicate(next, draft)) throw new GlossaryError(`第 ${position} 项与已有或本批术语重复。`);
    next.push({ id: crypto.randomUUID(), ...draft });
  }
  return next;
}

export function matchGlossary(entries: GlossaryEntry[], text: string, targetLanguage: string): Reply<GlossaryMapping[]> {
  const candidates = entries.filter((entry) => entry.targetLanguage === targetLanguage)
    .sort((left, right) => Array.from(right.source).length - Array.from(left.source).length);
  const emitted = new Set<string>();
  const mappings: GlossaryMapping[] = [];
  let mappingCodepoints = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const match = candidates.find((entry) => text.startsWith(entry.source, cursor));
    if (!match) {
      cursor += (text.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1;
      continue;
    }
    if (!emitted.has(match.id)) {
      const codepoints = Array.from(match.source).length + Array.from(match.target).length;
      if (mappings.length >= MAX_MATCHES || mappingCodepoints + codepoints > MAX_MAPPING_CODEPOINTS) return fail('limit');
      emitted.add(match.id);
      mappingCodepoints += codepoints;
      mappings.push({ source: match.source, target: match.target });
    }
    cursor += match.source.length;
  }
  return { ok: true, value: mappings };
}
