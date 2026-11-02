import type { Runtime } from 'webextension-polyfill';
import type { ContentRequest, SaveSettings, UiRequest } from '../shared/contracts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSettings(value: unknown): value is SaveSettings {
  if (!record(value) || typeof value.prefix !== 'string' || typeof value.model !== 'string'
    || typeof value.sourceLanguage !== 'string' || typeof value.targetLanguage !== 'string'
    || !['bilingual', 'translation'].includes(String(value.mode)) || !record(value.key)) return false;
  return value.key.kind === 'keep' || value.key.kind === 'clear'
    || value.key.kind === 'replace' && typeof value.key.value === 'string' && typeof value.key.forOrigin === 'string';
}

export function request(value: unknown): value is UiRequest | ContentRequest {
  if (!record(value)) return false;
  switch (value.type) {
    case 'settings.get': case 'service.test': return true;
    case 'settings.save': return validSettings(value.settings);
    case 'settings.clear': return typeof value.all === 'boolean';
    case 'page.status': case 'selection.start': return Number.isInteger(value.tabId);
    case 'page.command': return Number.isInteger(value.tabId)
      && ['start', 'pause', 'resume', 'retry', 'restore', 'mode'].includes(String(value.action))
      && (value.mode === undefined || value.mode === 'bilingual' || value.mode === 'translation')
      && (value.action !== 'mode' || value.mode !== undefined);
    case 'selection.get': case 'selection.retry': case 'selection.close': return typeof value.id === 'string';
    case 'content.translate': return typeof value.sessionId === 'string' && typeof value.text === 'string';
    case 'content.cancel': return typeof value.sessionId === 'string';
    default: return false;
  }
}

export type UiPage = 'popup' | 'options' | 'selection';

export function uiPage(sender: Runtime.MessageSender, extensionUrl: string, extensionId: string): UiPage | undefined {
  if (sender.id !== extensionId || !sender.url || sender.frameId !== undefined && sender.frameId !== 0) return;
  try {
    const url = new URL(sender.url);
    for (const page of ['popup', 'options', 'selection'] as const) {
      const expected = new URL(`${page}.html`, extensionUrl);
      if (url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname
        && !url.hash && (page === 'selection' || !url.search)) return page;
    }
  } catch { return; }
}

export function allowed(page: UiPage, type: UiRequest['type'] | ContentRequest['type']): boolean {
  if (page === 'options') return ['settings.get', 'settings.save', 'settings.clear', 'service.test'].includes(type);
  if (page === 'popup') return ['settings.get', 'page.command', 'page.status', 'selection.start'].includes(type);
  return ['selection.get', 'selection.retry', 'selection.close'].includes(type);
}
