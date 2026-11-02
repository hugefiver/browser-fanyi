export const SRT_MAX_BYTES = 1024 * 1024;
export const SRT_MAX_CUES = 2000;
export const SRT_MAX_TOTAL_CODE_POINTS = 400_000;
export const SRT_MAX_CUE_CODE_POINTS = 2000;
export const SRT_MAX_TRANSLATION_BYTES = 4 * 1024 * 1024;

export interface SrtCue {
  readonly number: string;
  readonly timeline: string;
  readonly text: string;
  readonly line: number;
}

export interface SrtDocument {
  readonly cues: readonly SrtCue[];
  readonly totalCodePoints: number;
}

export type SrtErrorCode = 'invalid-utf8' | 'file-too-large' | 'invalid-unicode' | 'invalid-newline'
  | 'nul' | 'empty' | 'cue-limit' | 'number' | 'timeline' | 'empty-text'
  | 'cue-text-limit' | 'total-text-limit' | 'translation-count' | 'translation-size';

export class SrtError extends Error {
  constructor(
    readonly code: SrtErrorCode,
    message: string,
    readonly line: number = 1,
    readonly cue?: number,
  ) {
    super(`第 ${line} 行${cue === undefined ? '' : `，第 ${cue} 条`}: ${message}`);
    this.name = 'SrtError';
  }
}

const encoder = new TextEncoder();
const blank = (line: string): boolean => line.trim().length === 0;
const timelinePattern = /^[ \t]*(\d{2}):([0-5]\d):([0-5]\d),(\d{3})[ \t]+-->[ \t]+(\d{2}):([0-5]\d):([0-5]\d),(\d{3})[ \t]*$/;

function validateCharacters(text: string, line = 1, cue?: number): void {
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) {
      throw new SrtError('invalid-unicode', '文本包含不完整的 Unicode 字符。', line, cue);
    }
    if (character === '\0') throw new SrtError('nul', '文本不能包含 NUL。', line, cue);
    if (character === '\n') line++;
  }
}

export function decodeSrt(bytes: ArrayBuffer | Uint8Array): string {
  if (bytes.byteLength > SRT_MAX_BYTES) throw new SrtError('file-too-large', '文件超过 1 MiB。');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SrtError('invalid-utf8', '文件必须使用有效的 UTF-8 编码。');
  }
}

export function parseSrt(text: string): SrtDocument {
  if (encoder.encode(text).byteLength > SRT_MAX_BYTES) {
    throw new SrtError('file-too-large', '文件超过 1 MiB。');
  }
  validateCharacters(text);
  const bareCr = /\r(?!\n)/.exec(text);
  if (bareCr) {
    throw new SrtError('invalid-newline', '只接受 LF 或 CRLF 换行。', text.slice(0, bareCr.index).split('\n').length);
  }
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const cues: SrtCue[] = [];
  const numbers = new Set<string>();
  let totalCodePoints = 0;
  let cursor = 0;
  while (cursor < lines.length) {
    if (blank(lines[cursor])) { cursor++; continue; }
    const line = cursor + 1;
    const cue = cues.length + 1;
    if (cue > SRT_MAX_CUES) throw new SrtError('cue-limit', '字幕超过 2000 条。', line, cue);
    const number = lines[cursor++];
    const canonicalNumber = number.replace(/^0+/, '');
    if (!/^\d+$/.test(number) || !canonicalNumber || numbers.has(canonicalNumber)) {
      throw new SrtError('number', '编号必须是唯一的正整数。', line, cue);
    }
    numbers.add(canonicalNumber);
    const timeline = lines[cursor++] ?? '';
    const match = timelinePattern.exec(timeline);
    if (!match) throw new SrtError('timeline', '时间轴格式无效。', line + 1, cue);
    const start = ((+match[1] * 60 + +match[2]) * 60 + +match[3]) * 1000 + +match[4];
    const end = ((+match[5] * 60 + +match[6]) * 60 + +match[7]) * 1000 + +match[8];
    if (start > end) throw new SrtError('timeline', '开始时间不能晚于结束时间。', line + 1, cue);
    const bodyStart = cursor;
    while (cursor < lines.length && !blank(lines[cursor])) cursor++;
    const body = lines.slice(bodyStart, cursor).join('\n');
    if (!body) throw new SrtError('empty-text', '字幕正文不能为空。', bodyStart + 1, cue);
    const points = [...body].length;
    if (points > SRT_MAX_CUE_CODE_POINTS) {
      throw new SrtError('cue-text-limit', '单条正文超过 2000 码点。', bodyStart + 1, cue);
    }
    totalCodePoints += points;
    if (totalCodePoints > SRT_MAX_TOTAL_CODE_POINTS) {
      throw new SrtError('total-text-limit', '正文总计超过 400000 码点。', bodyStart + 1, cue);
    }
    cues.push({ number, timeline, text: body, line });
  }
  if (!cues.length) throw new SrtError('empty', '文件必须包含至少一条字幕。');
  return { cues, totalCodePoints };
}

export function normalizeSrtTranslation(text: string, line = 1, cue?: number): string {
  let normalized = text.replace(/\r\n?/g, '\n');
  validateCharacters(normalized, line, cue);
  normalized = normalized.split('\n').filter(value => !blank(value)).join('\n');
  if (!normalized) throw new SrtError('empty-text', '译文不能为空。', line, cue);
  return normalized;
}

export function serializeSrt(document: SrtDocument, translations?: readonly string[]): string {
  if (translations && translations.length !== document.cues.length) {
    throw new SrtError('translation-count', '译文必须与字幕条目一一对应。');
  }
  let translationBytes = 0;
  const blocks = document.cues.map((cue, index) => {
    let text = cue.text;
    if (translations) {
      translationBytes += encoder.encode(translations[index]).byteLength;
      if (translationBytes > SRT_MAX_TRANSLATION_BYTES) {
        throw new SrtError('translation-size', '累计译文超过 4 MiB。', cue.line + 2, index + 1);
      }
      text = normalizeSrtTranslation(translations[index], cue.line + 2, index + 1);
    }
    return [cue.number, cue.timeline, text.replace(/\n/g, '\r\n')].join('\r\n');
  });
  return `${blocks.join('\r\n\r\n')}\r\n`;
}
