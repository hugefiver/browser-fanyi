import type { Runtime } from 'webextension-polyfill';
import browser from '../shared/browser';
import type { ContentCommand, Reply } from '../shared/contracts';
import { createContentEngine } from './engine';
import { InputAssist } from './input-assist';
import { inputCommand } from '../shared/workbench';

function isCommand(message: unknown): message is ContentCommand {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false;
  return message.type === 'content.command' || message.type === 'hover.command' || message.type === 'content.status'
    || message.type === 'content.selection' || message.type === 'content.invalidate';
}

const host = globalThis as typeof globalThis & { __browserFanyiContent?: ReturnType<typeof createContentEngine> };
if (window.top === window && !host.__browserFanyiContent) {
  const engine = createContentEngine(document, request => browser.runtime.sendMessage(request) as Promise<Reply<string>>);
  host.__browserFanyiContent = engine;
  const inputAssist = new InputAssist(document);
  window.addEventListener('pagehide', () => inputAssist.invalidate());
  browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
    if (sender.id !== browser.runtime.id) return undefined;
    if (inputCommand(message)) {
      if (sender.tab || ![browser.runtime.getURL('background.js'), browser.runtime.getURL('_generated_background_page.html')].includes(sender.url ?? '')) return undefined;
      if (message.type === 'input.capture') return Promise.resolve(inputAssist.capture());
      if (message.instanceId !== inputAssist.instanceId) return Promise.resolve({ ok: false, reason: 'invalidated' });
      if (message.type === 'input.apply') return Promise.resolve(inputAssist.apply(message.id, message.text));
      if (message.type === 'input.restore') return Promise.resolve(inputAssist.restore(message.id));
      inputAssist.invalidate(message.id);
      return Promise.resolve({ ok: true, value: null });
    }
    if (!isCommand(message)) return undefined;
    if (message.type === 'content.invalidate') inputAssist.invalidate();
    return engine.handle(message);
  });
}
