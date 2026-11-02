import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CssBaseline,
  Divider,
  FormControlLabel,
  LinearProgress,
  Paper,
  Stack,
  ThemeProvider,
  Typography,
} from '@mui/material';
import type { Runtime } from 'webextension-polyfill';
import browser from '../shared/browser';
import {
  decodeSrt,
  parseSrt,
  serializeSrt,
  SRT_MAX_TRANSLATION_BYTES,
  type SrtDocument,
} from '../shared/srt';
import {
  SUBTITLES_PAGE_SIZE,
  SUBTITLES_PORT_NAME,
  type SubtitlesContext,
  type SubtitlesServerMessage,
} from '../shared/subtitles';
import { md2Theme } from './theme';

interface LoadedSrt {
  name: string;
  source: string;
  document: SrtDocument;
}

type ItemState =
  | { phase: 'pending' | 'running' }
  | { phase: 'complete'; text: string }
  | { phase: 'failed'; message: string };

type PagePhase = 'idle' | 'ready' | 'running' | 'partial' | 'complete' | 'cancelled' | 'interrupted';
type Attempt = {
  runId: string;
  contextId: string;
  loaded: LoadedSrt;
  indices: number[];
  completedTranslationBytes: number;
};
type Notice = { severity: 'success' | 'info' | 'warning' | 'error'; text: string };

function downloadName(name: string, translated: boolean): string {
  const stem = name.replace(/\.srt$/i, '') || 'subtitles';
  return `${stem}.${translated ? 'translated' : 'source'}.srt`;
}

export function downloadSrt(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function emptyItems(document: SrtDocument): ItemState[] {
  return document.cues.map(() => ({ phase: 'pending' }));
}

const encoder = new TextEncoder();

function completedTranslationBytes(items: readonly ItemState[]): number {
  return items.reduce((total, item) => item.phase === 'complete'
    ? total + encoder.encode(item.text).byteLength
    : total, 0);
}

export const SubtitlesApp: React.FC = () => {
  const [loaded, setLoaded] = useState<LoadedSrt>();
  const [items, setItems] = useState<ItemState[]>([]);
  const [context, setContext] = useState<SubtitlesContext>();
  const [phase, setPhase] = useState<PagePhase>('idle');
  const [notice, setNotice] = useState<Notice>();
  const [confirmed, setConfirmed] = useState(false);
  const [page, setPage] = useState(0);
  const [resultContextId, setResultContextId] = useState<string>();

  const generationRef = useRef(0);
  const loadedRef = useRef<LoadedSrt | undefined>(undefined);
  const itemsRef = useRef<ItemState[]>([]);
  const contextRef = useRef<SubtitlesContext | undefined>(undefined);
  const portRef = useRef<Runtime.Port | undefined>(undefined);
  const attemptRef = useRef<Attempt | undefined>(undefined);
  const intentionalRef = useRef(new WeakSet<object>());

  const replaceItems = (next: ItemState[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  const closePort = (cancel: boolean) => {
    const port = portRef.current;
    if (!port) return;
    intentionalRef.current.add(port);
    const attempt = attemptRef.current;
    if (cancel && attempt) port.postMessage({ type: 'cancel', runId: attempt.runId });
    port.disconnect();
    if (portRef.current === port) portRef.current = undefined;
    attemptRef.current = undefined;
  };

  const resetForContext = (message: string) => {
    const current = loadedRef.current;
    if (current) replaceItems(emptyItems(current.document));
    setResultContextId(undefined);
    setConfirmed(false);
    setPhase(current ? 'ready' : 'idle');
    setNotice({ severity: 'warning', text: message });
  };

  const openPort = (attempt?: Attempt, expectedContextId?: string) => {
    closePort(false);
    const port = browser.runtime.connect({ name: SUBTITLES_PORT_NAME });
    portRef.current = port;
    attemptRef.current = attempt;

    port.onMessage.addListener((value: unknown) => {
      if (portRef.current !== port) return;
      const message = value as SubtitlesServerMessage;
      if (message.type === 'hello') {
        contextRef.current = message.context;
        setContext(message.context);
        if (expectedContextId && expectedContextId !== message.context.contextId) {
          resetForContext('翻译上下文已变化，已有结果已失效；请重新确认后从头翻译。');
          return;
        }
        if (attempt) {
          port.postMessage({
            type: 'start',
            runId: attempt.runId,
            contextId: attempt.contextId,
            source: attempt.loaded.source,
            completedTranslationBytes: attempt.completedTranslationBytes,
            indices: attempt.indices.length === attempt.loaded.document.cues.length ? undefined : attempt.indices,
          });
        }
        return;
      }
      if (message.type === 'invalidated') {
        resetForContext(message.error.message);
        closePort(false);
        openPort();
        return;
      }
      if (!attempt || message.runId !== attempt.runId || message.contextId !== attempt.contextId) return;
      if (message.type === 'started') {
        const next = [...itemsRef.current];
        for (const index of message.indices) next[index] = { phase: 'running' };
        replaceItems(next);
        setPhase('running');
        setNotice({ severity: 'info', text: `已确认发送 ${message.indices.length} 条字幕正文；文件名和时间轴不会外发。` });
        return;
      }
      if (message.type === 'cue') {
        const next = [...itemsRef.current];
        next[message.index] = message.reply.ok
          ? { phase: 'complete', text: message.reply.value }
          : { phase: 'failed', message: message.reply.error.message };
        replaceItems(next);
        return;
      }
      if (message.type === 'done') {
        const complete = itemsRef.current.every((item) => item.phase === 'complete');
        setPhase(complete ? 'complete' : 'partial');
        setResultContextId(complete ? attempt.contextId : undefined);
        setNotice(complete
          ? { severity: 'success', text: `全部 ${itemsRef.current.length} 条字幕已完成，可导出完整译文。` }
          : { severity: 'warning', text: `本次完成 ${message.completed} 条，失败 ${message.failed} 条；可只重试未完成或失败项。` });
        return;
      }
      if (message.type === 'stopped') {
        replaceItems(itemsRef.current.map((item) => item.phase === 'running' ? { phase: 'pending' } : item));
        setPhase('partial');
        setResultContextId(undefined);
        setNotice({ severity: 'error', text: message.error.message });
      }
    });

    port.onDisconnect.addListener(() => {
      if (intentionalRef.current.has(port) || portRef.current !== port) return;
      portRef.current = undefined;
      attemptRef.current = undefined;
      contextRef.current = undefined;
      setContext(undefined);
      resetForContext('与后台的连接已中断。为避免混用结果，请主动从头翻译。');
      setPhase(loadedRef.current ? 'interrupted' : 'idle');
    });
  };

  useEffect(() => {
    openPort();
    const close = () => closePort(true);
    window.addEventListener('pagehide', close);
    return () => {
      window.removeEventListener('pagehide', close);
      close();
    };
  }, []);

  const chooseFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const generation = ++generationRef.current;
    closePort(true);
    loadedRef.current = undefined;
    setLoaded(undefined);
    replaceItems([]);
    setContext(undefined);
    contextRef.current = undefined;
    setConfirmed(false);
    setResultContextId(undefined);
    setPage(0);
    setPhase('idle');
    setNotice({ severity: 'info', text: '正在本机读取并校验字幕文件…' });
    try {
      const source = decodeSrt(await file.arrayBuffer());
      const document = parseSrt(source);
      if (generation !== generationRef.current) return;
      const next = { name: file.name, source, document };
      loadedRef.current = next;
      setLoaded(next);
      replaceItems(emptyItems(document));
      setPhase('ready');
      setNotice({ severity: 'success', text: `已在本机校验 ${document.cues.length} 条字幕，尚未发送任何正文。` });
      openPort();
    } catch (error) {
      if (generation !== generationRef.current) return;
      const message = error instanceof Error ? error.message : '读取字幕文件失败。';
      setNotice({ severity: 'error', text: message });
      setPhase('idle');
      openPort();
    }
  };

  const startTranslation = (indices?: number[]) => {
    const current = loadedRef.current;
    const currentContext = contextRef.current;
    if (!current || !currentContext || !confirmed) return;
    const requested = indices ?? current.document.cues.map((_, index) => index);
    if (!requested.length) return;
    const retainedBytes = completedTranslationBytes(itemsRef.current);
    setResultContextId(undefined);
    if (retainedBytes >= SRT_MAX_TRANSLATION_BYTES) {
      setPhase('partial');
      setNotice({ severity: 'error', text: '累计译文已达 4 MiB，请缩小文件后从头翻译。' });
      return;
    }
    const attempt = {
      runId: crypto.randomUUID(),
      contextId: currentContext.contextId,
      loaded: current,
      indices: requested,
      completedTranslationBytes: retainedBytes,
    };
    setNotice({ severity: 'info', text: '正在向后台确认当前配置和发送范围…' });
    openPort(attempt, currentContext.contextId);
  };

  const cancelTranslation = () => {
    const currentContextId = contextRef.current?.contextId;
    closePort(true);
    replaceItems(itemsRef.current.map((item) => item.phase === 'running' ? { phase: 'pending' } : item));
    setPhase('cancelled');
    setResultContextId(undefined);
    setNotice({ severity: 'warning', text: '翻译已取消；已收到的成功结果保留，可主动只重试未完成项。' });
    openPort(undefined, currentContextId);
  };

  const retryIndices = items
    .map((item, index) => item.phase === 'complete' ? -1 : index)
    .filter((index) => index >= 0);
  const completed = items.filter((item) => item.phase === 'complete').length;
  const failed = items.filter((item) => item.phase === 'failed').length;
  const total = loaded?.document.cues.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / SUBTITLES_PAGE_SIZE));
  const pageStart = page * SUBTITLES_PAGE_SIZE;
  const visibleCues = loaded?.document.cues.slice(pageStart, pageStart + SUBTITLES_PAGE_SIZE) ?? [];
  const configured = Boolean(context?.settings.prefix && context.settings.model && context.settings.authorized);
  const canExportTranslation = Boolean(loaded && phase === 'complete'
    && resultContextId && resultContextId === context?.contextId && completed === total);

  return (
    <Box component="main" sx={{ maxWidth: 960, mx: 'auto', p: { xs: 2, sm: 3 }, pb: 6 }}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 600, mb: 0.75 }}>
            SRT 字幕翻译
          </Typography>
          <Typography variant="body2" color="text.secondary">
            文件先在本机完整校验。只有您确认并点击开始后，字幕正文和实际匹配的术语才会发送至当前服务。
          </Typography>
        </Box>

        {notice && <Alert severity={notice.severity} aria-live="polite">{notice.text}</Alert>}

        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack spacing={2}>
            <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600 }}>1. 选择并校验文件</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
              <Button component="label" variant="outlined" disabled={phase === 'running'}>
                选择 UTF-8 SRT
                <input
                  hidden
                  type="file"
                  accept=".srt,application/x-subrip,text/plain"
                  aria-label="选择 SRT 文件"
                  onChange={(event) => void chooseFile(event)}
                />
              </Button>
              {loaded && (
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {loaded.name} · {loaded.document.cues.length} 条 · {loaded.document.totalCodePoints} 码点
                </Typography>
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              单个文件最多 1 MiB、1–2000 条；文件名、时间轴和未匹配术语不会发送给翻译服务。
            </Typography>
          </Stack>
        </Paper>

        {loaded && (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1}>
                <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600 }}>2. 确认发送与进度</Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" variant="outlined" label={context
                    ? `${context.settings.sourceLanguage} → ${context.settings.targetLanguage}`
                    : '后台未连接'} />
                  {phase === 'running' && <Chip size="small" color="primary" label="翻译中" />}
                  {phase === 'complete' && <Chip size="small" color="success" label="已完成" />}
                </Stack>
              </Stack>

              {!configured && (
                <Alert severity="warning">
                  当前服务尚未配置完成或未获主机权限。请先在设置页保存服务并授权，然后重新连接后台。
                </Alert>
              )}

              <FormControlLabel
                control={<Checkbox checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />}
                label="我确认：开始后仅字幕正文和相关术语会发送至当前服务，可能消耗服务额度。"
                disabled={phase === 'running'}
              />

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button
                  variant="contained"
                  onClick={() => startTranslation()}
                  disabled={!configured || !confirmed || phase === 'running' || completed > 0}
                >
                  开始翻译全部字幕
                </Button>
                {phase === 'running' && <Button variant="outlined" color="warning" onClick={cancelTranslation}>取消翻译</Button>}
                {phase !== 'running' && retryIndices.length > 0 && completed > 0 && (
                  <Button
                    variant="outlined"
                    onClick={() => startTranslation(retryIndices)}
                    disabled={!configured || !confirmed}
                  >
                    重试未完成或失败（{retryIndices.length}）
                  </Button>
                )}
                {!context && phase !== 'running' && (
                  <Button variant="text" onClick={() => openPort()}>重新连接后台</Button>
                )}
              </Stack>

              <Box>
                <LinearProgress
                  variant="determinate"
                  value={total ? completed / total * 100 : 0}
                  aria-label="字幕翻译进度"
                  sx={{ height: 6, mb: 1 }}
                />
                <Typography variant="caption" color="text.secondary" aria-live="polite">
                  已完成 {completed} / {total} · 失败 {failed} · 待处理 {total - completed - failed}
                </Typography>
              </Box>
            </Stack>
          </Paper>
        )}

        {loaded && (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1} alignItems={{ sm: 'center' }}>
                <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600 }}>3. 分页预览</Typography>
                <Typography variant="body2" color="text.secondary">
                  第 {page + 1} / {totalPages} 页 · 每页最多 {SUBTITLES_PAGE_SIZE} 条
                </Typography>
              </Stack>
              <Divider />
              <Stack spacing={0} divider={<Divider flexItem />}>
                {visibleCues.map((cue, offset) => {
                  const index = pageStart + offset;
                  const item = items[index];
                  return (
                    <Box component="article" key={`${cue.number}-${index}`} sx={{ py: 2 }}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" sx={{ mb: 1 }}>
                        <Typography variant="subtitle2">条目 {index + 1} · 编号 {cue.number}</Typography>
                        <Typography component="code" variant="caption" color="text.secondary">{cue.timeline}</Typography>
                      </Stack>
                      <Box
                        component="pre"
                        sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', lineHeight: 1.6 }}
                      >
                        {cue.text}
                      </Box>
                      {item?.phase === 'complete' && (
                        <Box sx={{ mt: 1.5, pl: 2, borderLeft: 2, borderColor: 'success.light' }}>
                          <Typography variant="caption" color="success.main">译文</Typography>
                          <Box component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', lineHeight: 1.6 }}>
                            {item.text}
                          </Box>
                        </Box>
                      )}
                      {item?.phase === 'failed' && <Alert severity="error" sx={{ mt: 1.5 }}>{item.message}</Alert>}
                      {item?.phase === 'running' && <Typography variant="caption" color="primary">正在翻译…</Typography>}
                    </Box>
                  );
                })}
              </Stack>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Button
                  variant="text"
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                  disabled={page === 0}
                >
                  上一页
                </Button>
                <Typography variant="caption" color="text.secondary">显示 {pageStart + 1}–{Math.min(total, pageStart + SUBTITLES_PAGE_SIZE)} 条</Typography>
                <Button
                  variant="text"
                  onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
                  disabled={page + 1 >= totalPages}
                >
                  下一页
                </Button>
              </Stack>
            </Stack>
          </Paper>
        )}

        {loaded && (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack spacing={2}>
              <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600 }}>4. 导出 SRT</Typography>
              <Typography variant="body2" color="text.secondary">
                导出统一使用 UTF-8 与 CRLF 换行，并保留原编号、顺序和时间轴。完整译文仅在当前上下文全部成功时可用。
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button
                  variant="outlined"
                  onClick={() => downloadSrt(downloadName(loaded.name, false), serializeSrt(loaded.document))}
                >
                  下载标准化原文 SRT
                </Button>
                <Button
                  variant="contained"
                  disabled={!canExportTranslation}
                  onClick={() => {
                    if (!canExportTranslation) return;
                    try {
                      const translations = itemsRef.current.map((item) => item.phase === 'complete' ? item.text : '');
                      downloadSrt(downloadName(loaded.name, true), serializeSrt(loaded.document, translations));
                    } catch (error) {
                      setResultContextId(undefined);
                      setPhase('partial');
                      setNotice({
                        severity: 'error',
                        text: `导出译文失败：${error instanceof Error ? error.message : '译文无法序列化。'}`,
                      });
                    }
                  }}
                >
                  下载完整译文 SRT
                </Button>
              </Stack>
            </Stack>
          </Paper>
        )}
      </Stack>
    </Box>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <ThemeProvider theme={md2Theme}>
        <CssBaseline />
        <SubtitlesApp />
      </ThemeProvider>
    </React.StrictMode>,
  );
}
