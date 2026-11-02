import type { Grant } from './contracts';
import type { VideoSubtitleState, VideoSubtitleVideo } from '../content/video-subtitles';

export interface VideoInfo { videos: VideoSubtitleVideo[]; state: VideoSubtitleState }
export type VideoCommand =
  | { type: 'video.inspect' }
  | { type: 'video.control'; action: 'stop' | 'continue' }
  | { type: 'video.control'; action: 'start'; videoIndex: number; trackIndex: number; grant: Grant };

export function videoCommand(value: unknown): value is VideoCommand {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.type === 'video.inspect' || message.type === 'video.control'
    && (message.action === 'stop' || message.action === 'continue'
      || message.action === 'start' && Number.isInteger(message.videoIndex) && Number.isInteger(message.trackIndex)
      && !!message.grant && typeof message.grant === 'object');
}
