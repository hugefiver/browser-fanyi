export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
}

export interface CapturePageSnapshot {
  viewport: CaptureViewport;
  url: string;
}

export interface CaptureRegionSelection extends CapturePageSnapshot {
  rect: CaptureRect;
}

export type CaptureRegionFailureReason =
  | 'busy'
  | 'cancelled'
  | 'escape'
  | 'viewport-changed'
  | 'url-changed'
  | 'empty-area';

export type CaptureRegionResult =
  | { ok: true; value: CaptureRegionSelection }
  | { ok: false; reason: CaptureRegionFailureReason };

interface PendingSelection {
  page: CapturePageSnapshot;
  resolve(result: CaptureRegionResult): void;
  pointerId?: number;
  start?: { x: number; y: number };
}

function setImportantStyles(element: HTMLElement, styles: Record<string, string>): void {
  for (const [property, value] of Object.entries(styles)) element.style.setProperty(property, value, 'important');
}

function clamp(value: number, maximum: number): number {
  return Math.max(0, Math.min(value, maximum));
}

function selectionRect(start: { x: number; y: number }, end: { x: number; y: number }): CaptureRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return { x, y, width: Math.max(start.x, end.x) - x, height: Math.max(start.y, end.y) - y };
}

function sameViewport(left: CaptureViewport, right: CaptureViewport): boolean {
  return left.width === right.width && left.height === right.height
    && left.scrollX === right.scrollX && left.scrollY === right.scrollY && left.dpr === right.dpr;
}

export function capturePageSnapshot(document: Document = globalThis.document): CapturePageSnapshot {
  const view = document.defaultView;
  if (!view) throw new Error('Capture requires a window-backed document');
  return {
    viewport: {
      width: view.innerWidth,
      height: view.innerHeight,
      scrollX: view.scrollX,
      scrollY: view.scrollY,
      dpr: view.devicePixelRatio,
    },
    url: view.location.href,
  };
}

export class CaptureRegion {
  private readonly document: Document;
  private readonly view: Window;
  private pending?: PendingSelection;
  private overlay?: HTMLDivElement;
  private selectionBox?: HTMLDivElement;
  private urlTimer?: number;

  constructor(document: Document = globalThis.document) {
    const view = document.defaultView;
    if (!view) throw new Error('Capture requires a window-backed document');
    this.document = document;
    this.view = view;
  }

  start(): Promise<CaptureRegionResult> {
    if (this.pending) return Promise.resolve({ ok: false, reason: 'busy' });
    const page = capturePageSnapshot(this.document);
    return new Promise(resolve => {
      this.pending = { page, resolve };
      this.mountOverlay();
      this.listen();
    });
  }

  cancel(reason: CaptureRegionFailureReason = 'cancelled'): void {
    if (this.pending) this.finish({ ok: false, reason });
  }

  destroy(): void {
    this.cancel();
  }

  private mountOverlay(): void {
    const overlay = this.document.createElement('div');
    overlay.setAttribute('data-browser-fanyi', 'capture-region');
    overlay.setAttribute('role', 'application');
    overlay.setAttribute('aria-label', '拖动选择截图区域，按 Escape 取消');
    overlay.tabIndex = -1;
    setImportantStyles(overlay, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      display: 'block',
      'z-index': '2147483647',
      cursor: 'crosshair',
      'user-select': 'none',
      'touch-action': 'none',
      'pointer-events': 'auto',
      background: 'rgba(0, 0, 0, 0.18)',
    });

    const shadow = overlay.attachShadow({ mode: 'closed' });
    const selection = this.document.createElement('div');
    selection.setAttribute('aria-hidden', 'true');
    setImportantStyles(selection, {
      position: 'fixed',
      display: 'none',
      'box-sizing': 'border-box',
      border: '2px solid #1a73e8',
      background: 'rgba(26, 115, 232, 0.16)',
      'pointer-events': 'none',
    });
    shadow.append(selection);
    this.document.documentElement.append(overlay);
    this.overlay = overlay;
    this.selectionBox = selection;
  }

  private listen(): void {
    const overlay = this.overlay!;
    overlay.addEventListener('pointerdown', this.pointerDown, true);
    overlay.addEventListener('pointermove', this.pointerMove, true);
    overlay.addEventListener('pointerup', this.pointerUp, true);
    overlay.addEventListener('pointercancel', this.pointerCancel, true);
    overlay.addEventListener('contextmenu', this.contextMenu, true);
    this.document.addEventListener('keydown', this.keyDown, true);
    this.document.addEventListener('scroll', this.viewportChanged, true);
    this.view.addEventListener('resize', this.viewportChanged);
    this.view.addEventListener('popstate', this.urlChanged);
    this.view.addEventListener('hashchange', this.urlChanged);
    this.urlTimer = this.view.setInterval(this.urlChanged, 50);
  }

  private unlisten(): void {
    const overlay = this.overlay;
    overlay?.removeEventListener('pointerdown', this.pointerDown, true);
    overlay?.removeEventListener('pointermove', this.pointerMove, true);
    overlay?.removeEventListener('pointerup', this.pointerUp, true);
    overlay?.removeEventListener('pointercancel', this.pointerCancel, true);
    overlay?.removeEventListener('contextmenu', this.contextMenu, true);
    this.document.removeEventListener('keydown', this.keyDown, true);
    this.document.removeEventListener('scroll', this.viewportChanged, true);
    this.view.removeEventListener('resize', this.viewportChanged);
    this.view.removeEventListener('popstate', this.urlChanged);
    this.view.removeEventListener('hashchange', this.urlChanged);
    if (this.urlTimer !== undefined) this.view.clearInterval(this.urlTimer);
    this.urlTimer = undefined;
  }

  private finish(result: CaptureRegionResult): void {
    const pending = this.pending;
    if (!pending) return;
    this.unlisten();
    this.overlay?.remove();
    this.overlay = undefined;
    this.selectionBox = undefined;
    this.pending = undefined;
    pending.resolve(result);
  }

  private currentFailure(): Extract<CaptureRegionFailureReason, 'viewport-changed' | 'url-changed'> | undefined {
    const pending = this.pending;
    if (!pending) return;
    const current = capturePageSnapshot(this.document);
    if (current.url !== pending.page.url) return 'url-changed';
    if (!sameViewport(current.viewport, pending.page.viewport)) return 'viewport-changed';
  }

  private point(event: PointerEvent): { x: number; y: number } {
    const viewport = this.pending!.page.viewport;
    return { x: clamp(event.clientX, viewport.width), y: clamp(event.clientY, viewport.height) };
  }

  private draw(end: { x: number; y: number }): CaptureRect {
    const rect = selectionRect(this.pending!.start!, end);
    const selection = this.selectionBox!;
    setImportantStyles(selection, {
      display: 'block',
      transform: `translate(${rect.x}px, ${rect.y}px)`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    return rect;
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0 || !this.pending || this.pending.pointerId !== undefined) return;
    const failure = this.currentFailure();
    if (failure) {
      this.cancel(failure);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.pending.pointerId = event.pointerId;
    this.pending.start = this.point(event);
    try { this.overlay?.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional in older engines. */ }
    this.draw(this.pending.start);
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    if (!event.isTrusted || !this.pending || event.pointerId !== this.pending.pointerId) return;
    const failure = this.currentFailure();
    if (failure) {
      this.cancel(failure);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.draw(this.point(event));
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    if (!event.isTrusted || !this.pending || event.pointerId !== this.pending.pointerId) return;
    const failure = this.currentFailure();
    if (failure) {
      this.cancel(failure);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = this.draw(this.point(event));
    if (rect.width <= 0 || rect.height <= 0) {
      this.cancel('empty-area');
      return;
    }
    const page = this.pending.page;
    this.finish({
      ok: true,
      value: { rect: { ...rect }, viewport: { ...page.viewport }, url: page.url },
    });
  };

  private readonly pointerCancel = (event: PointerEvent): void => {
    if (this.pending && event.pointerId === this.pending.pointerId) this.cancel();
  };

  private readonly contextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.pending) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.cancel('escape');
  };

  private readonly viewportChanged = (): void => {
    this.cancel('viewport-changed');
  };

  private readonly urlChanged = (): void => {
    if (this.currentFailure() === 'url-changed') this.cancel('url-changed');
  };
}
