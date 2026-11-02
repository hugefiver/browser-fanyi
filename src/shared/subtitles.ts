import type { Failure, PublicSettings, Reply } from './contracts';

export const SUBTITLES_PORT_NAME = 'subtitles';
export const SUBTITLES_PAGE_SIZE = 50;

export interface SubtitlesContext {
  contextId: string;
  settings: PublicSettings;
}

export type SubtitlesClientMessage =
  | {
    type: 'start';
    runId: string;
    contextId: string;
    source: string;
    completedTranslationBytes: number;
    indices?: number[];
  }
  | { type: 'cancel'; runId: string };

export type SubtitlesServerMessage =
  | { type: 'hello'; context: SubtitlesContext }
  | { type: 'started'; runId: string; contextId: string; indices: number[] }
  | { type: 'cue'; runId: string; contextId: string; index: number; reply: Reply<string> }
  | {
    type: 'done';
    runId: string;
    contextId: string;
    requested: number;
    completed: number;
    failed: number;
  }
  | { type: 'stopped'; runId: string; contextId: string; error: Failure }
  | { type: 'invalidated'; contextId: string; error: Failure };
