import { describe, expect, it } from 'vitest';
import {
  decodeSrt, parseSrt, serializeSrt, SrtError,
  SRT_MAX_BYTES, SRT_MAX_CUES, SRT_MAX_CUE_CODE_POINTS,
  SRT_MAX_TOTAL_CODE_POINTS, SRT_MAX_TRANSLATION_BYTES,
} from '../../src/shared/srt';

const timeline = '00:00:01,000 --> 00:00:02,500';
const cue = (number: number | string = 1, text = 'hello', time = timeline): string => `${number}\n${time}\n${text}`;
const encoder = new TextEncoder();

describe('SRT UTF-8 decoding', () => {
  it('decodes UTF-8 and preserves a BOM for the parser byte-size check', () => {
    const source = `\uFEFF${cue(1, '字幕 😀')}`;
    const bytes = encoder.encode(source);
    expect(decodeSrt(bytes)).toBe(source);
    expect(decodeSrt(bytes.buffer)).toBe(source);
    expect(parseSrt(decodeSrt(bytes)).cues[0].text).toBe('字幕 😀');
  });

  it('decodes only the supplied typed-array view', () => {
    const bytes = encoder.encode(`x${cue()}y`);
    expect(decodeSrt(bytes.subarray(1, -1))).toBe(cue());
  });

  it.each([
    [0xc0, 0xaf], [0xe2, 0x82], [0xff], [0x80], [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80], [0xff, 0xfe, 0x31, 0x00],
  ])('rejects malformed UTF-8 %j', (...bytes) => {
    expect(() => decodeSrt(new Uint8Array(bytes))).toThrowError(expect.objectContaining({ code: 'invalid-utf8', line: 1 }));
  });

  it('rejects bytes above 1 MiB before decoding', () => {
    expect(() => decodeSrt(new Uint8Array(SRT_MAX_BYTES + 1))).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
  });
});

describe('SRT parsing', () => {
  it('accepts BOM, mixed LF/CRLF, whitespace separators and multiline Unicode text', () => {
    const time = ' \t00:00:01,000\t -->  00:00:02,500 ';
    const source = `\uFEFF\r\n${cue('007', '第一行😀\n  second line  ', time).replace(/\n/g, '\r\n')}\n \t\n${cue(42, '<i>plain text</i>')}\n\n`;
    const result = parseSrt(source);
    expect(result.cues).toEqual([
      { number: '007', timeline: time, text: '第一行😀\n  second line  ', line: 2 },
      { number: '42', timeline, text: '<i>plain text</i>', line: 7 },
    ]);
    expect(result.totalCodePoints).toBe([...result.cues.map(item => item.text).join('')].length);
  });

  it('retains input order, allows overlap, equal endpoints and large positive numbers', () => {
    const secondTime = '00:00:00,000 --> 00:00:00,000';
    const number = '123456789012345678901234567890';
    const result = parseSrt(`${cue(99)}\n\n${cue(number, 'later entry', secondTime)}`);
    expect(result.cues.map(item => item.number)).toEqual(['99', number]);
    expect(result.cues[1].timeline).toBe(secondTime);
  });

  it.each(['', '\uFEFF', '\n \t\r\n'])('rejects an empty document %j', source => {
    expect(() => parseSrt(source)).toThrowError(expect.objectContaining({ code: 'empty', line: 1 }));
  });

  it.each(['0', '000', '-1', '+1', '1.5', '1e2', 'a', ' 1'])('rejects an invalid number %s', number => {
    expect(() => parseSrt(cue(number))).toThrowError(expect.objectContaining({ code: 'number', line: 1, cue: 1 }));
  });

  it('rejects duplicate numeric identifiers including differently padded numbers', () => {
    expect(() => parseSrt(`${cue('001')}\n\n${cue(1)}`)).toThrowError(expect.objectContaining({ code: 'number', line: 5, cue: 2 }));
  });

  it.each([
    '0:00:01,000 --> 00:00:02,500', '100:00:01,000 --> 00:00:02,500',
    '00:60:01,000 --> 00:00:02,500', '00:00:60,000 --> 00:00:02,500',
    '00:00:01,000 --> 00:60:02,500', '00:00:01,000 --> 00:00:60,500',
    '00:00:01.000 --> 00:00:02,500', '00:00:01,00 --> 00:00:02,500',
    '00:00:01,000 -> 00:00:02,500', '00:00:01,000 --> 00:00:02,500 X1:10',
    '00:00:02,501 --> 00:00:02,500', '',
  ])('rejects an invalid timeline %j', time => {
    expect(() => parseSrt(cue(1, 'text', time))).toThrowError(expect.objectContaining({ code: 'timeline', line: 2, cue: 1 }));
  });

  it('validates millisecond, second and hour boundaries without sorting', () => {
    const time = '99:59:59,998 --> 99:59:59,999';
    expect(parseSrt(cue(1, 'last millisecond', time)).cues[0].timeline).toBe(time);
  });

  it.each(['', ' \t\n'])('rejects empty cue text %j', text => {
    expect(() => parseSrt(cue(1, text))).toThrowError(expect.objectContaining({ code: 'empty-text', line: 3, cue: 1 }));
  });

  it.each([
    ['invalid-newline', `${cue()}\n\n2\r${timeline}\ntext`, 5],
    ['nul', cue(1, 'hello\nworld\0'), 4],
    ['invalid-unicode', cue(1, '\ud800'), 3],
    ['invalid-unicode', cue(1, '\udc00'), 3],
  ])('rejects forbidden characters with positions: %s', (code, source, line) => {
    expect(() => parseSrt(source)).toThrowError(expect.objectContaining({ code, line }));
  });

  it('accepts exactly 1 MiB and independently rejects larger text including BOM bytes', () => {
    const base = `\n${cue()}`;
    const source = ' '.repeat(SRT_MAX_BYTES - encoder.encode(base).length) + base;
    expect(parseSrt(decodeSrt(encoder.encode(source))).cues).toHaveLength(1);
    expect(() => parseSrt(`${source} `)).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
    expect(() => parseSrt(`\uFEFF${source}`)).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
  });

  it('checks UTF-8 bytes rather than JavaScript string length', () => {
    const source = cue(1, '中'.repeat(Math.ceil(SRT_MAX_BYTES / 3)));
    expect(source.length).toBeLessThan(SRT_MAX_BYTES);
    expect(() => parseSrt(source)).toThrowError(expect.objectContaining({ code: 'file-too-large' }));
  });

  it('accepts 2000 cues and rejects the next cue with its position', () => {
    const source = Array.from({ length: 2000 }, (_, index) => cue(index + 1, 'x')).join('\n\n');
    expect(parseSrt(source).cues).toHaveLength(SRT_MAX_CUES);
    expect(() => parseSrt(`${source}\n\n${cue(2001)}`)).toThrowError(expect.objectContaining({ code: 'cue-limit', cue: 2001, line: 8001 }));
  });

  it('counts Unicode code points, including newline characters, for each cue', () => {
    const body = `${'😀'.repeat(1998)}\nx`;
    expect(parseSrt(cue(1, body)).totalCodePoints).toBe(SRT_MAX_CUE_CODE_POINTS);
    expect(() => parseSrt(cue(1, `${body}x`))).toThrowError(expect.objectContaining({ code: 'cue-text-limit', line: 3, cue: 1 }));
  });

  it('accepts 400000 total code points and rejects one more', () => {
    const source = Array.from({ length: 200 }, (_, index) => cue(index + 1, 'x'.repeat(2000))).join('\n\n');
    expect(parseSrt(source).totalCodePoints).toBe(SRT_MAX_TOTAL_CODE_POINTS);
    expect(() => parseSrt(`${source}\n\n${cue(201, 'x')}`)).toThrowError(expect.objectContaining({ code: 'total-text-limit', line: 803, cue: 201 }));
  });

  it('exposes an Error subtype for callers', () => {
    expect(() => parseSrt('')).toThrowError(SrtError);
  });
});

describe('SRT serialization', () => {
  it('round-trips source numbering, timeline whitespace, order and literal markup as CRLF UTF-8', () => {
    const time = '\t00:00:01,000  -->\t00:00:02,500 ';
    const document = parseSrt(`\uFEFF${cue('007', '<b>原文😀</b>\nsecond line', time)}\n\n${cue(2, 'last')}`);
    const output = serializeSrt(document);
    expect(output).toBe(`${cue('007', '<b>原文😀</b>\nsecond line', time)}\n\n${cue(2, 'last')}\n`.replace(/\n/g, '\r\n'));
    const reparsed = parseSrt(decodeSrt(encoder.encode(output)));
    expect(reparsed.cues.map(({ number, timeline, text }) => ({ number, timeline, text })))
      .toEqual(document.cues.map(({ number, timeline, text }) => ({ number, timeline, text })));
  });

  it('normalizes translated blank lines and prevents insertion of a new cue', () => {
    const document = parseSrt(`${cue(9)}\n\n${cue(2, 'second')}`);
    const injected = `\r\n \t\r\n<b>译文</b>\r\n\r\n333\r${timeline}\n\n<script>literal</script>\n \t\n`;
    const output = serializeSrt(document, [injected, '末行']);
    const result = parseSrt(output);
    expect(result.cues).toHaveLength(2);
    expect(result.cues.map(item => item.number)).toEqual(['9', '2']);
    expect(result.cues.map(item => item.timeline)).toEqual([timeline, timeline]);
    expect(result.cues[0].text).toBe(`<b>译文</b>\n333\n${timeline}\n<script>literal</script>`);
    expect(result.cues[1].text).toBe('末行');
    expect(output.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('requires one translation for every cue and never fills missing entries with source text', () => {
    const document = parseSrt(`${cue()}\n\n${cue(2)}`);
    for (const translations of [[], ['one'], ['one', 'two', 'extra']]) {
      expect(() => serializeSrt(document, translations)).toThrowError(expect.objectContaining({ code: 'translation-count' }));
    }
  });

  it.each([
    ['empty-text', ' \n\r\n\t'], ['nul', 'text\0'], ['invalid-unicode', '\ud800'], ['invalid-unicode', '\udc00'],
  ])('rejects unusable translations: %s', (code, text) => {
    const document = parseSrt(`${cue()}\n\n${cue(2)}`);
    expect(() => serializeSrt(document, ['valid', text])).toThrowError(expect.objectContaining({ code, line: 7, cue: 2 }));
  });

  it('counts translated bytes before blank-line normalization', () => {
    const document = parseSrt(cue());
    const translation = `${'\n'.repeat(SRT_MAX_TRANSLATION_BYTES)}x`;
    expect(() => serializeSrt(document, [translation])).toThrowError(expect.objectContaining({ code: 'translation-size', cue: 1 }));
  });

  it('allows exactly 4 MiB of accumulated UTF-8 translation and rejects one more byte', () => {
    const document = parseSrt(`${cue()}\n\n${cue(2)}`);
    const first = '中'.repeat(699050);
    const second = 'x'.repeat(SRT_MAX_TRANSLATION_BYTES - encoder.encode(first).length);
    const output = serializeSrt(document, [first, second]);
    expect(output).toContain(first);
    expect(output).toContain(second);
    expect(() => serializeSrt(document, [first, `${second}x`])).toThrowError(expect.objectContaining({ code: 'translation-size', cue: 2 }));
  });
});