import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  Button,
  LinearProgress,
  Alert,
  Paper,
  Stack,
  Divider,
  Chip,
} from '@mui/material';
import browser from '../shared/browser';
import { SelectionState, Reply } from '../shared/contracts';
import { md2Theme } from './theme';

export const SelectionApp: React.FC = () => {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [state, setState] = useState<SelectionState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [retrying, setRetrying] = useState<boolean>(false);
  const [closing, setClosing] = useState<boolean>(false);

  const pollTimerRef = useRef<number | null>(null);

  // 清除轮询定时器
  const clearPoll = () => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // 获取任务状态
  const fetchTaskState = useCallback(async (id: string) => {
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'selection.get',
        id,
      })) as Reply<SelectionState>;

      if (res.ok) {
        setState(res.value);
        setLoading(false);
        // 如果已完成或失败，停止轮询
        if (res.value.phase === 'complete' || res.value.phase === 'failed') {
          clearPoll();
        }
      } else {
        // 后台丢失任务或出错，明确中断，绝不永久 loading
        clearPoll();
        setLoading(false);
        setFatalError(res.error.message || '翻译任务已中断或不存在。');
      }
    } catch {
      clearPoll();
      setLoading(false);
      setFatalError('无法连接后台服务以获取选区状态。');
    }
  }, []);

  // 初始化：读取 URL 参数中的 id
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (!id) {
      setLoading(false);
      setFatalError('未指定选区翻译任务 ID。');
      return;
    }
    setTaskId(id);
    fetchTaskState(id);

    // 开启轮询
    const timer = window.setInterval(() => {
      fetchTaskState(id);
    }, 600);
    pollTimerRef.current = timer;

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [fetchTaskState]);

  // 关闭操作：发送 close 给后台，然后 window.close()
  const handleClose = async () => {
    if (closing) return;
    setClosing(true);
    clearPoll();
    if (taskId) {
      try {
        await browser.runtime.sendMessage({
          type: 'selection.close',
          id: taskId,
        });
      } catch {
        // 忽略关闭时的异常
      }
    }
    window.close();
  };

  // 失败重试
  const handleRetry = async () => {
    if (!taskId || retrying) return;
    setRetrying(true);
    setFatalError(null);
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'selection.retry',
        id: taskId,
      })) as Reply<SelectionState>;

      if (res.ok) {
        setState(res.value);
        // 如果重新回到 running，恢复轮询
        if (res.value.phase === 'running') {
          clearPoll();
          pollTimerRef.current = window.setInterval(() => {
            fetchTaskState(taskId);
          }, 600);
        }
      } else {
        setFatalError(res.error.message || '重试操作被拒绝。');
      }
    } catch {
      setFatalError('重试请求失败。');
    } finally {
      setRetrying(false);
    }
  };

  // 主动点击复制译文（绝不自动复制）
  const handleCopy = async () => {
    if (!state?.text) return;
    setCopyStatus(null);
    try {
      await navigator.clipboard.writeText(state.text);
      setCopyStatus({ success: true, message: '译文已复制到剪贴板。' });
      setTimeout(() => {
        setCopyStatus(null);
      }, 3000);
    } catch {
      setCopyStatus({
        success: false,
        message: '写入剪贴板失败，请手动选中文本进行复制。',
      });
    }
  };

  return (
    <Box sx={{ maxWidth: 640, mx: 'auto', p: { xs: 2, sm: 3 } }}>
      {/* 头部标题与操作 */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Typography variant="h6" component="h1" sx={{ fontWeight: 600, fontSize: '1.15rem' }}>
            选区翻译
          </Typography>
          {state && (
            <Chip
              size="small"
              label={
                state.phase === 'running'
                  ? '翻译中'
                  : state.phase === 'complete'
                  ? '已完成'
                  : '失败'
              }
              color={
                state.phase === 'running'
                  ? 'primary'
                  : state.phase === 'complete'
                  ? 'success'
                  : 'error'
              }
              variant="outlined"
            />
          )}
        </Stack>
        <Button
          variant="outlined"
          color="inherit"
          size="small"
          onClick={handleClose}
          disabled={closing}
        >
          关闭
        </Button>
      </Stack>

      {/* 致命中断错误 */}
      {fatalError && (
        <Alert severity="error" sx={{ mb: 2.5 }}>
          {fatalError}
        </Alert>
      )}

      {/* 复制反馈 */}
      {copyStatus && (
        <Alert
          severity={copyStatus.success ? 'success' : 'error'}
          sx={{ mb: 2.5 }}
          onClose={() => setCopyStatus(null)}
        >
          {copyStatus.message}
        </Alert>
      )}

      {/* 加载中状态 */}
      {loading && !fatalError && (
        <Box sx={{ my: 3 }}>
          <LinearProgress sx={{ borderRadius: 2, height: 6, mb: 1.5 }} />
          <Typography variant="body2" color="text.secondary">
            正在获取选区翻译任务状态...
          </Typography>
        </Box>
      )}

      {/* 任务内容展示 */}
      {state && (
        <Stack spacing={2.5}>
          {/* 原文卡片 */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, fontWeight: 600 }}>
              选区原文
            </Typography>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                bgcolor: 'grey.50',
                borderRadius: 1,
                fontFamily: 'inherit',
                fontSize: '0.9rem',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 200,
                overflowY: 'auto',
                border: '1px solid',
                borderColor: 'grey.200',
              }}
            >
              {state.source || '（无原文内容）'}
            </Box>
          </Paper>

          {/* 译文卡片 */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                翻译结果
              </Typography>
              {state.phase === 'complete' && state.text && (
                <Button
                  size="small"
                  variant="outlined"
                  color="primary"
                  onClick={handleCopy}
                  sx={{ py: 0.25, px: 1, fontSize: '0.8rem' }}
                >
                  复制译文
                </Button>
              )}
            </Stack>

            {state.phase === 'running' && (
              <Box sx={{ py: 2 }}>
                <LinearProgress sx={{ borderRadius: 2, height: 6, mb: 1.5 }} />
                <Typography variant="body2" color="text.secondary">
                  正在等待翻译服务响应...
                </Typography>
              </Box>
            )}

            {state.phase === 'complete' && (
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1.5,
                  bgcolor: '#ffffff',
                  borderRadius: 1,
                  fontFamily: 'inherit',
                  fontSize: '0.95rem',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 320,
                  overflowY: 'auto',
                  border: '1px solid',
                  borderColor: 'primary.light',
                }}
              >
                {state.text || '（译文为空）'}
              </Box>
            )}

            {state.phase === 'failed' && (
              <Box sx={{ py: 1 }}>
                <Alert severity="error" sx={{ mb: 1.5 }}>
                  {state.error?.message || '翻译失败，服务未返回有效文本。'}
                </Alert>
                <Button
                  variant="contained"
                  color="warning"
                  size="small"
                  onClick={handleRetry}
                  disabled={retrying}
                >
                  {retrying ? '正在重试...' : '重试翻译'}
                </Button>
              </Box>
            )}
          </Paper>

          <Divider />

          {/* 底部关闭按钮 */}
          <Box sx={{ textAlign: 'right' }}>
            <Button
              variant="contained"
              color="primary"
              onClick={handleClose}
              disabled={closing}
            >
              完成并关闭
            </Button>
          </Box>
        </Stack>
      )}
    </Box>
  );
};

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <ThemeProvider theme={md2Theme}>
        <CssBaseline />
        <SelectionApp />
      </ThemeProvider>
    </React.StrictMode>
  );
}
