import { afterEach, describe, expect, it } from 'vitest';
import { InputAssist } from '../../src/content/input-assist';

let assist: InputAssist | undefined;
afterEach(() => { assist?.destroy(); document.body.replaceChildren(); });

it('captures the existing active element when injected after focus', () => {
  const input = document.createElement('textarea');
  input.value = 'already focused draft';
  document.body.append(input);
  input.focus();
  input.setSelectionRange(0, 0);
  assist = new InputAssist(document);
  expect(assist.capture()?.sourceText).toBe('already focused draft');
});

describe('input eligibility at actual write time', () => {
  it.each(['input', 'textarea'] as const)('respects inherited fieldset disabling for %s capture, apply and restore', tag => {
    const fieldset = document.createElement('fieldset');
    const field = document.createElement(tag);
    field.value = 'draft';
    fieldset.append(field);
    document.body.append(fieldset);
    field.focus();
    assist = new InputAssist(document);
    const beforeDisable = assist.capture()!;
    fieldset.disabled = true;
    expect(assist.capture()).toBeNull();
    expect(assist.apply(beforeDisable.id, 'replacement').ok).toBe(false);
    expect(field.value).toBe('draft');
    fieldset.disabled = false;
    const writable = assist.capture()!;
    expect(assist.apply(writable.id, 'replacement').ok).toBe(true);
    fieldset.disabled = true;
    expect(assist.restore(writable.id).ok).toBe(false);
    expect(field.value).toBe('replacement');
  });

  it.each(['one-time-code', 'cc-number'])('blocks textarea %s autocomplete at capture and at write time', autocomplete => {
    const textarea = document.createElement('textarea');
    textarea.value = 'private draft';
    document.body.append(textarea);
    textarea.focus();
    assist = new InputAssist(document);
    const beforeSensitive = assist.capture()!;
    textarea.setAttribute('autocomplete', autocomplete);
    expect(assist.capture()).toBeNull();
    expect(assist.apply(beforeSensitive.id, 'replacement').ok).toBe(false);
    textarea.removeAttribute('autocomplete');
    const writable = assist.capture()!;
    expect(assist.apply(writable.id, 'replacement').ok).toBe(true);
    textarea.setAttribute('autocomplete', autocomplete);
    expect(assist.restore(writable.id).ok).toBe(false);
    expect(textarea.value).toBe('replacement');
  });

  const changes: { name: string; change: (input: HTMLInputElement) => void }[] = [
    { name: 'password', change: input => { input.type = 'password'; } },
    { name: 'readonly', change: input => { input.readOnly = true; } },
    { name: 'disabled', change: input => { input.disabled = true; } },
    { name: 'OTP', change: input => { input.autocomplete = 'one-time-code'; } },
    { name: 'payment', change: input => { input.autocomplete = 'cc-number'; } },
    { name: 'hidden', change: input => { input.hidden = true; } },
  ];
  it.each(changes)('refuses applying after field becomes $name', ({ change }) => {
    const input = document.createElement('input');
    input.value = 'draft';
    document.body.append(input);
    assist = new InputAssist(document);
    input.focus();
    const captured = assist.capture()!;
    change(input);
    expect(assist.apply(captured.id, 'replacement').ok).toBe(false);
    expect(input.value).toBe('draft');
  });
  it.each(changes)('refuses restoring after field becomes $name', ({ change }) => {
    const input = document.createElement('input');
    input.value = 'draft';
    document.body.append(input);
    assist = new InputAssist(document);
    input.focus();
    const captured = assist.capture()!;
    expect(assist.apply(captured.id, 'replacement').ok).toBe(true);
    change(input);
    expect(assist.restore(captured.id).ok).toBe(false);
    expect(input.value).toBe('replacement');
  });
  it('refuses changing a plain editable after rich children are introduced', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    editable.textContent = 'draft';
    document.body.append(editable);
    assist = new InputAssist(document);
    editable.focus();
    const captured = assist.capture()!;
    editable.innerHTML = '<strong>draft</strong>';
    expect(assist.apply(captured.id, 'replacement').ok).toBe(false);
    expect(editable.querySelector('strong')?.textContent).toBe('draft');
  });
});
