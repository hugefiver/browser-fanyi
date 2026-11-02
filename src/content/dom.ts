import type { DisplayMode, Failure } from '../shared/contracts';

export interface Piece {
  source: string;
  phase: 'pending' | 'running' | 'complete' | 'failed';
  result?: string;
  error?: Failure;
}
export interface TextEntry {
  node: Text;
  source: string;
  lastWritten?: string;
  translation?: HTMLSpanElement;
  pieces: Piece[];
}
const marker = 'data-browser-fanyi';
const excluded = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'DATALIST', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'SVG', 'MATH', 'HEAD']);

export class PageText {
  readonly entries = new Map<Text, TextEntry>();
  private readonly observer: MutationObserver;
  private observing = false;
  private scanVersion = 0;

  constructor(private readonly document: Document, private readonly changed: () => void) {
    this.observer = new MutationObserver(records => this.process(records));
  }

  observe(): void {
    if (this.observing) return;
    this.observing = true;
    this.observer.observe(this.document, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['hidden', 'style', 'class', 'aria-hidden', 'contenteditable', 'inert', 'open'],
    });
  }

  flush(): void {
    this.process(this.observer.takeRecords());
  }

  eligible(node: Text): boolean {
    if (this.document.designMode === 'on' || !node.isConnected || !node.data.trim() || !this.document.body?.contains(node)) return false;
    for (let element = node.parentElement; element; element = element.parentElement) {
      if (excluded.has(element.tagName.toUpperCase()) || element.hasAttribute(marker) || element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true') return false;
      const editable = element.getAttribute('contenteditable');
      if (editable !== null && editable !== 'false') return false;
      const style = this.document.defaultView!.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return false;
      if (element.tagName === 'DETAILS' && !element.hasAttribute('open') && !element.querySelector('summary')?.contains(node)) return false;
    }
    return true;
  }

  async scan(): Promise<void> {
    const version = ++this.scanVersion;
    this.flush();
    const body = this.document.body;
    if (!body) return;
    const walker = this.document.createTreeWalker(body, 4);
    let visited = 0;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (version !== this.scanVersion) return;
      const node = current as Text;
      if (!this.entries.has(node) && this.eligible(node)) {
        const characters = Array.from(node.data);
        const pieces: Piece[] = [];
        for (let offset = 0; offset < characters.length; offset += 2000) {
          const source = characters.slice(offset, offset + 2000).join('');
          pieces.push(source.trim() ? { source, phase: 'pending' } : { source, phase: 'complete', result: source });
        }
        this.entries.set(node, { node, source: node.data, pieces });
      }
      if (++visited % 100 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  show(entry: TextEntry, mode: DisplayMode): void {
    this.flush();
    if (!this.entries.has(entry.node) || !this.eligible(entry.node) || entry.pieces.some(piece => piece.phase !== 'complete')) return;
    const text = entry.pieces.map(piece => piece.result).join('');
    this.write(() => {
      if (entry.lastWritten !== undefined && entry.node.data === entry.lastWritten) entry.node.data = entry.source;
      entry.lastWritten = undefined;
      entry.translation?.remove();
      entry.translation = undefined;
      if (mode === 'translation') {
        entry.node.data = text;
        entry.lastWritten = text;
      } else {
        const span = this.document.createElement('span');
        span.setAttribute(marker, 'translation');
        span.textContent = text;
        span.style.whiteSpace = 'pre-wrap';
        span.style.marginInlineStart = '0.4em';
        entry.node.after(span);
        entry.translation = span;
      }
    });
  }

  clear(): void {
    ++this.scanVersion;
    this.flush();
    for (const entry of this.entries.values()) this.remove(entry);
    this.entries.clear();
  }

  disconnect(): void {
    this.observer.disconnect();
    this.observing = false;
    ++this.scanVersion;
  }

  private write(change: () => void): void {
    this.flush();
    change();
    // Pending website records are processed before the write; these records are ours.
    this.observer.takeRecords();
  }

  remove(entry: TextEntry, websiteChanged = false): void {
    this.write(() => {
      entry.translation?.remove();
      if (!websiteChanged && entry.lastWritten !== undefined && entry.node.data === entry.lastWritten) entry.node.data = entry.source;
    });
    this.entries.delete(entry.node);
  }

  private process(records: MutationRecord[]): void {
    if (!records.length) return;
    const changedText = new Set(records.filter(record => record.type === 'characterData').map(record => record.target));
    for (const entry of this.entries.values()) {
      if (changedText.has(entry.node)) this.remove(entry, true);
      else if (!entry.node.isConnected || !this.eligible(entry.node)) this.remove(entry);
      else if (entry.translation && entry.node.nextSibling !== entry.translation) {
        const span = entry.translation;
        this.write(() => entry.node.after(span));
      }
    }
    this.changed();
  }
}
