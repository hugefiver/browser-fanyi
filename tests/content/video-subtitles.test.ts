// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoSubtitles, type VideoSubtitleTranslate } from '../../src/content/video-subtitles';

const fixtureHtml = readFileSync(resolve(process.cwd(), 'tests/fixtures/video-readable.html'), 'utf8');
const fixtureVtt = readFileSync(resolve(process.cwd(), 'tests/fixtures/video-readable.vtt'), 'utf8');
const active: VideoSubtitles[] = [];

function timestamp(value: string): number {
  const parts = value.split(':').map(Number);
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function fixtureCues(): TextTrackCue[] {
  return fixtureVtt.trim().split(/\r?\n\r?\n/).slice(1).map(block => {
    const lines = block.split(/\r?\n/);
    const timing = lines.findIndex(line => line.includes('-->'));
    const [start, end] = lines[timing].split('-->').map(value => value.trim());
    return { id: timing ? lines[0] : '', startTime: timestamp(start), endTime: timestamp(end),
      text: lines.slice(timing + 1).join('\n'), pauseOnExit: false } as unknown as TextTrackCue;
  });
}

function createTrack(cues: TextTrackCue[] = fixtureCues(), mode: TextTrackMode = 'disabled'): TextTrack {
  return Object.assign(new EventTarget(), { id: 'english', kind: 'subtitles', label: 'English', language: 'en',
    mode, cues, activeCues: null, inBandMetadataTrackDispatchType: '' }) as unknown as TextTrack;
}

function setup(cues: TextTrackCue[] = fixtureCues()) {
  const parsed = new DOMParser().parseFromString(fixtureHtml, 'text/html');
  document.body.replaceChildren(...[...parsed.body.childNodes].map(node => document.importNode(node, true)));
  const video = document.querySelector('video')!;
  const track = createTrack(cues);
  const trackArray: TextTrack[] = [track];
  Object.defineProperty(video, 'textTracks', { configurable: true, value: trackArray });
  Object.defineProperty(video, 'duration', { configurable: true, value: 6 });
  video.currentTime = 0;
  const states: ReturnType<VideoSubtitles['getState']>[] = [];
  const subtitles = new VideoSubtitles(document, state => states.push(state));
  active.push(subtitles);
  return { subtitles, video, track, trackArray, states };
}

function start(subtitles: VideoSubtitles, translate: VideoSubtitleTranslate, mode: 'bilingual' | 'translation' = 'bilingual') {
  const choiceId = subtitles.list()[0].tracks[0].choiceId;
  return subtitles.start({ choiceId, mode, translate });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

afterEach(() => {
  for (const subtitles of active.splice(0)) subtitles.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('readable video subtitle sessions', () => {
  it('lists only exposed cue data and safely renders the current source and service text after explicit start', async () => {
    const { subtitles, track } = setup();
    const translate = vi.fn<VideoSubtitleTranslate>(async text => `<b>译:${text}</b>`);
    const listing = subtitles.list();
    expect(listing).toHaveLength(1);
    expect(listing[0].tracks).toHaveLength(1);
    expect(listing[0].tracks[0]).toMatchObject({ choiceId: expect.any(String), trackIndex: 0, readable: true, mode: 'disabled' });
    expect(listing[0].tracks[0].cues[0]).toMatchObject({ index: 0, text: 'First cue <img src=x onerror=alert(1)>' });
    expect(translate).not.toHaveBeenCalled();

    start(subtitles, translate);
    expect(track.mode).toBe('hidden');
    await vi.waitFor(() => expect(subtitles.getState().current?.translation).toContain('<b>译:'));
    expect(translate).toHaveBeenCalledOnce();
    expect(translate.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    const root = document.querySelector('[data-browser-fanyi="video-subtitles"]')!;
    expect(root.querySelector('[data-video-subtitle-original]')!.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.querySelector('[data-video-subtitle-translation]')!.textContent).toContain('<b>译:');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
    root.querySelector<HTMLButtonElement>('button[aria-label="切换到仅译文"]')!.click();
    expect(subtitles.getState().mode).toBe('translation');
  });

  it('starts the originally inspected video and track after preceding objects are inserted', async () => {
    const { subtitles, track, trackArray } = setup();
    const choiceId = subtitles.list()[0].tracks[0].choiceId;
    const leadingVideo = document.createElement('video');
    const leadingVideoTrack = createTrack();
    Object.defineProperty(leadingVideo, 'textTracks', { configurable: true, value: [leadingVideoTrack] });
    document.body.prepend(leadingVideo);
    const leadingTrack = createTrack();
    trackArray.unshift(leadingTrack);
    const translate = vi.fn(async (text: string) => `译:${text}`);

    const state = subtitles.start({ choiceId, mode: 'bilingual', translate });

    expect(state).toMatchObject({ phase: 'active', videoIndex: 1, trackIndex: 1 });
    expect(track.mode).toBe('hidden');
    expect(leadingVideoTrack.mode).toBe('disabled');
    expect(leadingTrack.mode).toBe('disabled');
    await vi.waitFor(() => expect(translate).toHaveBeenCalledWith(
      'First cue <img src=x onerror=alert(1)>', expect.any(AbortSignal),
    ));
  });

  it.each(['video', 'track'] as const)(
    'rejects an inspected choice after its %s is removed instead of selecting the replacement',
    async removed => {
      const { subtitles, video, trackArray } = setup();
      const choiceId = subtitles.list()[0].tracks[0].choiceId;
      const replacementTrack = createTrack();
      if (removed === 'video') {
        const replacementVideo = document.createElement('video');
        Object.defineProperty(replacementVideo, 'textTracks', { configurable: true, value: [replacementTrack] });
        document.body.append(replacementVideo);
        video.remove();
      } else {
        trackArray.push(replacementTrack);
        trackArray.splice(0, 1);
      }
      const translate = vi.fn(async (text: string) => `译:${text}`);

      expect(subtitles.start({ choiceId, mode: 'bilingual', translate })).toMatchObject({
        phase: 'error', error: expect.stringContaining('刷新'),
      });
      expect(replacementTrack.mode).toBe('disabled');
      expect(translate).not.toHaveBeenCalled();
    },
  );

  it('does not accept a webpage-provided track identifier as a choice identity', () => {
    const { subtitles } = setup();
    const translate = vi.fn(async (text: string) => `译:${text}`);
    expect(subtitles.start({ choiceId: 'english', mode: 'bilingual', translate })).toMatchObject({
      phase: 'error', error: expect.stringContaining('刷新'),
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('seeks a valid cue from the safe list without playing the video', async () => {
    const { subtitles, video } = setup();
    const play = vi.fn();
    Object.defineProperty(video, 'play', { configurable: true, value: play });
    const translate = vi.fn(async (text: string) => `译:${text}`);
    start(subtitles, translate);
    await vi.waitFor(() => expect(subtitles.getState().current?.translation).toContain('First cue'));

    document.querySelectorAll<HTMLButtonElement>('[data-browser-fanyi="video-subtitles"] ol button')[1].click();
    expect(video.currentTime).toBe(2);
    expect(play).not.toHaveBeenCalled();
    video.dispatchEvent(new Event('seeking'));
    await vi.waitFor(() => expect(subtitles.getState().current?.translation).toBe('译:Second cue'));
    expect(subtitles.seek(99)).toBe(false);
  });

  it('aborts an old cue and never displays its late result at the new time', async () => {
    const first = deferred<string>();
    const { subtitles, video } = setup();
    const translate = vi.fn<VideoSubtitleTranslate>(text => text.startsWith('First') ? first.promise : Promise.resolve('current result'));
    start(subtitles, translate);
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    const oldSignal = translate.mock.calls[0][1];

    video.currentTime = 2;
    video.dispatchEvent(new Event('seeking'));
    await vi.waitFor(() => expect(subtitles.getState().current?.translation).toBe('current result'));
    expect(oldSignal.aborted).toBe(true);
    first.resolve('late result');
    await Promise.resolve();
    expect(document.querySelector('[data-video-subtitle-translation]')!.textContent).toBe('current result');
  });

  it('reuses a completed cue result across repeated events and a later revisit', async () => {
    const { subtitles, video } = setup();
    const translate = vi.fn(async (text: string) => `译:${text}`);
    start(subtitles, translate);
    await vi.waitFor(() => expect(subtitles.getState().current?.translation).toContain('First cue'));
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('timeupdate'));
    expect(translate).toHaveBeenCalledTimes(1);

    video.currentTime = 2;
    video.dispatchEvent(new Event('seeking'));
    await vi.waitFor(() => expect(subtitles.getState().current?.translation).toBe('译:Second cue'));
    video.currentTime = 0;
    video.dispatchEvent(new Event('seeking'));
    await vi.waitFor(() => expect(subtitles.getState().current?.translation).toContain('First cue'));
    expect(translate.mock.calls.map(call => call[0])).toEqual([
      'First cue <img src=x onerror=alert(1)>', 'Second cue',
    ]);
  });

  it('close aborts work and restores only a native mode still owned by the session', async () => {
    const pending = deferred<string>();
    const { subtitles, track } = setup();
    const translate = vi.fn((_text: string, _signal: AbortSignal) => pending.promise);
    start(subtitles, translate);
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    const signal = translate.mock.calls[0][1];
    document.querySelector<HTMLButtonElement>('button[aria-label="关闭视频字幕翻译"]')!.click();
    expect(signal.aborted).toBe(true);
    expect(track.mode).toBe('disabled');
    expect(subtitles.getState().phase).toBe('idle');
    expect(document.querySelector('[data-browser-fanyi="video-subtitles"]')).toBeNull();

    start(subtitles, async text => `译:${text}`);
    expect(track.mode).toBe('hidden');
    track.mode = 'showing';
    subtitles.stop();
    expect(track.mode).toBe('showing');
  });

  it('stops and cancels when the selected track is removed', async () => {
    const late = deferred<string>();
    const { subtitles, trackArray } = setup();
    const translate = vi.fn((_text: string, _signal: AbortSignal) => late.promise);
    start(subtitles, translate);
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    const signal = translate.mock.calls[0][1];

    trackArray.splice(0, 1);
    document.querySelector('track')!.remove();
    await vi.waitFor(() => expect(subtitles.getState()).toMatchObject({ phase: 'error', error: expect.stringContaining('已移除') }));
    expect(signal.aborted).toBe(true);
    expect(document.querySelector('[data-browser-fanyi="video-subtitles"]')).toBeNull();
    late.resolve('stale after removal');
    await Promise.resolve();
    expect(subtitles.getState().current).toBeUndefined();
  });

  it('splits by 2000 code points, pauses at 100 requests and resumes only after explicit continue', async () => {
    const text = '😀'.repeat(2000 * 100 + 1);
    const cue = { id: 'long', startTime: 0, endTime: 10, text, pauseOnExit: false } as unknown as TextTrackCue;
    const { subtitles } = setup([cue]);
    const translate = vi.fn<VideoSubtitleTranslate>(async () => '译');
    start(subtitles, translate);

    await vi.waitFor(() => expect(subtitles.getState().phase).toBe('limit'));
    expect(translate).toHaveBeenCalledTimes(100);
    expect(translate.mock.calls.every(call => Array.from(call[0]).length <= 2000)).toBe(true);
    expect(subtitles.getState()).toMatchObject({ canContinue: true, requestsUsed: 100 });
    subtitles.continue();
    await vi.waitFor(() => expect(subtitles.getState().current?.translation).toBe('译'.repeat(101)));
    expect(translate).toHaveBeenCalledTimes(101);
    expect(subtitles.getState()).toMatchObject({ phase: 'active', canContinue: false, requestsUsed: 1 });
  });
});
