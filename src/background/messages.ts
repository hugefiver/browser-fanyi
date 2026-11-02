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

function validGlossaryDraft(value: unknown, allowId: boolean): boolean {
  return record(value) && typeof value.source === 'string' && typeof value.target === 'string'
    && typeof value.targetLanguage === 'string'
    && (allowId ? value.id === undefined || typeof value.id === 'string' : value.id === undefined);
}

export function request(value: unknown): value is UiRequest | ContentRequest {
  if (!record(value)) return false;
  switch (value.type) {
    case 'settings.get': case 'service.test': case 'glossary.list': case 'sites.list': return true;
    case 'sites.save': return Number.isInteger(value.tabId) && record(value.rule)
      && typeof value.rule.origin === 'string' && typeof value.rule.targetLanguage === 'string'
      && ['bilingual', 'translation'].includes(String(value.rule.mode)) && value.rule.enabled === true
      && record(value.rule.service) && typeof value.rule.service.prefix === 'string' && typeof value.rule.service.model === 'string';
    case 'sites.change': return typeof value.origin === 'string' && ['enable', 'disable', 'remove'].includes(String(value.action));
    case 'settings.save': return validSettings(value.settings);
    case 'settings.clear': return typeof value.all === 'boolean';
    case 'glossary.upsert': return validGlossaryDraft(value.entry, true);
    case 'glossary.delete': return typeof value.id === 'string';
    case 'glossary.import': return Array.isArray(value.entries) && value.entries.length > 0
      && value.entries.length <= 200 && value.entries.every((entry) => validGlossaryDraft(entry, false));
    case 'page.status': case 'selection.start': case 'input.start': case 'capture.start': return Number.isInteger(value.tabId);
    case 'page.command': return Number.isInteger(value.tabId)
      && ['start', 'pause', 'resume', 'retry', 'restore', 'mode', 'review'].includes(String(value.action))
      && (value.mode === undefined || value.mode === 'bilingual' || value.mode === 'translation')
      && (value.action !== 'mode' || value.mode !== undefined);
    case 'video.list': return Number.isInteger(value.tabId);
    case 'video.command': return Number.isInteger(value.tabId) && (value.action === 'stop' || value.action === 'continue'
      || value.action === 'start' && Number.isInteger(value.videoIndex) && Number.isInteger(value.trackIndex)
      && Number(value.videoIndex) >= 0 && Number(value.trackIndex) >= 0 && ['bilingual', 'translation'].includes(String(value.mode)));
    case 'video.end': return typeof value.sessionId === 'string';
    case 'hover.command': return Number.isInteger(value.tabId) && typeof value.enabled === 'boolean';
    case 'selection.get': case 'selection.retry': case 'selection.close': return typeof value.id === 'string';
    case 'content.translate': return typeof value.sessionId === 'string' && typeof value.text === 'string';
    case 'content.cancel': return typeof value.sessionId === 'string';
    case 'video.translate': case 'hover.translate': return typeof value.sessionId === 'string' && typeof value.sequence === 'number'
      && Number.isSafeInteger(value.sequence) && value.sequence > 0 && typeof value.text === 'string';
    case 'video.cancel': case 'hover.cancel': return typeof value.sessionId === 'string' && typeof value.sequence === 'number'
      && Number.isSafeInteger(value.sequence) && value.sequence > 0;
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
  if (page === 'options') return ['settings.get', 'settings.save', 'settings.clear', 'service.test',
    'glossary.list', 'glossary.upsert', 'glossary.delete', 'glossary.import', 'sites.list', 'sites.change'].includes(type);
  if (page === 'popup') return ['settings.get', 'page.command', 'page.status', 'hover.command', 'selection.start', 'input.start', 'capture.start', 'video.list', 'video.command', 'sites.list', 'sites.save', 'sites.change'].includes(type);
  return ['selection.get', 'selection.retry', 'selection.close'].includes(type);
}
