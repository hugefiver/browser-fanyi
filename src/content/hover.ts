import { fail, type ContentRequest, type Failure, type Grant, type Reply } from '../shared/contracts';

export type HoverTransport = (request: Extract<ContentRequest, { type: 'hover.translate' | 'hover.cancel' }>) => Promise<Reply<string>>;

const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY']);
const interactiveRoles = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'textbox', 'combobox', 'option']);

export function hoverEligible(node: Text, ordinary: (candidate: Text) => boolean): boolean {
  if (!ordinary(node)) return false;
  for (let element = node.parentElement; element; element = element.parentElement) {
    const pageRoot = element === node.ownerDocument.body || element === node.ownerDocument.documentElement;
    if (interactiveTags.has(element.tagName) || !pageRoot && (element.tabIndex >= 0 || typeof element.onclick === 'function'
      || interactiveRoles.has(element.getAttribute('role') ?? ''))) return false;
  }
  return true;
}

export function pointedText(document: Document, x: number, y: number): Text | undefined {
  const api = document as Document & {
    caretPositionFromPoint?: (left: number, top: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (left: number, top: number) => Range | null;
  };
  const position = api.caretPositionFromPoint?.(x, y);
  const fallback = position ? undefined : api.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? fallback?.startContainer;
  const offset = position?.offset ?? fallback?.startOffset;
  if (!(node instanceof document.defaultView!.Text) || offset === undefined || node.length === 0) return;
  for (const index of new Set([Math.min(offset, node.length - 1), Math.max(0, offset - 1)])) {
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    if ([...range.getClientRects()].some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) return node;
  }
}

export class HoverTranslation {
  private grant?: Grant;
  private sequence = 0;
  private current?: { sequence: number; node: Text; source: string };
  private overlay?: HTMLDivElement;
  private readonly observer: MutationObserver;
  enabled = false;

  constructor(private readonly document: Document, private readonly request: HoverTransport,
    private readonly ordinaryEligible: (node: Text) => boolean, private readonly interrupted: (failure: Failure) => void) {
    this.observer = new MutationObserver(() => {
      const current = this.current;
      if (current && (current.node.data !== current.source || !hoverEligible(current.node, this.ordinaryEligible))) this.cancel();
    });
  }

  start(grant: Grant): void {
    this.stop();
    this.sequence = 0;
    this.grant = grant;
    this.enabled = true;
    this.document.addEventListener('click', this.click, true);
    this.document.addEventListener('keydown', this.keydown, true);
  }

  stop(): void {
    this.enabled = false;
    this.grant = undefined;
    ++this.sequence;
    this.current = undefined;
    this.observer.disconnect();
    this.removeOverlay();
    this.document.removeEventListener('click', this.click, true);
    this.document.removeEventListener('keydown', this.keydown, true);
  }

  cancel(): void {
    if (!this.enabled || !this.grant) return;
    const sequence = ++this.sequence;
    this.current = undefined;
    this.observer.disconnect();
    this.removeOverlay();
    void this.request({ type: 'hover.cancel', sessionId: this.grant.sessionId, sequence }).catch(() => undefined);
  }

  async translateTarget(node: Text, x: number, y: number): Promise<void> {
    const grant = this.grant;
    if (!this.enabled || !grant || !hoverEligible(node, this.ordinaryEligible)) return;
    const source = node.data;
    const sourceUrl = this.document.defaultView!.location.href;
    const sequence = ++this.sequence;
    this.current = { sequence, node, source };
    this.observer.disconnect();
    this.observer.observe(this.document, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'style', 'class', 'aria-hidden', 'contenteditable', 'inert', 'open', 'role', 'tabindex'] });
    const overLimit = Array.from(source).length > 2000;
    const output = this.show(source, x, y, overLimit ? '文字超过 2000 个字符，请使用选区翻译。' : '正在翻译…');
    if (overLimit) {
      void this.request({ type: 'hover.cancel', sessionId: grant.sessionId, sequence }).catch(() => undefined);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Reply<string>>(resolve => { timer = setTimeout(() => resolve(fail('timeout')), 30_000); });
    let reply: Reply<string>;
    try {
      reply = await Promise.race([this.request({ type: 'hover.translate', sessionId: grant.sessionId, sequence, text: source }), timeout]);
    } catch { reply = fail('network'); }
    finally { clearTimeout(timer); }
    if (!this.enabled || this.grant !== grant || this.current?.sequence !== sequence) return;
    if (this.document.defaultView!.location.href !== sourceUrl) {
      this.cancel();
      return;
    }
    if (node.data !== source || !hoverEligible(node, this.ordinaryEligible)) return;
    if (!reply.ok && reply.error.code === 'interrupted') {
      this.stop();
      this.interrupted(reply.error);
      return;
    }
    output.textContent = reply.ok ? reply.value : reply.error.message;
  }

  private readonly click = (event: MouseEvent): void => {
    if (!this.enabled || !event.isTrusted || event.button !== 0 || !event.altKey) return;
    const node = pointedText(this.document, event.clientX, event.clientY);
    if (node) void this.translateTarget(node, event.clientX, event.clientY);
  };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.overlay) this.cancel();
  };

  private show(source: string, x: number, y: number, initial: string): HTMLDivElement {
    this.removeOverlay();
    const root = this.document.createElement('div');
    root.setAttribute('data-browser-fanyi', 'hover');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '指向翻译');
    Object.assign(root.style, { position: 'fixed', zIndex: '2147483647', left: `${Math.max(8, Math.min(x + 12, innerWidth - 340))}px`,
      top: `${Math.max(8, Math.min(y + 12, innerHeight - 220))}px`, width: '320px', maxHeight: '200px', overflow: 'auto',
      padding: '12px', color: '#202124', background: '#ffffff', border: '1px solid #dadce0', borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0,0,0,.2)', font: '14px/1.5 Arial,sans-serif', textAlign: 'start' });
    const close = this.document.createElement('button');
    close.type = 'button'; close.textContent = '关闭'; close.setAttribute('aria-label', '关闭指向翻译');
    Object.assign(close.style, { float: 'right', marginInlineStart: '8px' });
    close.addEventListener('click', () => this.cancel());
    const original = this.document.createElement('div');
    original.textContent = source; Object.assign(original.style, { whiteSpace: 'pre-wrap', marginBottom: '8px' });
    const output = this.document.createElement('div');
    output.textContent = initial; output.setAttribute('aria-live', 'polite');
    root.append(close, original, output);
    this.document.documentElement.append(root);
    this.overlay = root;
    return output;
  }

  private removeOverlay(): void { this.overlay?.remove(); this.overlay = undefined; }
}
