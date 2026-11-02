export const DOCUMENT_MAX_BYTES = 1024 * 1024;
export const DOCUMENT_SEGMENT_CODE_POINTS = 2000;
export const DOCUMENT_ROUND_SEGMENTS = 100;

const safeTags = [
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'blockquote', 'pre',
  'code', 'strong', 'em', 'b', 'i', 's', 'u', 'small', 'sub', 'sup', 'br', 'hr', 'span',
] as const;
export type DocumentTag = typeof safeTags[number];
export type DocumentNode =
  | { kind: 'text'; text: string; segmentId?: number }
  | { kind: 'element'; tag: DocumentTag; children: DocumentNode[] };
export interface DocumentSegment { id: number; source: string }
export interface TextDocument {
  format: 'txt' | 'html';
  nodes: DocumentNode[];
  segments: DocumentSegment[];
}
export type DocumentTranslations = ReadonlyMap<number, string>;
export interface DocumentExportOptions { format: 'txt' | 'html'; mode: 'translation' | 'bilingual' }
export interface DocumentExport { blob: Blob; extension: 'txt' | 'html' }

const allowedTags = new Set<string>(safeTags);
const discardedTags = new Set([
  'script', 'style', 'head', 'title', 'meta', 'link', 'base', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'img', 'picture', 'audio', 'video', 'source', 'track', 'canvas', 'svg',
  'math', 'form', 'input', 'button', 'textarea', 'select', 'option', 'template', 'noscript',
]);
const blockTags = new Set<string>([
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'blockquote', 'pre', 'hr',
]);

export function parseTextDocument(name: string, input: ArrayBuffer | Uint8Array): TextDocument {
  const extension = name.split('.').pop()?.toLowerCase();
  if (!['txt', 'html', 'htm'].includes(extension ?? '')) throw new Error('仅支持 TXT、HTML 或 HTM 文件。');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) throw new Error('文件不能超过 1 MiB。');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('文件必须是有效 UTF-8 编码，可包含 BOM。'); }
  const result: TextDocument = { format: extension === 'txt' ? 'txt' : 'html', nodes: [], segments: [] };
  const appendText = (value: string, target: DocumentNode[]) => {
    if (!value.trim()) { target.push({ kind: 'text', text: value }); return; }
    const points = Array.from(value);
    for (let offset = 0; offset < points.length; offset += DOCUMENT_SEGMENT_CODE_POINTS) {
      const source = points.slice(offset, offset + DOCUMENT_SEGMENT_CODE_POINTS).join('');
      if (!source.trim()) { target.push({ kind: 'text', text: source }); continue; }
      const id = result.segments.length;
      result.segments.push({ id, source });
      target.push({ kind: 'text', text: source, segmentId: id });
    }
  };
  if (result.format === 'txt') {
    for (const line of text.split(/(\r\n|\n|\r)/u)) appendText(line, result.nodes);
  } else {
    // Template contents have an inert owner document: no resource loading or custom-element upgrades.
    const template = document.createElement('template');
    template.innerHTML = text;
    const stack = [{ children: Array.from(template.content.childNodes), target: result.nodes, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const node = frame.children[frame.index++];
      if (!node) { stack.pop(); continue; }
      if (node.nodeType === 3) { appendText(node.textContent ?? '', frame.target); continue; }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tag = element.localName.toLowerCase();
      if (discardedTags.has(tag) || element.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      let target = frame.target;
      if (allowedTags.has(tag)) {
        const safe: DocumentNode = { kind: 'element', tag: tag as DocumentTag, children: [] };
        frame.target.push(safe);
        target = safe.children;
      }
      stack.push({ children: Array.from(element.childNodes), target, index: 0 });
    }
  }
  if (!result.segments.length) throw new Error('文件中没有可翻译的阅读文本。');
  return result;
}

export function readTextDocument(file: File): Promise<TextDocument> {
  if (file.size > DOCUMENT_MAX_BYTES) return Promise.reject(new Error('文件不能超过 1 MiB。'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取本地文件，请重新选择。'));
    reader.onload = () => {
      try {
        if (!(reader.result instanceof ArrayBuffer)) throw new Error('无法读取本地文件。');
        resolve(parseTextDocument(file.name, reader.result));
      } catch (error) { reject(error); }
    };
    reader.readAsArrayBuffer(file);
  });
}

export function documentSegmentText(
  node: Extract<DocumentNode, { kind: 'text' }>, translations: DocumentTranslations,
  mode: DocumentExportOptions['mode'],
): string {
  if (node.segmentId === undefined) return node.text;
  const translated = translations.get(node.segmentId);
  if (translated === undefined) return `[未译原文 · 第 ${node.segmentId + 1} 段] ${node.text}`;
  return mode === 'bilingual' ? `${node.text}\n[译文] ${translated}` : translated;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);

export function exportTextDocument(
  source: TextDocument, translations: DocumentTranslations, options: DocumentExportOptions,
): DocumentExport {
  const output: string[] = [];
  const stack: Array<{ node: DocumentNode; closing?: boolean }> = source.nodes.slice().reverse().map(node => ({ node }));
  while (stack.length) {
    const { node, closing } = stack.pop()!;
    if (node.kind === 'text') {
      const text = documentSegmentText(node, translations, options.mode);
      output.push(options.format === 'html' ? escapeHtml(text) : text);
      continue;
    }
    if (options.format === 'html') {
      if (node.tag === 'br' || node.tag === 'hr') { output.push(`<${node.tag}>`); continue; }
      output.push(closing ? `</${node.tag}>` : `<${node.tag}>`);
    } else if (closing) {
      if (blockTags.has(node.tag)) output.push('\n');
      if (node.tag === 'td' || node.tag === 'th') output.push('\t');
    } else if (node.tag === 'br' || node.tag === 'hr') output.push('\n');
    if (!closing) {
      stack.push({ node, closing: true });
      for (let index = node.children.length - 1; index >= 0; index--) stack.push({ node: node.children[index] });
    }
  }
  let text = output.join('');
  if (options.format === 'html') {
    if (source.format === 'txt') text = `<pre>${text}</pre>`;
    // This policy also protects the downloaded document when opened outside the extension.
    text = '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'">'
      + `<title>翻译文档</title></head><body>${text}</body></html>`;
  }
  return { blob: new Blob([text], { type: options.format === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8' }), extension: options.format };
}

export function downloadTextDocument(output: DocumentExport): void {
  const url = URL.createObjectURL(output.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `translated-document.${output.extension}`;
  anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    // Keep the URL alive until the browser has consumed the download navigation.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
