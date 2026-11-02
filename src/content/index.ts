import type { Runtime } from 'webextension-polyfill';
import browser from '../shared/browser';
import type { ContentCommand, Reply } from '../shared/contracts';
import { createContentEngine } from './engine';

function isCommand(message: unknown): message is ContentCommand {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false;
  return message.type === 'content.command' || message.type === 'content.status' || message.type === 'content.selection' || message.type === 'content.invalidate';
}

const host = globalThis as typeof globalThis & { __browserFanyiContent?: ReturnType<typeof createContentEngine> };
if (window.top === window && !host.__browserFanyiContent) {
  const engine = createContentEngine(document, request => browser.runtime.sendMessage(request) as Promise<Reply<string>>);
  host.__browserFanyiContent = engine;
  browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
    if (sender.id !== browser.runtime.id || !isCommand(message)) return undefined;
    return engine.handle(message);
  });
}
