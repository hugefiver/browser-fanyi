import type browser from '../shared/browser';
import type { Runtime } from 'webextension-polyfill';
import { errorMessages, type Failure, type Reply } from '../shared/contracts';
import {
  normalizeSrtTranslation,
  parseSrt,
  SRT_MAX_TRANSLATION_BYTES,
  SrtError,
  type SrtDocument,
} from '../shared/srt';
import {
  SUBTITLES_PORT_NAME,
  type SubtitlesClientMessage,
  type SubtitlesContext,
  type SubtitlesServerMessage,
} from '../shared/subtitles';
import type { TranslationSnapshot } from './settings';

const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalCodes = new Set(['configuration', 'permission', 'authentication', 'quota', 'limit', 'glossary']);
const encoder = new TextEncoder();
const interrupted: Failure = { code: 'interrupted', message: errorMessages.interrupted };
const translationLimit: Failure = { code: 'limit', message: '累计译文超过 4 MiB，请缩小文件后从头翻译。' };

interface Connection {
  port: Runtime.Port;
  controller: AbortController;
  context?: SubtitlesContext;
  runId?: string;
  started: boolean;
  closed: boolean;
  invalidated: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function startMessage(value: unknown): value is Extract<SubtitlesClientMessage, { type: 'start' }> {
  if (!record(value) || value.type !== 'start' || typeof value.runId !== 'string'
    || !runIdPattern.test(value.runId) || typeof value.contextId !== 'string' || typeof value.source !== 'string'
    || typeof value.completedTranslationBytes !== 'number' || !Number.isSafeInteger(value.completedTranslationBytes)
    || value.completedTranslationBytes < 0 || value.completedTranslationBytes > SRT_MAX_TRANSLATION_BYTES) return false;
  return value.indices === undefined || Array.isArray(value.indices)
    && value.indices.every((index) => Number.isSafeInteger(index));
}

function exactSender(api: typeof browser, port: Runtime.Port): boolean {
  const sender = port.sender;
  if (port.name !== SUBTITLES_PORT_NAME || sender?.id !== api.runtime.id || !sender.url
    || sender.frameId !== undefined && sender.frameId !== 0) return false;
  try {
    const actual = new URL(sender.url);
    const expected = new URL(api.runtime.getURL('subtitles.html'));
    return actual.protocol === expected.protocol && actual.host === expected.host
      && actual.pathname === expected.pathname && !actual.search && !actual.hash;
  } catch {
    return false;
  }
}

function srtFailure(error: unknown): Failure {
  if (error instanceof SrtError) {
    const limit = ['file-too-large', 'cue-limit', 'cue-text-limit', 'total-text-limit', 'translation-size'].includes(error.code);
    return { code: limit ? 'limit' : 'unsupported', message: error.message };
  }
  return { code: 'invalid-response', message: errorMessages['invalid-response'] };
}

export class Subtitles {
  private readonly connections = new Set<Connection>();

  constructor(
    private readonly api: typeof browser,
    private readonly ready: () => Promise<Reply<TranslationSnapshot>>,
    private readonly send: (
      settings: TranslationSnapshot,
      text: string,
      signal: AbortSignal,
    ) => Promise<Reply<string>>,
    private readonly getContext: () => Promise<SubtitlesContext>,
  ) {}

  install(): void {
    this.api.runtime.onConnect.addListener((port) => {
      if (port.name === SUBTITLES_PORT_NAME) this.connect(port);
    });
  }

  async contextChanged(): Promise<void> {
    let current: SubtitlesContext;
    try {
      current = await this.getContext();
    } catch {
      for (const connection of [...this.connections]) {
        this.disconnect(connection);
        connection.port.disconnect();
      }
      return;
    }
    for (const connection of this.connections) {
      if (connection.context?.contextId !== current.contextId) this.invalidate(connection, current.contextId);
    }
  }

  private connect(port: Runtime.Port): void {
    if (!exactSender(this.api, port)) {
      port.disconnect();
      return;
    }
    const connection: Connection = {
      port,
      controller: new AbortController(),
      started: false,
      closed: false,
      invalidated: false,
    };
    this.connections.add(connection);
    port.onMessage.addListener((message: unknown) => { void this.message(connection, message); });
    port.onDisconnect.addListener(() => this.disconnect(connection));
    void this.hello(connection);
  }

  private async hello(connection: Connection): Promise<void> {
    try {
      const context = await this.getContext();
      if (connection.closed) return;
      connection.context = context;
      this.post(connection, { type: 'hello', context });
    } catch {
      this.disconnect(connection);
      connection.port.disconnect();
    }
  }

  private async message(connection: Connection, value: unknown): Promise<void> {
    if (connection.closed) return;
    if (record(value) && value.type === 'cancel' && typeof value.runId === 'string') {
      if (value.runId === connection.runId) {
        this.disconnect(connection);
        connection.port.disconnect();
      }
      return;
    }
    if (!connection.context || connection.started || !startMessage(value)) return;
    connection.started = true;
    connection.runId = value.runId;
    await this.start(connection, value);
  }

  private disconnect(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.controller.abort();
    this.connections.delete(connection);
  }

  private invalidate(connection: Connection, contextId: string): void {
    if (connection.closed || connection.invalidated) return;
    connection.invalidated = true;
    connection.controller.abort();
    this.post(connection, { type: 'invalidated', contextId, error: interrupted });
  }

  private post(connection: Connection, message: SubtitlesServerMessage): void {
    if (!connection.closed) connection.port.postMessage(message);
  }

  private async start(
    connection: Connection,
    message: Extract<SubtitlesClientMessage, { type: 'start' }>,
  ): Promise<void> {
    const context = await this.getContext();
    if (message.contextId !== connection.context?.contextId || context.contextId !== message.contextId) {
      this.invalidate(connection, context.contextId);
      return;
    }

    let document: SrtDocument;
    let indices: number[];
    try {
      document = parseSrt(message.source);
      indices = message.indices ?? document.cues.map((_, index) => index);
      if (!indices.length || new Set(indices).size !== indices.length
        || indices.some((index) => index < 0 || index >= document.cues.length)) {
        throw new SrtError('translation-count', '待翻译条目索引无效。');
      }
    } catch (error) {
      this.post(connection, { type: 'stopped', runId: message.runId, contextId: message.contextId, error: srtFailure(error) });
      return;
    }

    const settings = await this.ready();
    if (!settings.ok) {
      this.post(connection, { type: 'stopped', runId: message.runId, contextId: message.contextId, error: settings.error });
      return;
    }
    const readyContext = await this.getContext();
    if (readyContext.contextId !== message.contextId) {
      this.invalidate(connection, readyContext.contextId);
      return;
    }
    this.post(connection, { type: 'started', runId: message.runId, contextId: message.contextId, indices });
    await this.translate(connection, message, document, indices, settings.value);
  }

  private async translate(
    connection: Connection,
    message: Extract<SubtitlesClientMessage, { type: 'start' }>,
    document: SrtDocument,
    indices: number[],
    settings: TranslationSnapshot,
  ): Promise<void> {
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    let translatedBytes = message.completedTranslationBytes;
    let terminal: Failure | undefined;

    const worker = async (): Promise<void> => {
      while (!connection.controller.signal.aborted && !terminal) {
        const position = cursor++;
        if (position >= indices.length) return;
        const index = indices[position];
        const reply = await this.send(settings, document.cues[index].text, connection.controller.signal);
        if (connection.closed || connection.invalidated) return;
        const current = await this.getContext();
        if (current.contextId !== message.contextId) {
          this.invalidate(connection, current.contextId);
          return;
        }
        if (connection.controller.signal.aborted) return;

        let result = reply;
        if (reply.ok) {
          translatedBytes += encoder.encode(reply.value).byteLength;
          if (translatedBytes > SRT_MAX_TRANSLATION_BYTES) {
            result = { ok: false, error: translationLimit };
          } else {
            try {
              result = {
                ok: true,
                value: normalizeSrtTranslation(reply.value, document.cues[index].line + 2, index + 1),
              };
            } catch (error) {
              result = { ok: false, error: srtFailure(error) };
            }
          }
        }

        if (result.ok) completed++;
        else failed++;
        this.post(connection, {
          type: 'cue',
          runId: message.runId,
          contextId: message.contextId,
          index,
          reply: result,
        });
        if (!result.ok && terminalCodes.has(result.error.code)) {
          terminal = result.error;
          connection.controller.abort();
        }
      }
    };

    await Promise.all([worker(), worker()]);
    if (connection.closed || connection.invalidated) return;
    if (terminal) {
      this.post(connection, { type: 'stopped', runId: message.runId, contextId: message.contextId, error: terminal });
      return;
    }
    if (connection.controller.signal.aborted) return;
    this.post(connection, {
      type: 'done',
      runId: message.runId,
      contextId: message.contextId,
      requested: indices.length,
      completed,
      failed,
    });
  }
}
