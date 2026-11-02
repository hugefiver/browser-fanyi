import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Box, Button, CssBaseline, LinearProgress, MenuItem, Paper, Stack, Tab, Tabs, TextField, ThemeProvider, Typography } from '@mui/material';
import type { Runtime } from 'webextension-polyfill';
import browser from '../shared/browser';
import type { InputAssistCapture } from '../content/input-assist';
import { fail, type PageStatus, type Reply } from '../shared/contracts';
import { inputFailureText, operationLabels, WORKBENCH_PORT_NAME, writingOperations, type WorkbenchContext, type WorkbenchServerMessage, type WritingOperation } from '../shared/workbench';
import { DocumentsPanel } from './documents';
import { ImagesPanel, type ImageRecognition } from './images';
import { md2Theme } from './theme';

const pagePhases: Record<PageStatus['phase'], string> = {
  idle: '未翻译', running: '翻译中', complete: '已完成', paused: '已暂停', partial: '部分失败',
  interrupted: '已中断', empty: '没有可译正文', limit: '达到本轮上限',
};
interface Pending { finish: (reply: Reply<string>) => void; contextId: string }
type Translate = (text: string, signal: AbortSignal, operation?: WritingOperation) => Promise<Reply<string>>;

export function WorkbenchApp(): React.ReactElement {
  const [context, setContext] = useState<WorkbenchContext>();
  const [capture, setCapture] = useState<InputAssistCapture>();
  const [image, setImage] = useState<string>();
  const [bindingValid, setBindingValid] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [tab, setTab] = useState('text');
  const [notice, setNotice] = useState('正在连接工作台…');
  const [inputNotice, setInputNotice] = useState('');
  const [applied, setApplied] = useState(false);
  const [inputBusy, setInputBusy] = useState(false);
  const [page, setPage] = useState<{ tabId?: number; reply: Reply<PageStatus> }>();
  const [pageBusy, setPageBusy] = useState(false);
  const pageRequest = useRef('');
  const pageActionPending = useRef(false);
  const sidebar = location.search === '?sidebar=1';
  const port = useRef<Runtime.Port | undefined>(undefined);
  const current = useRef<WorkbenchContext | undefined>(undefined);
  const pending = useRef(new Map<string, Pending>());
  const inputRequest = useRef<{ id: string; type: 'apply' | 'restore' } | undefined>(undefined);

  useEffect(() => {
    const connection = browser.runtime.connect({ name: WORKBENCH_PORT_NAME });
    port.current = connection;
    const interrupt = () => {
      for (const request of pending.current.values()) request.finish(fail('interrupted'));
      pending.current.clear();
      inputRequest.current = undefined;
      setInputBusy(false);
      setBindingValid(false);
      setApplied(false);
      setInputNotice('');
      setPage(undefined);
      setPageBusy(false);
      pageActionPending.current = false;
      pageRequest.current = '';
      setEpoch(value => value + 1);
    };
    connection.onMessage.addListener((value: unknown) => {
      const message = value as WorkbenchServerMessage;
      if (message.type === 'hello' || message.type === 'invalidated') {
        interrupt();
        current.current = message.context;
        setContext(message.context);
        if (message.type === 'hello') {
          setCapture(message.capture);
          setImage(message.image);
          if (message.image) setTab('images');
          setBindingValid(!!message.capture);
          setNotice('');
        } else setNotice('配置、权限或源页面已变化；任务、旧结果和输入绑定已失效。请主动重新发送或回原页重新捕获。');
        return;
      }
      if (message.contextId !== current.current?.contextId) return;
      if (message.type === 'page') {
        if (message.id === pageRequest.current) {
          pageActionPending.current = false;
          setPageBusy(false);
          setPage({ tabId: message.tabId, reply: message.reply });
        }
        return;
      }
      if (message.type === 'result') {
        const request = pending.current.get(message.id);
        if (request?.contextId === message.contextId) {
          pending.current.delete(message.id);
          request.finish(message.reply);
        }
      } else if (message.type === 'input-result' && inputRequest.current?.id === message.id) {
        const action = inputRequest.current.type;
        inputRequest.current = undefined;
        setInputBusy(false);
        setInputNotice(message.reply.ok ? action === 'apply' ? '已写回源字段，未提交表单。' : '已恢复源字段原文。'
          : inputFailureText[message.reply.reason]);
        if (message.reply.ok) {
          setApplied(action === 'apply');
          if (action === 'restore') setBindingValid(false);
        }
      }
    });
    connection.onDisconnect.addListener(() => {
      port.current = undefined;
      current.current = undefined;
      setContext(undefined);
      interrupt();
      setNotice('后台连接已中断，所有任务和绑定已失效。重新打开工作台后可主动开始。');
    });
    return () => { connection.disconnect(); };
  }, []);

  useEffect(() => {
    if (!sidebar || !context) return;
    const refresh = () => {
      if (!port.current || pageActionPending.current) return;
      const id = crypto.randomUUID();
      pageRequest.current = id;
      port.current.postMessage({ type: 'page.status', id, contextId: context.contextId });
    };
    const switchTab = () => {
      setPage(undefined);
      setPageBusy(false);
      pageActionPending.current = false;
      refresh();
    };
    refresh();
    const timer = setInterval(refresh, 800);
    browser.tabs.onActivated.addListener(switchTab);
    return () => { clearInterval(timer); browser.tabs.onActivated.removeListener(switchTab); };
  }, [sidebar, context, epoch]);

  const pageCommand = (action: 'start' | 'pause' | 'restore') => {
    if (!port.current || !context || page?.tabId === undefined) return;
    const id = crypto.randomUUID();
    pageRequest.current = id;
    pageActionPending.current = true;
    setPageBusy(true);
    port.current.postMessage({ type: 'page.command', id, contextId: context.contextId, tabId: page.tabId, action });
  };

  const translate = (text: string, signal: AbortSignal, operation: WritingOperation = 'translate', image = false): Promise<Reply<string>> => {
    const connection = port.current;
    const snapshot = current.current;
    if (!connection || !snapshot || signal.aborted) return Promise.resolve(fail('interrupted'));
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const cancel = () => {
        if (!pending.current.delete(id)) return;
        connection.postMessage({ type: 'cancel', id });
        resolve(fail('interrupted'));
      };
      pending.current.set(id, { contextId: snapshot.contextId, finish: reply => {
        signal.removeEventListener('abort', cancel);
        resolve(reply);
      } });
      signal.addEventListener('abort', cancel, { once: true });
      connection.postMessage(image ? { type: 'image', id, contextId: snapshot.contextId, dataUrl: text }
        : { type: 'translate', id, contextId: snapshot.contextId, text, operation });
    });
  };

  const writeInput = (type: 'apply' | 'restore', text = '') => {
    if (!port.current || !context || !bindingValid || inputBusy) return;
    const id = crypto.randomUUID();
    inputRequest.current = { id, type };
    setInputBusy(true);
    setInputNotice('');
    port.current.postMessage({ type, id, contextId: context.contextId, text });
  };
  const settings = context?.settings;
  const ready = !!settings?.prefix && !!settings.model && settings.authorized;
  const revision = `${context?.contextId ?? 'disconnected'}:${epoch}`;

  return <ThemeProvider theme={md2Theme}><CssBaseline />
    <Box component="main" sx={{ maxWidth: 960, mx: 'auto', p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Typography component="h1" variant="h5">翻译与写作工作台</Typography>
        <Typography variant="body2" color="text.secondary">内容仅保留在当前会话。打开工作台、输入文字和选择文件均不会自动发送。</Typography>
        <Button sx={{ alignSelf: 'flex-start' }} onClick={() => void browser.runtime.openOptionsPage()}>服务与术语设置</Button>
        {notice && <Alert severity="warning">{notice}</Alert>}
        {!ready && <Alert severity="info">请配置服务地址、模型并授权服务主机；仍可在本地准备内容。</Alert>}
        <Alert severity="info">接收方：{settings?.prefix || '未配置'}；模型：{settings?.model || '未配置'}；目标语言：{settings?.targetLanguage || '未配置'}。发送可能产生费用。</Alert>
        {sidebar && <Paper variant="outlined" sx={{ p: 2 }}><Stack spacing={1}>
          <Typography component="h2" variant="h6">当前授权网页</Typography>
          <Typography variant="body2" role="status">{page ? page.reply.ok
            ? `标签页 ${page.tabId} · ${pagePhases[page.reply.value.phase]} · 已完成 ${page.reply.value.completed} / ${page.reply.value.total}`
            : page.reply.error.message : '正在读取当前活动网页状态…'}</Typography>
          <Typography variant="caption" color="text.secondary">开始后将发送当前页可读正文至上述服务，可能产生费用。切换标签页或关闭侧栏会取消此侧栏启动的页面任务。</Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            <Button disabled={!ready || page?.tabId === undefined || pageBusy} onClick={() => pageCommand('start')}>开始整页翻译</Button>
            <Button disabled={page?.tabId === undefined || pageBusy} onClick={() => pageCommand('pause')}>暂停整页翻译</Button>
            <Button disabled={page?.tabId === undefined || pageBusy} onClick={() => pageCommand('restore')}>还原当前网页</Button>
          </Stack>
        </Stack></Paper>}
        <Tabs value={tab} onChange={(_, value: string) => setTab(value)} aria-label="工作台工具">
          <Tab value="text" label={capture ? '源输入预览' : '文字与写作'} /><Tab value="documents" label="TXT / HTML 文档" disabled={!!capture} />
          <Tab value="images" label="图片与截图" disabled={!!capture} />
        </Tabs>
        <Box role="tabpanel" aria-label="文字与写作内容" hidden={tab !== 'text'}>
          <TextWorkbench revision={revision} translate={translate} ready={ready}
            capture={capture} bindingValid={bindingValid} applied={applied} inputBusy={inputBusy}
            inputNotice={inputNotice} writeInput={writeInput} />
        </Box>
        <Box role="tabpanel" aria-label="文本文档内容" hidden={tab !== 'documents'}>
          <DocumentsPanel configuration={{ revision, recipient: settings?.prefix ?? '',
            model: settings?.model ?? '', targetLanguage: settings?.targetLanguage ?? '', ready }} translate={translate} />
        </Box>
        <Box role="tabpanel" aria-label="图片与截图内容" hidden={tab !== 'images'}>
          <ImagesPanel configuration={{ revision, recipient: settings?.prefix ?? '', model: settings?.model ?? '',
            targetLanguage: settings?.targetLanguage ?? '', ready }} initialImage={image}
            recognize={async (dataUrl, signal) => {
              const reply = await translate(dataUrl, signal, 'translate', true);
              return reply.ok ? { ok: true, value: JSON.parse(reply.value) as ImageRecognition } : reply;
            }} />
          <Typography variant="caption">图像路径不发送本地术语表：识别前没有源文可用于匹配术语。</Typography>
        </Box>
      </Stack>
    </Box>
  </ThemeProvider>;
}

interface TextWorkbenchProps {
  revision?: string;
  translate: Translate;
  ready: boolean;
  capture?: InputAssistCapture;
  bindingValid: boolean;
  applied: boolean;
  inputBusy: boolean;
  inputNotice: string;
  writeInput: (type: 'apply' | 'restore', text?: string) => void;
}

export function TextWorkbench({ revision, translate, ready, capture, bindingValid, applied, inputBusy, inputNotice, writeInput }: TextWorkbenchProps): React.ReactElement {
  const [text, setText] = useState(capture?.sourceText ?? '');
  const [operation, setOperation] = useState<WritingOperation>('translate');
  const [result, setResult] = useState('');
  const [serviceResult, setServiceResult] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (capture) setText(capture.sourceText); }, [capture]);
  useEffect(() => {
    request.current?.abort();
    request.current = undefined;
    setBusy(false);
    setResult('');
    setServiceResult('');
    setAttempted(false);
    setNotice('');
  }, [revision]);

  const cancel = () => {
    request.current?.abort();
    request.current = undefined;
    setBusy(false);
    setNotice('已取消。已发送的内容可能已被服务接收；源字段未写入。');
  };
  const run = async () => {
    if (busy || !ready) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setAttempted(true);
    setResult('');
    setServiceResult('');
    setNotice('');
    const reply = await translate(text, controller.signal, operation);
    if (request.current !== controller || controller.signal.aborted) return;
    request.current = undefined;
    setBusy(false);
    if (reply.ok) { setResult(reply.value); setServiceResult(reply.value); }
    else setNotice(reply.error.message);
  };
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice('已复制。'); }
    catch { setNotice('浏览器拒绝剪贴板访问，请选中文字手动复制。'); }
  };
  const canSend = ready && !!text.trim() && Array.from(text).length <= 2000 && (!capture || bindingValid);

  return <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}><Stack spacing={2}>
    <Typography component="h2" variant="h6">{capture ? '输入辅助：先预览，再确认写回' : '文字翻译与写作'}</Typography>
    {capture && <Alert severity={bindingValid ? 'info' : 'warning'}>
      {bindingValid ? '仅操作从工具栏捕获的源字段；切换页面不会扩大授权。' : '源绑定已失效，请回源页面重新捕获。'}
      {!capture.canApply && '复杂富文本仅提供预览和复制，不能写回。'}
    </Alert>}
    <TextField label={capture ? '捕获的源文字' : '待处理文字'} multiline minRows={5} value={text}
      slotProps={{ input: { readOnly: !!capture } }} disabled={busy}
      helperText={`${Array.from(text).length} / 2000 码点；只发送这里的文字`}
      onChange={event => { setText(event.target.value); setResult(''); setServiceResult(''); setAttempted(false); }} />
    <TextField select label="操作" value={operation} disabled={busy || applied} onChange={event => {
      setOperation(event.target.value as WritingOperation); setResult(''); setServiceResult(''); setAttempted(false);
    }}>{writingOperations.map(value => <MenuItem key={value} value={value}>{operationLabels[value]}</MenuItem>)}</TextField>
    <Typography variant="body2" color="text.secondary">润色、纠错、精简保留原语言与原意。确认只发送本段；无自动重试，不执行任意工具。返回内容仅为文字。</Typography>
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
      <Button variant="contained" disabled={!canSend || busy || applied} onClick={() => void run()}>确认发送并{operationLabels[operation]}</Button>
      <Button disabled={!busy} onClick={cancel}>取消请求</Button>
      <Button disabled={!attempted || !canSend || busy || applied} onClick={() => void run()}>重试本段</Button>
    </Stack>
    {busy && <LinearProgress aria-label="文字处理中" />}
    {notice && <Alert severity="info" role="status">{notice}</Alert>}
    {serviceResult && <>
      <TextField label="结果预览（可编辑）" multiline minRows={5} value={result} disabled={applied}
        onChange={event => setResult(event.target.value)} />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <Button disabled={applied} onClick={() => setResult(serviceResult)}>恢复服务结果</Button>
        <Button onClick={() => void copy(result)}>复制结果</Button>
        {capture && <Button variant="contained" disabled={!bindingValid || !capture.canApply || inputBusy || applied || !result.trim() || Array.from(result).length > 20_000}
          onClick={() => writeInput('apply', result)}>确认写回源字段</Button>}
      </Stack>
    </>}
    {capture && <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
      <Button disabled={!bindingValid || !applied || inputBusy} onClick={() => writeInput('restore')}>恢复源字段原文</Button>
      <Button onClick={() => void copy(capture.originalValue)}>复制源字段原文</Button>
    </Stack>}
    {inputNotice && <Alert severity="info" role="status">{inputNotice}</Alert>}
  </Stack></Paper>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<WorkbenchApp />);
