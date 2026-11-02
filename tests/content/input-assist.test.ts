import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputAssist } from '../../src/content/input-assist';

function focus(element: HTMLElement): void {
  element.focus();
  element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

describe('InputAssist', () => {
  const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let previousActEnvironment: boolean | undefined;
  let assist: InputAssist;

  beforeEach(() => {
    previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.replaceChildren();
    history.replaceState({}, '', '/input-assist');
    assist = new InputAssist(document);
  });

  afterEach(() => {
    assist.destroy();
    if (previousActEnvironment === undefined) delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it('replaces only the captured textarea selection and dispatches input without submitting', () => {
    const form = document.createElement('form');
    const textarea = document.createElement('textarea');
    textarea.value = 'hello world!';
    form.append(textarea);
    document.body.append(form);
    focus(textarea);
    textarea.setSelectionRange(6, 11, 'forward');
    const inputListener = vi.fn();
    const submitListener = vi.fn((event: Event) => event.preventDefault());
    textarea.addEventListener('input', inputListener);
    form.addEventListener('submit', submitListener);

    const captured = assist.capture();

    expect(captured).toMatchObject({
      instanceId: assist.instanceId,
      kind: 'textarea',
      originalValue: 'hello world!',
      selectedText: 'world',
      sourceText: 'world',
      selection: { start: 6, end: 11, direction: 'forward' },
      canApply: true,
    });
    expect(captured?.url).toBe(document.URL);
    expect(assist.apply(captured!.id, '世界')).toEqual({ ok: true, value: 'hello 世界!' });
    expect(textarea.value).toBe('hello 世界!');
    expect(inputListener).toHaveBeenCalledOnce();
    expect(submitListener).not.toHaveBeenCalled();
  });

  it('uses the whole field when the captured selection is collapsed', () => {
    const input = document.createElement('input');
    input.value = 'draft';
    document.body.append(input);
    focus(input);
    input.setSelectionRange(2, 2);

    const captured = assist.capture();

    expect(captured?.sourceText).toBe('draft');
    expect(captured?.selection).toMatchObject({ start: 2, end: 2 });
    expect(assist.apply(captured!.id, 'final')).toEqual({ ok: true, value: 'final' });
    expect(input.value).toBe('final');
  });

  it('restores only an unchanged extension write and preserves a later user draft', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'before';
    document.body.append(textarea);
    focus(textarea);
    textarea.select();
    const first = assist.capture()!;
    expect(assist.apply(first.id, 'after')).toEqual({ ok: true, value: 'after' });
    expect(assist.restore(first.id)).toEqual({ ok: true, value: 'before' });
    expect(textarea.value).toBe('before');

    focus(textarea);
    textarea.select();
    const second = assist.capture()!;
    expect(assist.apply(second.id, 'extension')).toEqual({ ok: true, value: 'extension' });
    textarea.value = 'user draft';

    expect(assist.restore(second.id)).toEqual({ ok: false, reason: 'user-changed' });
    expect(textarea.value).toBe('user draft');
  });

  it('rejects a replaced source node', () => {
    const input = document.createElement('input');
    input.value = 'original';
    document.body.append(input);
    focus(input);
    input.select();
    const captured = assist.capture()!;
    const replacement = input.cloneNode(true) as HTMLInputElement;
    input.replaceWith(replacement);

    expect(assist.apply(captured.id, 'changed')).toEqual({ ok: false, reason: 'target-changed' });
    expect(replacement.value).toBe('original');
  });

  it('rejects a capture after the document URL changes', () => {
    const input = document.createElement('input');
    input.value = 'original';
    document.body.append(input);
    focus(input);
    input.select();
    const captured = assist.capture()!;

    history.pushState({}, '', '/navigated');

    expect(assist.apply(captured.id, 'changed')).toEqual({ ok: false, reason: 'url-changed' });
    expect(input.value).toBe('original');
  });

  it('rejects changed source values and selections', () => {
    const input = document.createElement('input');
    input.value = 'one two';
    document.body.append(input);
    focus(input);
    input.setSelectionRange(4, 7);
    const valueCapture = assist.capture()!;
    input.value = 'one three';
    expect(assist.apply(valueCapture.id, 'second')).toEqual({ ok: false, reason: 'value-changed' });

    input.value = 'one two';
    input.setSelectionRange(4, 7);
    const selectionCapture = assist.capture()!;
    input.setSelectionRange(0, 3);
    expect(assist.apply(selectionCapture.id, 'second')).toEqual({ ok: false, reason: 'selection-changed' });
    expect(input.value).toBe('one two');
  });

  it('blocks capture and apply while IME composition is active', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'draft';
    document.body.append(textarea);
    focus(textarea);
    textarea.select();

    textarea.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(assist.capture()).toBeNull();
    textarea.dispatchEvent(new Event('compositionend', { bubbles: true }));

    const captured = assist.capture()!;
    textarea.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(assist.apply(captured.id, 'changed')).toEqual({ ok: false, reason: 'composing' });
    expect(textarea.value).toBe('draft');
  });

  it.each([
    { name: 'password', configure: (input: HTMLInputElement) => (input.type = 'password') },
    { name: 'OTP autocomplete', configure: (input: HTMLInputElement) => (input.autocomplete = 'one-time-code') },
    { name: 'payment autocomplete', configure: (input: HTMLInputElement) => (input.autocomplete = 'cc-number') },
    { name: 'disabled', configure: (input: HTMLInputElement) => (input.disabled = true) },
    { name: 'readonly', configure: (input: HTMLInputElement) => (input.readOnly = true) },
    { name: 'hidden', configure: (input: HTMLInputElement) => (input.hidden = true) },
  ])('does not capture $name inputs', ({ configure }) => {
    const input = document.createElement('input');
    input.value = 'secret';
    configure(input);
    document.body.append(input);
    focus(input);

    expect(assist.capture()).toBeNull();
  });

  it('writes a selected range in a plain-text contenteditable without using markup', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    editable.textContent = 'hello world';
    document.body.append(editable);
    focus(editable);
    const text = editable.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 11);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    const inputListener = vi.fn();
    editable.addEventListener('input', inputListener);

    const captured = assist.capture()!;

    expect(captured).toMatchObject({ kind: 'contenteditable', sourceText: 'world', canApply: true });
    expect(assist.apply(captured.id, '世界')).toEqual({ ok: true, value: 'hello 世界' });
    expect(editable.textContent).toBe('hello 世界');
    expect(inputListener).toHaveBeenCalledOnce();
  });

  it('captures rich content for preview but never applies it', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    const strong = document.createElement('strong');
    strong.textContent = 'rich';
    editable.append(strong, ' text');
    document.body.append(editable);
    focus(editable);

    const captured = assist.capture()!;

    expect(captured).toMatchObject({
      kind: 'contenteditable',
      originalValue: 'rich text',
      sourceText: 'rich text',
      canApply: false,
    });
    expect(assist.apply(captured.id, 'replacement')).toEqual({ ok: false, reason: 'cannot-apply' });
    expect(editable.textContent).toBe('rich text');
  });

  it('detects a synchronous site rejection after dispatching input', () => {
    const input = document.createElement('input');
    input.value = 'locked';
    input.addEventListener('input', () => {
      input.value = 'locked';
    });
    document.body.append(input);
    focus(input);
    input.select();
    const captured = assist.capture()!;

    expect(assist.apply(captured.id, 'attempt')).toEqual({ ok: false, reason: 'site-rejected' });
    expect(input.value).toBe('locked');
  });

  it('updates a React controlled input through the native setter and input event seam', () => {
    function ControlledInput() {
      const [value, setValue] = useState('draft');
      return createElement('input', {
        value,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.currentTarget.value),
      });
    }

    const host = document.createElement('div');
    document.body.append(host);
    let root: Root;
    act(() => {
      root = createRoot(host);
      root.render(createElement(ControlledInput));
    });
    const input = host.querySelector('input')!;
    focus(input);
    input.select();
    const captured = assist.capture()!;

    let result: ReturnType<InputAssist['apply']> | undefined;
    act(() => {
      result = assist.apply(captured.id, 'controlled');
    });

    expect(result).toEqual({ ok: true, value: 'controlled' });
    expect(input.value).toBe('controlled');
    act(() => root.unmount());
  });

  it('invalidates individual captures and removes listeners on destroy', () => {
    const input = document.createElement('input');
    input.value = 'draft';
    document.body.append(input);
    focus(input);
    input.select();
    const captured = assist.capture()!;

    assist.invalidate(captured.id);
    expect(assist.apply(captured.id, 'changed')).toEqual({ ok: false, reason: 'invalidated' });

    assist.destroy();
    expect(assist.capture()).toBeNull();
  });
});
