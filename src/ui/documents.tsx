import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, LinearProgress, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import type { Failure, Reply } from '../shared/contracts';
import {
  DOCUMENT_ROUND_SEGMENTS, documentSegmentText, downloadTextDocument, exportTextDocument, readTextDocument,
  type DocumentNode, type DocumentExportOptions, type TextDocument,
} from '../documents/text-html';

export interface DocumentConfiguration {
  revision: string;
  recipient: string;
  model: string;
  targetLanguage: string;
  ready: boolean;
}
export interface DocumentsPanelProps {
  configuration: DocumentConfiguration;
  translate: (text: string, signal: AbortSignal) => Promise<Reply<string>>;
}

type Phase = 'empty' | 'reading' | 'ready' | 'running' | 'paused' | 'round' | 'complete';

function renderNodes(nodes: DocumentNode[], translations?: ReadonlyMap<number, string>, mode: DocumentExportOptions['mode'] = 'bilingual'): React.ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === 'text') return translations ? documentSegmentText(node, translations, mode) : node.text;
    return React.createElement(node.tag, { key: index },
      node.tag === 'br' || node.tag === 'hr' ? undefined : renderNodes(node.children, translations, mode));
  });
}

export function DocumentsPanel(props: DocumentsPanelProps): React.ReactElement {
  const { configuration } = props;
  const key = JSON.stringify([configuration.revision, configuration.recipient, configuration.model, configuration.targetLanguage, configuration.ready]);
  return <DocumentSession key={key} {...props} />;
}

function DocumentSession({ configuration, translate }: DocumentsPanelProps): React.ReactElement {
  const [source, setSource] = useState<TextDocument>();
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<Phase>('empty');
  const [translations, setTranslations] = useState(new Map<number, string>());
  const [failures, setFailures] = useState(new Map<number, Failure>());
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<DocumentExportOptions['mode']>('bilingual');
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const roundRunning = useRef(false);

  useEffect(() => () => {
    generation.current++;
    request.current?.abort();
  }, []);

  const cancel = () => {
    generation.current++;
    request.current?.abort();
    roundRunning.current = false;
    setPhase('paused');
    setNotice('已取消后续发送；已发送的内容可能已被服务接收。已有译文保留，可主动继续。');
  };

  const chooseFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const current = ++generation.current;
    request.current?.abort();
    roundRunning.current = false;
    setSource(undefined);
    setTranslations(new Map());
    setFailures(new Map());
    setName(file.name);
    setPhase('reading');
    setNotice('');
    try {
      const parsed = await readTextDocument(file);
      if (generation.current !== current) return;
      setSource(parsed);
      setPhase('ready');
    } catch (error) {
      if (generation.current !== current) return;
      setPhase('empty');
      setNotice(error instanceof Error ? error.message : '读取文件失败，请重新选择。');
    }
  };

  const run = async (retry: boolean) => {
    if (!source || !configuration.ready || roundRunning.current) return;
    const queue = source.segments.filter(segment => !translations.has(segment.id)
      && (retry ? failures.has(segment.id) : !failures.has(segment.id))).slice(0, DOCUMENT_ROUND_SEGMENTS);
    if (!queue.length) return;
    const current = ++generation.current;
    roundRunning.current = true;
    setPhase('running');
    setNotice('');
    const nextTranslations = new Map(translations);
    const nextFailures = new Map(failures);
    for (const segment of queue) {
      if (generation.current !== current) return;
      const controller = new AbortController();
      request.current = controller;
      const reply = await new Promise<Reply<string>>(resolve => {
        const timer = setTimeout(() => {
          resolve({ ok: false, error: { code: 'timeout', message: '本段请求超过 25 秒，请主动重试。' } });
          controller.abort();
        }, 25_000);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve({ ok: false, error: { code: 'interrupted', message: '本段请求已取消。' } });
        }, { once: true });
        void Promise.resolve().then((): Promise<Reply<string>> | Reply<string> => controller.signal.aborted
          ? { ok: false, error: { code: 'interrupted', message: '本段请求已取消。' } }
          : translate(segment.source, controller.signal)).then(resolve, () => {
          resolve({ ok: false, error: { code: 'network', message: '本段请求失败，请检查服务后主动重试。' } });
        }).finally(() => clearTimeout(timer));
      });
      if (generation.current !== current) return;
      if (reply.ok && reply.value.trim()) {
        nextTranslations.set(segment.id, reply.value);
        nextFailures.delete(segment.id);
      } else {
        nextFailures.set(segment.id, reply.ok
          ? { code: 'invalid-response', message: '服务返回空译文，请主动重试。' }
          : reply.error);
      }
      setTranslations(new Map(nextTranslations));
      setFailures(new Map(nextFailures));
    }
    request.current = undefined;
    roundRunning.current = false;
    const remaining = source.segments.length - nextTranslations.size - nextFailures.size;
    setPhase(remaining > 0 ? 'round' : 'complete');
  };

  const save = (format: DocumentExportOptions['format']) => {
    if (!source) return;
    try { downloadTextDocument(exportTextDocument(source, translations, { format, mode })); }
    catch { setNotice('浏览器无法创建下载，请重新尝试导出。'); }
  };

  const pending = source ? source.segments.length - translations.size - failures.size : 0;
  const busy = phase === 'running';
  const phaseText: Record<Phase, string> = {
    empty: '请选择文件', reading: '正在本地读取', ready: '本地预览，尚未发送', running: '正在翻译',
    paused: '已取消', round: '本轮已结束，请主动继续', complete: failures.size ? '部分失败，可重试失败段' : '翻译已完成',
  };

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Typography component="h2" variant="h6">文本文档翻译</Typography>
        <Typography variant="body2" color="text.secondary">
          仅支持 UTF-8 TXT、HTML、HTM，最大 1 MiB。选文件仅在本地解析，不会发送。HTML 保留安全阅读结构，移除属性、脚本与外部资源。
        </Typography>
        <Button variant="outlined" component="label">
          选择文档
          <input type="file" hidden accept=".txt,.html,.htm" aria-label="选择文档文件" onChange={event => void chooseFile(event)} />
        </Button>
        {notice && <Alert severity="warning">{notice}</Alert>}
        <Typography role="status" aria-live="polite" variant="body2">
          {phaseText[phase]}{source && ` · ${name} · 共 ${source.segments.length} 段，成功 ${translations.size}，失败 ${failures.size}，待发送 ${pending}`}
        </Typography>
        {busy && <LinearProgress aria-label="文档翻译进度" variant="determinate" value={source ? (translations.size + failures.size) / source.segments.length * 100 : 0} />}
        {!configuration.ready && <Alert severity="info">请先配置并授权翻译服务。仍可选择文件并本地预览。</Alert>}
        {source && <>
          <Alert severity="warning">
            确认后仅发送文档阅读文本，不含文件名、属性、链接地址和脚本。接收方：{configuration.recipient || '未配置'}；模型：{configuration.model || '未配置'}；目标语言：{configuration.targetLanguage}。
            每轮最多发送 100 段（每段最多 2000 码点），继续和失败重试均可能产生费用。内容仅保留在当前面板会话。
          </Alert>
          <Box component="section" aria-label="文档原文预览" sx={{ overflow: 'auto', maxHeight: 320, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', '& table': { borderCollapse: 'collapse' }, '& td, & th': { border: 1, borderColor: 'divider', p: 1 } }}>
            {renderNodes(source.nodes)}
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button variant="contained" disabled={busy || !configuration.ready || pending === 0} onClick={() => void run(false)}>
              {phase === 'ready' ? '确认发送并翻译（最多100段）' : '继续发送（最多100段）'}
            </Button>
            <Button variant="outlined" disabled={!busy} onClick={cancel}>取消翻译</Button>
            <Button variant="outlined" disabled={busy || !configuration.ready || failures.size === 0} onClick={() => void run(true)}>仅重试失败段（最多100段）</Button>
          </Stack>
          {failures.size > 0 && <Alert severity="error">
            <Typography variant="body2">以下段落未译，原文已保留：</Typography>
            <Box component="ul" sx={{ m: 0, pl: 3 }}>{Array.from(failures, ([id, failure]) => <li key={id}>第 {id + 1} 段 · {failure.code}：{failure.message}</li>)}</Box>
          </Alert>}
          <TextField select size="small" label="预览与导出模式" value={mode} onChange={event => setMode(event.target.value === 'translation' ? 'translation' : 'bilingual')}>
            <MenuItem value="bilingual">双语</MenuItem><MenuItem value="translation">仅译文（未译段保留标识原文）</MenuItem>
          </TextField>
          <Box component="section" aria-label="文档成果预览" sx={{ overflow: 'auto', maxHeight: 320, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', '& table': { borderCollapse: 'collapse' }, '& td, & th': { border: 1, borderColor: 'divider', p: 1 } }}>
            {renderNodes(source.nodes, translations, mode)}
          </Box>
          <Typography variant="body2" color="text.secondary">导出含尚未成功的段落时，以“未译原文”标识保留原文。HTML 导出仅含安全阅读结构。</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button disabled={busy} onClick={() => save('txt')}>导出 TXT</Button>
            <Button disabled={busy} onClick={() => save('html')}>导出安全 HTML</Button>
          </Stack>
        </>}
      </Stack>
    </Paper>
  );
}
