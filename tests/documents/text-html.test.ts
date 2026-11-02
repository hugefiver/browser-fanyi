import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_MAX_BYTES, parseTextDocument, readTextDocument, exportTextDocument, downloadTextDocument,
} from '../../src/documents/text-html';

const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (text: string, name = 'private.txt') => parseTextDocument(name, bytes(text));
const blobText = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = reject;
  reader.readAsText(blob);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('local UTF-8 document boundary', () => {
  it('accepts BOM, a supplied byte view, case-insensitive extensions, and real local files', async () => {
    const input = bytes('x\uFEFF第一段😀\r\n\r\nSecondy');
    const source = parseTextDocument('private.TXT', input.subarray(1, -1));
    expect(source.segments.map(segment => segment.source)).toEqual(['第一段😀', 'Second']);
    const loaded = await readTextDocument(new File([bytes('本地原文')], 'local.txt'));
    expect(loaded.segments).toEqual([{ id: 0, source: '本地原文' }]);
  });

  it.each([
    [0xc0, 0xaf], [0xe2, 0x82], [0xff], [0x80], [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80], [0xff, 0xfe, 0x31, 0x00],
  ])('rejects malformed UTF-8 %j', (...input) => {
    expect(() => parseTextDocument('x.txt', new Uint8Array(input))).toThrow(/UTF-8/);
  });

  it('accepts exactly 1 MiB and rejects excess bytes before parsing', async () => {
    expect(parseTextDocument('x.txt', bytes('x'.repeat(DOCUMENT_MAX_BYTES))).segments.length).toBeGreaterThan(100);
    expect(() => parseTextDocument('x.txt', new Uint8Array(DOCUMENT_MAX_BYTES + 1))).toThrow(/1 MiB/);
    await expect(readTextDocument(new File([new Uint8Array(DOCUMENT_MAX_BYTES + 1)], 'x.txt'))).rejects.toThrow(/1 MiB/);
    expect(() => parse('中'.repeat(Math.ceil(DOCUMENT_MAX_BYTES / 3)))).toThrow(/1 MiB/);
  });

  it('rejects unsupported and empty reading content', () => {
    expect(() => parse('plain', 'x.pdf')).toThrow(/TXT/);
    expect(() => parse(' \n\t')).toThrow(/阅读文本/);
    expect(() => parse('<script>secret</script><form>draft</form>', 'x.htm')).toThrow(/阅读文本/);
  });

  it('splits by 2000 Unicode code points without dropping newlines or surrogate pairs', async () => {
    const text = `${'😀'.repeat(2001)}\r\n\n最后`;
    const source = parse(text);
    expect(source.segments.map(segment => Array.from(segment.source).length)).toEqual([2000, 1, 2]);
    const translations = new Map(source.segments.map(segment => [segment.id, segment.source]));
    expect(await blobText(exportTextDocument(source, translations, { format: 'txt', mode: 'translation' }).blob)).toBe(text);
  });
});

describe('inert HTML parsing and independent reading structure', () => {
  it('retains paragraphs, headings, lists, tables and inline reading elements without attributes', async () => {
    const source = parse('<h1 id="title">Heading</h1><p class="x">A <em>word</em><br><code>code</code></p>'
      + '<ul><li>Item</li></ul><table><tr><th>Column</th><td>Cell</td></tr></table>', 'private.HTM');
    const translations = new Map(source.segments.map(segment => [segment.id, segment.source]));
    const output = await blobText(exportTextDocument(source, translations, { format: 'html', mode: 'translation' }).blob);
    const template = document.createElement('template');
    template.innerHTML = output;
    expect(template.content.querySelector('h1')?.textContent).toBe('Heading');
    expect(template.content.querySelector('p em')?.textContent).toBe('word');
    expect(template.content.querySelector('p br')).not.toBeNull();
    expect(template.content.querySelector('p code')?.textContent).toBe('code');
    expect(template.content.querySelector('ul li')?.textContent).toBe('Item');
    expect(template.content.querySelector('table th')?.textContent).toBe('Column');
    expect(template.content.querySelector('table td')?.textContent).toBe('Cell');
    expect(template.content.querySelector('h1')?.attributes.length).toBe(0);
    expect(template.content.querySelector('p')?.attributes.length).toBe(0);
    const plain = await blobText(exportTextDocument(source, translations, { format: 'txt', mode: 'translation' }).blob);
    expect(plain).toContain('Heading\n');
    expect(plain).toContain('Column\tCell\t\n');
  });

  it('keeps raw resource nodes inert and strips dangerous subtrees, URLs, events and custom elements', async () => {
    const upgraded = vi.fn();
    customElements.define('document-probe', class extends HTMLElement { constructor() { super(); upgraded(); } });
    const before = document.body.innerHTML;
    const source = parse('<base href="https://remote.invalid/"><link rel="stylesheet" href="x"><style>private-style</style>'
      + '<script>private-script</script><iframe src="x">private-frame</iframe><form>private-form<input value="secret"></form>'
      + '<svg><text>private-svg</text></svg><math><mi>private-math</mi></math>'
      + '<img src="https://remote.invalid/image" onerror="alert(1)"><video src="x">private-video</video>'
      + '<document-probe><p onclick="alert(1)" style="background:url(x)" data-secret="secret">Readable '
      + '<a href="https://remote.invalid/private">link label</a></p></document-probe>', 'x.html');
    expect(upgraded).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toBe(before);
    expect(source.segments.map(segment => segment.source)).toEqual(['Readable ', 'link label']);
    const output = await blobText(exportTextDocument(source, new Map(), { format: 'html', mode: 'translation' }).blob);
    const template = document.createElement('template');
    template.innerHTML = output;
    expect(template.content.querySelector('script,style,iframe,form,input,svg,math,img,video,link,base,a,document-probe,[onclick],[style],[data-secret],[src],[href]')).toBeNull();
    expect(template.content.querySelector('p')?.textContent).toContain('Readable');
  });
});

describe('safe, useful document exports', () => {
  it('exports successful translations and explicitly retains original failed/pending text in either mode', async () => {
    const source = parse('First\nSecond\nThird');
    const translated = new Map([[0, '第一']]);
    const translation = await blobText(exportTextDocument(source, translated, { format: 'txt', mode: 'translation' }).blob);
    expect(translation).toBe('第一\n[未译原文 · 第 2 段] Second\n[未译原文 · 第 3 段] Third');
    const bilingual = await blobText(exportTextDocument(source, translated, { format: 'txt', mode: 'bilingual' }).blob);
    expect(bilingual).toContain('First\n[译文] 第一');
    expect(bilingual).toContain('[未译原文 · 第 2 段] Second');
  });

  it('escapes source and service HTML as text and locks downloaded HTML against execution and network access', async () => {
    const source = parse('<script>alert("source")</script>\nsecond');
    const payload = '<img src="https://remote.invalid/x" onerror="alert(1)"><script>alert(2)</script>&';
    const output = exportTextDocument(source, new Map([[0, payload]]), { format: 'html', mode: 'bilingual' });
    expect(output.blob.type).toBe('text/html;charset=utf-8');
    const template = document.createElement('template');
    template.innerHTML = await blobText(output.blob);
    expect(template.content.querySelector('script,img')).toBeNull();
    expect(template.content.querySelector('pre')?.textContent).toContain(payload);
    const csp = template.content.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('downloads a real Blob with a local object URL and releases it after the click', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:local-document');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const output = exportTextDocument(parse('original'), new Map([[0, 'translated']]), { format: 'txt', mode: 'translation' });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe('translated-document.txt');
      expect(this.href).toBe('blob:local-document');
    });
    downloadTextDocument(output);
    expect(createObjectURL).toHaveBeenCalledWith(output.blob);
    expect(output.blob).toBeInstanceOf(Blob);
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-document');
  });
});
