export type VideoSubtitleMode = 'bilingual' | 'translation';
export type VideoSubtitlePhase = 'idle' | 'active' | 'limit' | 'error';
export type VideoSubtitleTranslate = (text: string, signal: AbortSignal) => Promise<string>;

export interface VideoSubtitleCue {
  index: number;
  startTime: number;
  endTime: number;
  text: string;
}

export interface VideoSubtitleTrack {
  choiceId: string;
  trackIndex: number;
  id: string;
  kind: string;
  label: string;
  language: string;
  mode: TextTrackMode;
  readable: boolean;
  cues: VideoSubtitleCue[];
}

export interface VideoSubtitleVideo {
  videoIndex: number;
  currentTime: number;
  duration: number | null;
  tracks: VideoSubtitleTrack[];
}

export interface VideoSubtitleCurrentCue extends VideoSubtitleCue {
  translation?: string;
  error?: string;
}

export interface VideoSubtitleState {
  phase: VideoSubtitlePhase;
  mode: VideoSubtitleMode;
  videoIndex?: number;
  trackIndex?: number;
  requestsUsed: number;
  requestsRemaining: number;
  canContinue: boolean;
  cues: VideoSubtitleCue[];
  current?: VideoSubtitleCurrentCue;
  error?: string;
}

export interface VideoSubtitleStart {
  choiceId: string;
  mode: VideoSubtitleMode;
  translate: VideoSubtitleTranslate;
}

interface VideoChoice {
  video: HTMLVideoElement;
  track: TextTrack;
}

interface CueSnapshot extends VideoSubtitleCue {
  cue: TextTrackCue;
}

interface CachedCue {
  source: string;
  pieces: Array<{ source: string; result?: string }>;
  result?: string;
  error?: string;
}

interface ActiveCue extends CueSnapshot {
  cache: CachedCue;
}

interface Session {
  videoIndex: number;
  trackIndex: number;
  video: HTMLVideoElement;
  track: TextTrack;
  translate: VideoSubtitleTranslate;
  url: string;
  cues: CueSnapshot[];
  cache: Map<TextTrackCue, CachedCue>;
  requestsUsed: number;
  modeChange?: { previous: TextTrackMode; assigned: TextTrackMode };
}

interface SubtitleUi {
  root: HTMLDivElement;
  mode: HTMLButtonElement;
  originalGroup: HTMLDivElement;
  original: HTMLDivElement;
  translation: HTMLDivElement;
  error: HTMLDivElement;
  list: HTMLOListElement;
  cueButtons: HTMLButtonElement[];
}

const requestLimit = 100;
const pieceLimit = 2000;
const requestTimeout = 25_000;

function readCues(track: TextTrack): CueSnapshot[] | undefined {
  let list: TextTrackCueList | null;
  try { list = track.cues; } catch { return undefined; }
  if (list === null) return undefined;
  const cues: CueSnapshot[] = [];
  for (let index = 0; index < list.length; index++) {
    const cue = list[index];
    if (!cue || !('text' in cue) || typeof cue.text !== 'string'
      || !Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime) || cue.endTime <= cue.startTime) continue;
    cues.push({ cue, index, startTime: cue.startTime, endTime: cue.endTime, text: cue.text });
  }
  return cues;
}

function trackAt(video: HTMLVideoElement, index: number): TextTrack | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  try { return video.textTracks[index] ?? undefined; } catch { return undefined; }
}

function splitText(text: string): Array<{ source: string; result?: string }> {
  const characters = Array.from(text);
  const pieces: Array<{ source: string; result?: string }> = [];
  for (let offset = 0; offset < characters.length; offset += pieceLimit) {
    const source = characters.slice(offset, offset + pieceLimit).join('');
    pieces.push(source.trim() ? { source } : { source, result: source });
  }
  return pieces;
}

function publicCue(cue: CueSnapshot): VideoSubtitleCue {
  return { index: cue.index, startTime: cue.startTime, endTime: cue.endTime, text: cue.text };
}

function timeLabel(time: number): string {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export class VideoSubtitles {
  private readonly window: Window;
  private readonly observer: MutationObserver;
  private choices = new Map<string, VideoChoice>();
  private session?: Session;
  private ui?: SubtitleUi;
  private current?: ActiveCue;
  private controller?: AbortController;
  private navigationTimer?: ReturnType<typeof setInterval>;
  private taskVersion = 0;
  private phase: VideoSubtitlePhase = 'idle';
  private mode: VideoSubtitleMode = 'bilingual';
  private error?: string;
  private destroyed = false;

  constructor(private readonly document: Document, private readonly changed: (state: VideoSubtitleState) => void = () => undefined) {
    const window = document.defaultView;
    if (!window) throw new Error('VideoSubtitles requires a document with a window.');
    this.window = window;
    this.observer = new window.MutationObserver(() => this.checkSession());
  }

  list(): VideoSubtitleVideo[] {
    const choices = new Map<string, VideoChoice>();
    const videos = [...this.document.querySelectorAll('video')].map((video, videoIndex) => {
      const tracks: VideoSubtitleTrack[] = [];
      let length = 0;
      try { length = video.textTracks.length; } catch { /* Unreadable track lists stay empty. */ }
      for (let trackIndex = 0; trackIndex < length; trackIndex++) {
        const track = trackAt(video, trackIndex);
        if (!track) continue;
        const cues = readCues(track);
        const choiceId = crypto.randomUUID();
        choices.set(choiceId, { video, track });
        tracks.push({ choiceId, trackIndex, id: track.id, kind: track.kind, label: track.label, language: track.language,
          mode: track.mode, readable: cues !== undefined, cues: cues?.map(publicCue) ?? [] });
      }
      return { videoIndex, currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : null, tracks };
    });
    this.choices = choices;
    return videos;
  }

  start(options: VideoSubtitleStart): VideoSubtitleState {
    if (this.destroyed) throw new Error('VideoSubtitles has been destroyed.');
    this.finish();
    this.mode = options.mode;
    const choice = this.choices.get(options.choiceId);
    if (!choice) return this.failStart('所选视频或文字轨已失效，请刷新后重新选择。');
    const videoIndex = [...this.document.querySelectorAll('video')].indexOf(choice.video);
    if (videoIndex < 0) return this.failStart('所选视频或文字轨已失效，请刷新后重新选择。');
    let trackIndex = -1;
    let trackCount = 0;
    try { trackCount = choice.video.textTracks.length; } catch { /* The selected track list is no longer readable. */ }
    for (let index = 0; index < trackCount; index++) {
      if (trackAt(choice.video, index) === choice.track) {
        trackIndex = index;
        break;
      }
    }
    if (trackIndex < 0) return this.failStart('所选视频或文字轨已失效，请刷新后重新选择。');
    const video = choice.video;
    const track = choice.track;
    const cues = readCues(track);
    if (!cues) return this.failStart('所选文字轨的 cue 不可读。');
    if (!cues.length) return this.failStart('所选文字轨暂无可读 cue。');
    this.session = { videoIndex, trackIndex, video, track,
      translate: options.translate, url: this.window.location.href, cues, cache: new Map(), requestsUsed: 0 };
    this.phase = 'active';
    this.error = undefined;
    this.enableTrackEvents();
    this.createUi();
    this.renderCueList();
    this.attachSession();
    this.syncCurrentCue();
    this.emit();
    return this.getState();
  }

  stop(): void { this.finish(); }

  continue(): void {
    if (!this.session || this.phase !== 'limit') return;
    this.session.requestsUsed = 0;
    this.phase = 'active';
    this.error = undefined;
    this.render();
    this.emit();
    if (this.current) void this.translateCurrent(this.session, this.current, this.taskVersion);
  }

  seek(cueIndex: number): boolean {
    const session = this.session;
    const cue = session?.cues.find(candidate => candidate.index === cueIndex);
    if (!session || !cue || !this.checkSession()) return false;
    try { session.video.currentTime = cue.startTime; } catch {
      this.phase = 'error';
      this.error = '无法跳转到该字幕时间。';
      this.render();
      this.emit();
      return false;
    }
    return true;
  }

  setMode(mode: VideoSubtitleMode): void {
    this.mode = mode;
    this.render();
    this.emit();
  }

  getState(): VideoSubtitleState {
    const session = this.session;
    const current = this.current;
    return { phase: this.phase, mode: this.mode, requestsUsed: session?.requestsUsed ?? 0,
      requestsRemaining: session ? Math.max(0, requestLimit - session.requestsUsed) : requestLimit,
      canContinue: this.phase === 'limit', cues: session?.cues.map(publicCue) ?? [],
      ...(session ? { videoIndex: session.videoIndex, trackIndex: session.trackIndex } : {}),
      ...(current ? { current: { ...publicCue(current), ...(current.cache.result !== undefined ? { translation: current.cache.result } : {}),
        ...(current.cache.error ? { error: current.cache.error } : {}) } } : {}),
      ...(this.error ? { error: this.error } : {}) };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.finish();
    this.destroyed = true;
  }

  private failStart(message: string): VideoSubtitleState {
    this.phase = 'error';
    this.error = message;
    this.createUi();
    this.render();
    this.emit();
    return this.getState();
  }

  private enableTrackEvents(): void {
    const session = this.session;
    if (!session || session.track.mode !== 'disabled') return;
    const previous = session.track.mode;
    try {
      // A disabled track does not reliably emit cuechange; hidden keeps native captions off-screen.
      session.track.mode = 'hidden';
      if (session.track.mode === 'hidden') session.modeChange = { previous, assigned: 'hidden' };
    } catch { /* timeupdate and seeking remain sufficient for an already readable cue list. */ }
  }

  private attachSession(): void {
    const session = this.session;
    if (!session) return;
    session.video.addEventListener('timeupdate', this.onTimeUpdate);
    session.video.addEventListener('seeking', this.onSeeking);
    session.track.addEventListener('cuechange', this.onCueChange);
    this.window.addEventListener('pagehide', this.onNavigation);
    this.window.addEventListener('popstate', this.onNavigation);
    this.window.addEventListener('hashchange', this.onNavigation);
    this.observer.observe(this.document, { subtree: true, childList: true });
    this.navigationTimer = setInterval(() => this.checkSession(), 250);
  }

  private finish(message?: string): void {
    const session = this.session;
    this.cancelTask();
    this.observer.disconnect();
    if (this.navigationTimer !== undefined) clearInterval(this.navigationTimer);
    this.navigationTimer = undefined;
    this.window.removeEventListener('pagehide', this.onNavigation);
    this.window.removeEventListener('popstate', this.onNavigation);
    this.window.removeEventListener('hashchange', this.onNavigation);
    if (session) {
      session.video.removeEventListener('timeupdate', this.onTimeUpdate);
      session.video.removeEventListener('seeking', this.onSeeking);
      session.track.removeEventListener('cuechange', this.onCueChange);
      const change = session.modeChange;
      if (change) {
        try { if (session.track.mode === change.assigned) session.track.mode = change.previous; } catch { /* Track ownership is already gone. */ }
      }
    }
    this.ui?.root.remove();
    this.ui = undefined;
    this.session = undefined;
    this.current = undefined;
    this.phase = message ? 'error' : 'idle';
    this.error = message;
    this.emit();
  }

  private cancelTask(): void {
    ++this.taskVersion;
    this.controller?.abort();
    this.controller = undefined;
  }

  private checkSession(): boolean {
    const session = this.session;
    if (!session) return false;
    if (this.window.location.href !== session.url) {
      this.finish('页面已导航，字幕会话已停止。');
      return false;
    }
    let attached = session.video.isConnected;
    try {
      attached = attached && Array.from({ length: session.video.textTracks.length }, (_, index) => session.video.textTracks[index])
        .includes(session.track);
    } catch { attached = false; }
    if (!attached) {
      this.finish('视频或字幕轨已移除，字幕会话已停止。');
      return false;
    }
    return true;
  }

  private refreshCues(session: Session): boolean {
    const next = readCues(session.track);
    if (!next) {
      this.finish('所选文字轨的 cue 已不可读，字幕会话已停止。');
      return false;
    }
    const changed = next.length !== session.cues.length || next.some((cue, index) => {
      const previous = session.cues[index];
      return !previous || previous.cue !== cue.cue || previous.startTime !== cue.startTime
        || previous.endTime !== cue.endTime || previous.text !== cue.text;
    });
    if (changed) {
      session.cues = next;
      this.renderCueList();
    }
    return true;
  }

  private readonly onTimeUpdate = (): void => { this.syncCurrentCue(); };
  private readonly onCueChange = (): void => { this.syncCurrentCue(); };
  private readonly onSeeking = (): void => {
    if (!this.session) return;
    this.cancelTask();
    this.current = undefined;
    this.render();
    this.emit();
    this.syncCurrentCue();
  };
  private readonly onNavigation = (): void => { if (this.session) this.finish('页面已导航，字幕会话已停止。'); };

  private syncCurrentCue(): void {
    const session = this.session;
    if (!session || !this.checkSession() || !this.refreshCues(session)) return;
    const time = session.video.currentTime;
    const cue = session.cues.find(candidate => time >= candidate.startTime && time < candidate.endTime);
    if (cue && this.current?.cue === cue.cue && this.current.text === cue.text) return;
    this.cancelTask();
    this.current = undefined;
    if (!cue) {
      if (this.phase !== 'limit') { this.phase = 'active'; this.error = undefined; }
      this.render();
      this.emit();
      return;
    }
    let cache = session.cache.get(cue.cue);
    if (!cache || cache.source !== cue.text) {
      const pieces = splitText(cue.text);
      cache = { source: cue.text, pieces };
      if (pieces.every(piece => piece.result !== undefined)) cache.result = pieces.map(piece => piece.result).join('');
      session.cache.set(cue.cue, cache);
    }
    this.current = { ...cue, cache };
    if (cache.error) {
      this.phase = 'error';
      this.error = cache.error;
    } else if (this.phase !== 'limit') {
      this.phase = 'active';
      this.error = undefined;
    }
    this.render();
    this.emit();
    if (cache.result === undefined && !cache.error && this.phase !== 'limit') {
      void this.translateCurrent(session, this.current, this.taskVersion);
    }
  }

  private async translateCurrent(session: Session, active: ActiveCue, version: number): Promise<void> {
    for (const piece of active.cache.pieces) {
      if (piece.result !== undefined) continue;
      if (!this.taskCurrent(session, active, version)) return;
      if (session.requestsUsed >= requestLimit) {
        this.phase = 'limit';
        this.error = '本轮已达到 100 个请求，请主动继续。';
        this.render();
        this.emit();
        return;
      }
      ++session.requestsUsed;
      const controller = new AbortController();
      this.controller = controller;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      try {
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeout);
        const result = await Promise.race([session.translate(piece.source, controller.signal), aborted]);
        if (!this.taskCurrent(session, active, version)) return;
        piece.result = result;
      } catch (failure) {
        if (!this.taskCurrent(session, active, version)) return;
        const message = timedOut ? '字幕翻译超时。'
          : failure instanceof Error && failure.message ? failure.message : '字幕翻译失败。';
        active.cache.error = message;
        this.phase = 'error';
        this.error = message;
        this.render();
        this.emit();
        return;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (this.controller === controller) this.controller = undefined;
      }
    }
    if (!this.taskCurrent(session, active, version)) return;
    active.cache.result = active.cache.pieces.map(piece => piece.result).join('');
    this.phase = 'active';
    this.error = undefined;
    this.render();
    this.emit();
  }

  private taskCurrent(session: Session, active: ActiveCue, version: number): boolean {
    return this.session === session && this.current === active && this.taskVersion === version && this.checkSession();
  }

  private createUi(): void {
    if (this.ui) return;
    const root = this.document.createElement('div');
    root.setAttribute('data-browser-fanyi', 'video-subtitles');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '视频字幕翻译');
    Object.assign(root.style, { position: 'fixed', zIndex: '2147483647', insetInlineEnd: '8px', insetBlockEnd: '8px',
      width: 'min(360px, calc(100vw - 16px))', maxHeight: 'min(560px, calc(100vh - 16px))', overflow: 'auto',
      padding: '12px', color: 'CanvasText', background: 'Canvas', border: '1px solid GrayText',
      font: '14px/1.5 system-ui, sans-serif', textAlign: 'start', boxSizing: 'border-box' });

    const header = this.document.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBlockEnd: '8px' });
    const title = this.document.createElement('strong');
    title.textContent = '视频字幕翻译';
    Object.assign(title.style, { flex: '1' });
    const mode = this.document.createElement('button');
    mode.type = 'button';
    mode.addEventListener('click', () => this.setMode(this.mode === 'bilingual' ? 'translation' : 'bilingual'));
    const close = this.document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.setAttribute('aria-label', '关闭视频字幕翻译');
    close.addEventListener('click', () => this.stop());
    header.append(title, mode, close);

    const originalGroup = this.document.createElement('div');
    const originalLabel = this.document.createElement('strong');
    originalLabel.textContent = '原文';
    const original = this.document.createElement('div');
    original.setAttribute('data-video-subtitle-original', '');
    Object.assign(original.style, { whiteSpace: 'pre-wrap', marginBlockEnd: '8px' });
    originalGroup.append(originalLabel, original);

    const translationLabel = this.document.createElement('strong');
    translationLabel.textContent = '译文';
    const translation = this.document.createElement('div');
    translation.setAttribute('data-video-subtitle-translation', '');
    translation.setAttribute('aria-live', 'polite');
    Object.assign(translation.style, { whiteSpace: 'pre-wrap', marginBlockEnd: '8px' });
    const error = this.document.createElement('div');
    error.setAttribute('data-video-subtitle-error', '');
    error.setAttribute('role', 'alert');
    Object.assign(error.style, { color: 'Crimson', whiteSpace: 'pre-wrap', marginBlockEnd: '8px' });
    const listLabel = this.document.createElement('strong');
    listLabel.textContent = '字幕列表';
    const list = this.document.createElement('ol');
    Object.assign(list.style, { margin: '4px 0 0', paddingInlineStart: '24px' });

    root.append(header, originalGroup, translationLabel, translation, error, listLabel, list);
    this.document.documentElement.append(root);
    this.ui = { root, mode, originalGroup, original, translation, error, list, cueButtons: [] };
    this.render();
  }

  private renderCueList(): void {
    const ui = this.ui;
    if (!ui) return;
    ui.list.replaceChildren();
    ui.cueButtons = [];
    for (const cue of this.session?.cues ?? []) {
      const item = this.document.createElement('li');
      const button = this.document.createElement('button');
      button.type = 'button';
      button.textContent = `${timeLabel(cue.startTime)} ${cue.text}`;
      button.addEventListener('click', () => { this.seek(cue.index); });
      Object.assign(button.style, { maxWidth: '100%', textAlign: 'start', overflowWrap: 'anywhere' });
      item.append(button);
      ui.list.append(item);
      ui.cueButtons.push(button);
    }
    this.render();
  }

  private render(): void {
    const ui = this.ui;
    if (!ui) return;
    const current = this.current;
    ui.mode.textContent = this.mode === 'bilingual' ? '仅译文' : '双语';
    ui.mode.setAttribute('aria-label', this.mode === 'bilingual' ? '切换到仅译文' : '切换到双语');
    ui.originalGroup.hidden = this.mode === 'translation';
    ui.original.textContent = current?.text ?? '';
    if (current?.cache.result !== undefined) ui.translation.textContent = current.cache.result;
    else if (current) ui.translation.textContent = this.phase === 'limit' ? '请求额度已暂停，请主动继续。' : '正在翻译…';
    else ui.translation.textContent = this.session ? '等待播放到字幕时间。' : '';
    ui.error.textContent = current?.cache.error ?? this.error ?? '';
    for (let index = 0; index < ui.cueButtons.length; index++) {
      const active = this.session?.cues[index]?.cue === current?.cue;
      if (active) ui.cueButtons[index].setAttribute('aria-current', 'true');
      else ui.cueButtons[index].removeAttribute('aria-current');
    }
  }

  private emit(): void { this.changed(this.getState()); }
}
