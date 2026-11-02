import type { Runtime } from 'webextension-polyfill';
import browser from '../shared/browser';
import type { ContentCommand, Reply } from '../shared/contracts';
import { createContentEngine } from './engine';
import { InputAssist } from './input-assist';
import { inputCommand } from '../shared/workbench';
import { CaptureRegion, capturePageSnapshot } from './capture-region';
import { VideoSubtitles } from './video-subtitles';
import { videoCommand } from '../shared/video';

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
  const region = new CaptureRegion(document);
  const captureInstance = crypto.randomUUID();
  let videoSession: string | undefined;
  let videoSequence = 0;
  const video = new VideoSubtitles(document, state => {
    if (state.videoIndex === undefined && videoSession) {
      void browser.runtime.sendMessage({ type: 'video.end', sessionId: videoSession }).catch(() => undefined);
      videoSession = undefined;
    }
  });
  const videoInfo = () => ({ videos: video.list(), state: video.getState() });
  window.addEventListener('pagehide', () => { inputAssist.invalidate(); region.cancel(); video.stop(); });
  browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
    if (sender.id !== browser.runtime.id) return undefined;
    if (videoCommand(message)) {
      if (sender.tab || ![browser.runtime.getURL('background.js'), browser.runtime.getURL('_generated_background_page.html')].includes(sender.url ?? '')) return undefined;
      if (message.type === 'video.control') {
        if (message.action === 'stop') video.stop();
        else if (message.action === 'continue') video.continue();
        else if (message.action === 'start') {
          video.stop();
          const sessionId = message.grant.sessionId;
          videoSequence = 0;
          const state = video.start({ videoIndex: message.videoIndex, trackIndex: message.trackIndex,
            mode: message.grant.preferences.mode, translate: async (text, signal) => {
              if (signal.aborted) throw new Error('字幕翻译已取消。');
              const sequence = ++videoSequence;
              const cancel = () => { void browser.runtime.sendMessage({ type: 'video.cancel', sessionId, sequence: ++videoSequence }).catch(() => undefined); };
              signal.addEventListener('abort', cancel, { once: true });
              try {
                const reply = await browser.runtime.sendMessage({ type: 'video.translate', sessionId, sequence, text }) as Reply<string>;
                if (!reply.ok) throw new Error(reply.error.message);
                return reply.value;
              } finally { signal.removeEventListener('abort', cancel); }
            } });
          if (state.phase === 'active' || state.phase === 'limit') videoSession = sessionId;
        }
      }
      return Promise.resolve(videoInfo());
    }
    if (message && typeof message === 'object' && 'type' in message
      && ['capture.select', 'capture.inspect', 'capture.cancel'].includes(String(message.type))) {
      if (sender.tab || ![browser.runtime.getURL('background.js'), browser.runtime.getURL('_generated_background_page.html')].includes(sender.url ?? '')) return undefined;
      if (message.type === 'capture.select') return region.start().then(result => ({ documentId: captureInstance, result }));
      if (message.type === 'capture.inspect') return Promise.resolve({ documentId: captureInstance, page: capturePageSnapshot(document) });
      region.cancel();
      return Promise.resolve(null);
    }
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
    if (message.type === 'content.invalidate') { inputAssist.invalidate(); region.cancel(); video.stop(); }
    if (message.type === 'content.command' && ['start', 'restore'].includes(message.action)
      || message.type === 'hover.command' && message.enabled) video.stop();
    return engine.handle(message);
  });
}
