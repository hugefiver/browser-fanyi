import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, LinearProgress, Paper, Stack, TextField, Typography } from '@mui/material';
import type { Reply } from '../shared/contracts';
import {
  displaySelectionToCrop,
  exportImageCrop,
  imageErrorMessage,
  loadImageBlob,
  loadImageDataUrl,
  type ImageCrop,
  type ImagePoint,
  type LoadedImage,
  type PreparedImage,
} from '../shared/images';

export interface ImageConfiguration {
  revision: string;
  recipient: string;
  model: string;
  targetLanguage: string;
  ready: boolean;
}

export interface ImageRecognition {
  source: string;
  translation: string;
}

export interface ImagesPanelProps {
  configuration: ImageConfiguration;
  recognize(dataUrl: string, signal: AbortSignal): Promise<Reply<ImageRecognition>>;
  initialImage?: string;
}

type Phase = 'empty' | 'reading' | 'ready' | 'running' | 'complete';
type Notice = { severity: 'success' | 'info' | 'warning' | 'error'; text: string };
type ViewMode = 'image' | 'result';

function interruptedReply(): Reply<ImageRecognition> {
  return { ok: false, error: { code: 'interrupted', message: '图像识别已取消。' } };
}

function invokeRecognition(
  recognize: ImagesPanelProps['recognize'],
  dataUrl: string,
  controller: AbortController,
): Promise<Reply<ImageRecognition>> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (reply: Reply<ImageRecognition>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reply);
    };
    const timer = window.setTimeout(() => {
      finish({ ok: false, error: { code: 'timeout', message: '图像请求超过 25 秒，请主动重试。' } });
      controller.abort();
    }, 25_000);
    controller.signal.addEventListener('abort', () => finish(interruptedReply()), { once: true });
    void Promise.resolve()
      .then(() => controller.signal.aborted ? interruptedReply() : recognize(dataUrl, controller.signal))
      .then(finish, () => finish({ ok: false, error: { code: 'network', message: '图像请求失败，请检查服务后主动重试。' } }));
  });
}

function bytesLabel(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function ImagesPanel(props: ImagesPanelProps): React.ReactElement {
  const { configuration } = props;
  const key = JSON.stringify([
    configuration.revision,
    configuration.recipient,
    configuration.model,
    configuration.targetLanguage,
    configuration.ready,
  ]);
  return <ImageSession key={key} {...props} />;
}

function ImageSession({ configuration, recognize, initialImage }: ImagesPanelProps): React.ReactElement {
  const [loaded, setLoaded] = useState<LoadedImage>();
  const [sourceLabel, setSourceLabel] = useState('');
  const [crop, setCrop] = useState<ImageCrop>();
  const [prepared, setPrepared] = useState<PreparedImage>();
  const [result, setResult] = useState<ImageRecognition>();
  const [phase, setPhase] = useState<Phase>('empty');
  const [notice, setNotice] = useState<Notice>();
  const [viewMode, setViewMode] = useState<ViewMode>('image');
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const loadedRef = useRef<LoadedImage | undefined>(undefined);
  const dragStart = useRef<ImagePoint | undefined>(undefined);

  const disposeLoaded = () => {
    loadedRef.current?.dispose();
    loadedRef.current = undefined;
  };

  const beginLoad = async (factory: () => Promise<LoadedImage>, label: string) => {
    const current = ++generation.current;
    request.current?.abort();
    request.current = undefined;
    disposeLoaded();
    setLoaded(undefined);
    setPrepared(undefined);
    setCrop(undefined);
    setResult(undefined);
    setViewMode('image');
    setSourceLabel('');
    setPhase('reading');
    setNotice({ severity: 'info', text: '正在本机校验图像编码和真实尺寸…' });
    try {
      const next = await factory();
      if (generation.current !== current) {
        next.dispose();
        return;
      }
      loadedRef.current = next;
      setLoaded(next);
      setSourceLabel(label);
      setPhase('ready');
      setNotice({ severity: 'success', text: '图像已在本机解码，尚未发送任何图像数据。' });
    } catch (error) {
      if (generation.current !== current) return;
      setPhase('empty');
      setNotice({ severity: 'error', text: imageErrorMessage(error) });
    }
  };

  useEffect(() => () => {
    generation.current++;
    request.current?.abort();
    disposeLoaded();
  }, []);

  useEffect(() => {
    if (initialImage) void beginLoad(() => loadImageDataUrl(initialImage), '截图裁剪结果');
  }, [initialImage]);

  useEffect(() => {
    if (!loaded) {
      setPrepared(undefined);
      return;
    }
    try {
      setPrepared(exportImageCrop(loaded, crop));
      setNotice({ severity: 'success', text: '实际待发送 PNG 已在本机生成，尚未发送。' });
    } catch (error) {
      setPrepared(undefined);
      setNotice({ severity: 'error', text: imageErrorMessage(error) });
    }
  }, [loaded, crop]);

  const invalidateRecognition = () => {
    generation.current++;
    request.current?.abort();
    request.current = undefined;
    setResult(undefined);
    setViewMode('image');
    setPhase(loadedRef.current ? 'ready' : 'empty');
  };

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void beginLoad(() => loadImageBlob(file), file.name);
  };

  const changeCrop = (next: ImageCrop | undefined) => {
    invalidateRecognition();
    setPrepared(undefined);
    setCrop(next);
    if (next) setNotice({ severity: 'info', text: '正在本机生成所选区域的实际待发送 PNG…' });
  };

  const updateCropField = (field: keyof ImageCrop, value: string) => {
    if (!crop) return;
    changeCrop({ ...crop, [field]: Number(value) });
  };

  const finishDrag = (event: React.PointerEvent<HTMLImageElement>) => {
    const start = dragStart.current;
    dragStart.current = undefined;
    if (typeof event.currentTarget.hasPointerCapture === 'function'
      && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!start || !loaded) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    try {
      changeCrop(displaySelectionToCrop(
        start,
        { x: event.clientX, y: event.clientY },
        { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
        loaded,
      ));
    } catch (error) {
      setNotice({ severity: 'error', text: imageErrorMessage(error) });
    }
  };

  const cancel = () => {
    if (phase !== 'running') return;
    invalidateRecognition();
    setNotice({ severity: 'warning', text: '已取消图像请求；已发送的数据可能已被服务接收，迟到结果不会显示。' });
  };

  const send = async () => {
    if (!prepared || !configuration.ready || phase === 'running') return;
    const current = ++generation.current;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setResult(undefined);
    setViewMode('image');
    setPhase('running');
    setNotice({ severity: 'info', text: '正在发送已预览的 PNG 区域并等待当前模型响应…' });
    const reply = await invokeRecognition(recognize, prepared.dataUrl, controller);
    if (generation.current !== current) return;
    if (request.current === controller) request.current = undefined;
    if (!reply.ok) {
      setPhase('ready');
      setNotice({ severity: 'error', text: `${reply.error.code}：${reply.error.message}` });
      return;
    }
    if (!reply.value.source.trim() || !reply.value.translation.trim()) {
      setPhase('ready');
      setNotice({ severity: 'warning', text: '当前模型未返回可用的识别原文和译文；不会假设已识别成功。' });
      return;
    }
    setResult(reply.value);
    setViewMode('result');
    setPhase('complete');
    setNotice({ severity: 'success', text: '当前模型已返回识别原文和译文。' });
  };

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Typography component="h2" variant="h6">图像文字识别与翻译</Typography>
        <Typography variant="body2" color="text.secondary">
          支持 PNG、JPEG、WebP，编码不超过 4 MiB、真实尺寸不超过 1600 万像素。选择、拖选和坐标裁剪均只在本机处理。
        </Typography>
        <Alert severity="warning">
          当前模型的视觉能力未经验证。发送时仅使用您已配置的模型；不会在本机假设 OCR 成功，也不会自动换用其他服务或模型。不支持、拒绝、空结果和服务错误会原样反馈。
        </Alert>
        <Button variant="outlined" component="label">
          选择本地图像
          <input
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            aria-label="选择图像文件"
            onChange={chooseFile}
          />
        </Button>
        {phase === 'reading' && <LinearProgress aria-label="正在本地读取图像" />}
        {notice && <Alert severity={notice.severity} aria-live="polite">{notice.text}</Alert>}
        {!configuration.ready && (
          <Alert severity="info">当前服务尚未配置或授权。仍可在本机选择、裁剪并预览图像，但不能发送。</Alert>
        )}

        {loaded && (
          <>
            <Typography role="status" variant="body2">
              {sourceLabel} · {loaded.width} × {loaded.height} · 原编码 {bytesLabel(loaded.encodedBytes)}。此名称仅本地显示，不会发送。
            </Typography>

            {(!result || viewMode === 'image') && (
              <Stack spacing={2}>
                <Box component="section" role="region" aria-label="原图与裁剪区域">
                  <Typography variant="subtitle2" sx={{ mb: 1 }}>原图与可选裁剪范围</Typography>
                  <Box sx={{ position: 'relative', display: 'inline-block', maxWidth: '100%', lineHeight: 0 }}>
                    <Box
                      component="img"
                      src={loaded.previewUrl}
                      alt="待裁剪原图"
                      width={loaded.width}
                      height={loaded.height}
                      draggable={false}
                      onPointerDown={(event: React.PointerEvent<HTMLImageElement>) => {
                        event.preventDefault();
                        dragStart.current = { x: event.clientX, y: event.clientY };
                        if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                      onPointerUp={finishDrag}
                      sx={{ display: 'block', maxWidth: '100%', width: 'auto', height: 'auto', maxHeight: 420, cursor: 'crosshair', touchAction: 'none' }}
                    />
                    {crop && (
                      <Box aria-hidden="true" sx={{
                        position: 'absolute', pointerEvents: 'none', border: 2, borderColor: 'primary.main', bgcolor: 'primary.main', opacity: 0.24,
                        left: `${crop.x / loaded.width * 100}%`, top: `${crop.y / loaded.height * 100}%`,
                        width: `${crop.width / loaded.width * 100}%`, height: `${crop.height / loaded.height * 100}%`,
                      }} />
                    )}
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    可在图上拖选；坐标以原图真实像素为准。未启用裁剪时会明确使用整张图，不会静默裁减。
                  </Typography>
                </Box>

                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <Button
                    variant="outlined"
                    onClick={() => changeCrop({ x: 0, y: 0, width: loaded.width, height: loaded.height })}
                  >
                    启用坐标裁剪
                  </Button>
                  <Button variant="text" disabled={!crop} onClick={() => changeCrop(undefined)}>取消裁剪并使用整图</Button>
                </Stack>
                {crop && (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                    {(['x', 'y', 'width', 'height'] as const).map(field => (
                      <TextField
                        key={field}
                        type="number"
                        size="small"
                        label={{ x: '裁剪 X', y: '裁剪 Y', width: '裁剪宽度', height: '裁剪高度' }[field]}
                        value={crop[field]}
                        onChange={event => updateCropField(field, event.target.value)}
                        slotProps={{ htmlInput: { step: 1 } }}
                      />
                    ))}
                  </Stack>
                )}

                {prepared && (
                  <Box component="section" role="region" aria-label="实际待上传图像">
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>实际待上传 PNG</Typography>
                    <Box
                      component="img"
                      src={prepared.dataUrl}
                      alt="实际待上传 PNG 预览"
                      width={prepared.width}
                      height={prepared.height}
                      sx={{ display: 'block', maxWidth: '100%', width: 'auto', height: 'auto', maxHeight: 320 }}
                    />
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                      {prepared.width} × {prepared.height} · PNG 编码 {bytesLabel(prepared.encodedBytes)}。这是确认后会发送的确切像素区域。
                    </Typography>
                  </Box>
                )}
              </Stack>
            )}

            <Alert severity="warning">
              点击确认后仅发送上方实际待上传 PNG，不发送文件名。接收方：{configuration.recipient || '未配置'}；模型：{configuration.model || '未配置'}；目标语言：{configuration.targetLanguage}。请求可能消耗服务额度，图像和结果仅保留在当前面板会话。
            </Alert>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Button variant="contained" disabled={!prepared || !configuration.ready || phase === 'running'} onClick={() => void send()}>
                {phase === 'complete' ? '重新确认并发送当前区域' : '确认并发送当前区域'}
              </Button>
              <Button variant="outlined" color="warning" disabled={phase !== 'running'} onClick={cancel}>取消识别</Button>
            </Stack>

            {result && (
              <>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <Button variant={viewMode === 'image' ? 'contained' : 'outlined'} onClick={() => setViewMode('image')}>查看原图与发送区域</Button>
                  <Button variant={viewMode === 'result' ? 'contained' : 'outlined'} onClick={() => setViewMode('result')}>查看识别结果</Button>
                </Stack>
                {viewMode === 'result' && (
                  <Stack component="section" role="region" aria-label="图像识别结果" spacing={2}>
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>识别原文</Typography>
                      <Box component="pre" aria-label="识别原文内容" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{result.source}</Box>
                    </Box>
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>译文</Typography>
                      <Box component="pre" aria-label="图像译文内容" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{result.translation}</Box>
                    </Box>
                  </Stack>
                )}
              </>
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
}
