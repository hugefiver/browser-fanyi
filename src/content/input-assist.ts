export type InputAssistTargetKind = 'input' | 'textarea' | 'contenteditable';

export interface InputAssistSelection {
  start: number;
  end: number;
  direction: HTMLInputElement['selectionDirection'];
}

export interface InputAssistCapture {
  id: string;
  instanceId: string;
  kind: InputAssistTargetKind;
  url: string;
  originalValue: string;
  selectedText: string;
  sourceText: string;
  selection: InputAssistSelection | null;
  canApply: boolean;
}

export type InputAssistFailureReason =
  | 'not-found'
  | 'invalidated'
  | 'cannot-apply'
  | 'composing'
  | 'target-changed'
  | 'document-changed'
  | 'url-changed'
  | 'value-changed'
  | 'selection-changed'
  | 'site-rejected'
  | 'not-applied'
  | 'user-changed';

export type InputAssistResult =
  | { ok: true; value: string }
  | { ok: false; reason: InputAssistFailureReason };

type WritableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

interface CaptureRecord {
  snapshot: InputAssistCapture;
  target: WritableTarget;
  document: Document;
  replacementStart: number;
  replacementEnd: number;
  valid: boolean;
  appliedValue?: string;
}

interface CapturableTarget {
  target: WritableTarget;
  kind: InputAssistTargetKind;
  canApply: boolean;
}

interface ContentSelection {
  selection: InputAssistSelection | null;
  selectedText: string;
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url']);
const BLOCKED_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'transaction-amount',
  'transaction-currency',
]);

export class InputAssist {
  readonly instanceId: string;

  private readonly document: Document;
  private readonly records = new Map<string, CaptureRecord>();
  private lastFocused: Element | null = null;
  private sequence = 0;
  private composing = false;
  private destroyed = false;

  private readonly handleFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof this.document.defaultView!.Element) {
      this.lastFocused = event.target;
    }
  };

  private readonly handleCompositionStart = (): void => {
    this.composing = true;
  };

  private readonly handleCompositionEnd = (): void => {
    this.composing = false;
  };

  constructor(document: Document = globalThis.document) {
    this.document = document;
    this.lastFocused = document.activeElement;
    this.instanceId = globalThis.crypto.randomUUID();
    document.addEventListener('focusin', this.handleFocusIn, true);
    document.addEventListener('compositionstart', this.handleCompositionStart, true);
    document.addEventListener('compositionend', this.handleCompositionEnd, true);
  }

  capture(): InputAssistCapture | null {
    if (this.destroyed || this.composing || !this.lastFocused) return null;

    const capturable = resolveTarget(this.document, this.lastFocused);
    if (!capturable || !capturable.target.isConnected || isHidden(capturable.target)) return null;

    const originalValue = readValue(capturable.target, capturable.kind);
    const contentSelection = readSelection(capturable.target, capturable.kind);
    const selectedText = contentSelection.selectedText;
    const start = contentSelection.selection?.start ?? 0;
    const end = contentSelection.selection?.end ?? 0;
    const useWholeField = start === end;
    const id = `${this.instanceId}:${++this.sequence}`;
    const snapshot: InputAssistCapture = {
      id,
      instanceId: this.instanceId,
      kind: capturable.kind,
      url: this.document.URL,
      originalValue,
      selectedText,
      sourceText: useWholeField ? originalValue : selectedText,
      selection: contentSelection.selection,
      canApply: capturable.canApply,
    };

    this.records.set(id, {
      snapshot,
      target: capturable.target,
      document: this.document,
      replacementStart: useWholeField ? 0 : start,
      replacementEnd: useWholeField ? originalValue.length : end,
      valid: true,
    });
    return snapshot;
  }

  apply(id: string, text: string): InputAssistResult {
    const record = this.records.get(id);
    if (!record) return { ok: false, reason: 'not-found' };
    const failure = this.validateForApply(record);
    if (failure) return failure;

    const { originalValue } = record.snapshot;
    const nextValue =
      originalValue.slice(0, record.replacementStart) +
      text +
      originalValue.slice(record.replacementEnd);

    writeValue(record.target, record.snapshot.kind, nextValue);
    dispatchInput(record.document, record.target);
    if (readValue(record.target, record.snapshot.kind) !== nextValue) {
      record.valid = false;
      return { ok: false, reason: 'site-rejected' };
    }

    record.appliedValue = nextValue;
    return { ok: true, value: nextValue };
  }

  restore(id: string): InputAssistResult {
    const record = this.records.get(id);
    if (!record) return { ok: false, reason: 'not-found' };
    if (!record.valid) return { ok: false, reason: 'invalidated' };
    if (!record.snapshot.canApply) return { ok: false, reason: 'cannot-apply' };
    if (this.composing) return { ok: false, reason: 'composing' };
    if (record.appliedValue === undefined) return { ok: false, reason: 'not-applied' };

    const identityFailure = this.validateIdentity(record);
    if (identityFailure) return identityFailure;
    if (readValue(record.target, record.snapshot.kind) !== record.appliedValue) {
      return { ok: false, reason: 'user-changed' };
    }

    writeValue(record.target, record.snapshot.kind, record.snapshot.originalValue);
    dispatchInput(record.document, record.target);
    if (readValue(record.target, record.snapshot.kind) !== record.snapshot.originalValue) {
      record.valid = false;
      return { ok: false, reason: 'site-rejected' };
    }

    record.valid = false;
    return { ok: true, value: record.snapshot.originalValue };
  }

  private validateForApply(record: CaptureRecord): InputAssistResult | null {
    if (!record.valid) return { ok: false, reason: 'invalidated' };
    if (!record.snapshot.canApply) return { ok: false, reason: 'cannot-apply' };
    if (this.composing) return { ok: false, reason: 'composing' };

    const identityFailure = this.validateIdentity(record);
    if (identityFailure) return identityFailure;
    if (readValue(record.target, record.snapshot.kind) !== record.snapshot.originalValue) {
      return { ok: false, reason: 'value-changed' };
    }
    if (!sameSelection(readSelection(record.target, record.snapshot.kind).selection, record.snapshot.selection)) {
      return { ok: false, reason: 'selection-changed' };
    }
    return null;
  }

  private validateIdentity(record: CaptureRecord): InputAssistResult | null {
    if (record.document !== this.document || record.target.ownerDocument !== record.document) {
      return { ok: false, reason: 'document-changed' };
    }
    if (!record.target.isConnected) return { ok: false, reason: 'target-changed' };
    const current = resolveTarget(this.document, record.target);
    if (!current || current.target !== record.target || current.kind !== record.snapshot.kind
      || !current.canApply || isHidden(record.target)) return { ok: false, reason: 'target-changed' };
    if (record.document.URL !== record.snapshot.url) return { ok: false, reason: 'url-changed' };
    return null;
  }

  invalidate(id?: string): void {
    if (id === undefined) {
      for (const record of this.records.values()) record.valid = false;
      return;
    }
    const record = this.records.get(id);
    if (record) record.valid = false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.invalidate();
    this.document.removeEventListener('focusin', this.handleFocusIn, true);
    this.document.removeEventListener('compositionstart', this.handleCompositionStart, true);
    this.document.removeEventListener('compositionend', this.handleCompositionEnd, true);
  }
}

function resolveTarget(document: Document, focused: Element): CapturableTarget | null {
  const view = document.defaultView;
  if (!view) return null;

  if (focused instanceof view.HTMLTextAreaElement) {
    if (focused.matches(':disabled') || focused.readOnly || hasSensitiveAutocomplete(focused.autocomplete)) return null;
    return { target: focused, kind: 'textarea', canApply: true };
  }

  if (focused instanceof view.HTMLInputElement) {
    if (
      focused.matches(':disabled') ||
      focused.readOnly ||
      !TEXT_INPUT_TYPES.has(focused.type) ||
      hasSensitiveAutocomplete(focused.autocomplete)
    ) {
      return null;
    }
    return { target: focused, kind: 'input', canApply: true };
  }

  const editable = findContentEditable(focused);
  if (!editable || editable.getAttribute('aria-disabled') === 'true' || editable.getAttribute('aria-readonly') === 'true') {
    return null;
  }
  return {
    target: editable,
    kind: 'contenteditable',
    canApply: Array.from(editable.childNodes).every((node) => node.nodeType === view.Node.TEXT_NODE),
  };
}

function hasSensitiveAutocomplete(autocomplete: string): boolean {
  return autocomplete
    .toLowerCase()
    .split(/\s+/)
    .some((token) => token.startsWith('cc-') || BLOCKED_AUTOCOMPLETE.has(token));
}

function findContentEditable(element: Element): HTMLElement | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const value = current.getAttribute('contenteditable');
    if (value === null) continue;
    const normalized = value.toLowerCase();
    if (normalized === '' || normalized === 'true' || normalized === 'plaintext-only') {
      return current as HTMLElement;
    }
    return null;
  }
  return null;
}

function isHidden(target: HTMLElement): boolean {
  const view = target.ownerDocument.defaultView;
  if (!view) return true;
  for (let current: HTMLElement | null = target; current; current = current.parentElement) {
    if (current.hidden) return true;
    const style = view.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
  }
  return false;
}

function readValue(target: WritableTarget, kind: InputAssistTargetKind): string {
  return kind === 'contenteditable'
    ? target.textContent ?? ''
    : (target as HTMLInputElement | HTMLTextAreaElement).value;
}

function readSelection(target: WritableTarget, kind: InputAssistTargetKind): ContentSelection {
  if (kind !== 'contenteditable') {
    const field = target as HTMLInputElement | HTMLTextAreaElement;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    if (start === null || end === null) return { selection: null, selectedText: '' };
    return {
      selection: { start, end, direction: field.selectionDirection },
      selectedText: field.value.slice(start, end),
    };
  }

  const selection = target.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return { selection: null, selectedText: '' };
  const range = selection.getRangeAt(0);
  if (!target.contains(range.startContainer) || !target.contains(range.endContainer)) {
    return { selection: null, selectedText: '' };
  }

  const startRange = range.cloneRange();
  startRange.selectNodeContents(target);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = range.cloneRange();
  endRange.selectNodeContents(target);
  endRange.setEnd(range.endContainer, range.endOffset);
  return {
    selection: { start: startRange.toString().length, end: endRange.toString().length, direction: null },
    selectedText: range.toString(),
  };
}

function sameSelection(current: InputAssistSelection | null, captured: InputAssistSelection | null): boolean {
  if (current === null || captured === null) return current === captured;
  return current.start === captured.start && current.end === captured.end && current.direction === captured.direction;
}

function writeValue(target: WritableTarget, kind: InputAssistTargetKind, value: string): void {
  if (kind === 'contenteditable') {
    target.textContent = value;
    return;
  }

  const field = target as HTMLInputElement | HTMLTextAreaElement;
  const view = field.ownerDocument.defaultView!;
  const prototype = kind === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Native value setter is unavailable');
  setter.call(field, value);
}

function dispatchInput(document: Document, target: WritableTarget): void {
  const event = new document.defaultView!.Event('input', { bubbles: true, composed: true });
  target.dispatchEvent(event);
}
