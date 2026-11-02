import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  Button,
  ButtonGroup,
  LinearProgress,
  Alert,
  Chip,
  Divider,
  Paper,
  Stack,
  IconButton,
  Tooltip,
} from '@mui/material';
import browser from '../shared/browser';
import {
  PublicSettings,
  PageStatus,
  PageAction,
  DisplayMode,
  Reply,
  SelectionState,
  idleStatus,
} from '../shared/contracts';
import { md2Theme } from './theme';
import { getLanguageLabel } from './languages';
import { isUnsupportedTabUrl } from './tab-utils';
import { SiteRulesPanel } from './site-rules';

const phaseLabels: Record<PageStatus['phase'], string> = {
  idle: '未翻译',
  running: '正在翻译...',
  complete: '翻译完成',
  paused: '已暂停',
  partial: '部分失败',
  interrupted: '已中断',
  empty: '页面无文本',
  limit: '达到单次上限',
};

export const PopupApp: React.FC = () => {
  const [tabId, setTabId] = useState<number | null>(null);
  const [windowId, setWindowId] = useState<number | null>(null);
  const [tabUrl, setTabUrl] = useState<string>('');
  const [isUnsupportedTab, setIsUnsupportedTab] = useState<boolean>(false);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [pageStatus, setPageStatus] = useState<PageStatus>(idleStatus());
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [loadingAction, setLoadingAction] = useState<boolean>(false);

  // 初始化获取当前 Tab
  useEffect(() => {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const active = tabs[0];
      if (!active || active.id == null) {
        setIsUnsupportedTab(true);
        return;
      }
      setTabId(active.id);
      setWindowId(active.windowId ?? null);
      const url = active.url || '';
      setTabUrl(url);
      if (isUnsupportedTabUrl(url)) {
        setIsUnsupportedTab(true);
      }
    });
  }, []);

  // 获取设置
  const fetchSettings = useCallback(async () => {
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'settings.get',
      })) as Reply<PublicSettings>;
      if (res.ok) {
        setSettings(res.value);
      } else {
        setActionError(res.error.message);
      }
    } catch {
      setActionError('无法读取扩展设置。');
    }
  }, []);

  // 获取页面状态
  const fetchStatus = useCallback(async () => {
    if (tabId == null || isUnsupportedTab) return;
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'page.status',
        tabId,
      })) as Reply<PageStatus>;
      if (res.ok) {
        setPageStatus(res.value);
      } else {
        // 如果后台返回错误，例如 unsupported
        if (res.error.code === 'unsupported') {
          setIsUnsupportedTab(true);
        }
      }
    } catch {
      // 捕获异常
    }
  }, [tabId, isUnsupportedTab]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // 状态轮询：仅在 popup 打开且有合法 tab 时执行
  useEffect(() => {
    if (tabId == null || isUnsupportedTab) return;
    fetchStatus();
    const interval = setInterval(fetchStatus, 800);
    return () => clearInterval(interval);
  }, [tabId, isUnsupportedTab, fetchStatus]);

  // 发送页面翻译控制命令
  const handlePageCommand = async (action: PageAction, mode?: DisplayMode) => {
    if (tabId == null) return;
    setActionError(null);
    setActionSuccess(null);
    setLoadingAction(true);
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'page.command',
        tabId,
        action,
        mode,
      })) as Reply<PageStatus>;
      if (res.ok) {
        setPageStatus(res.value);
      } else {
        setActionError(res.error.message);
      }
    } catch {
      setActionError('发送操作指令失败，请稍后重试。');
    } finally {
      setLoadingAction(false);
    }
  };

  const handleHoverCommand = async (enabled: boolean) => {
    if (tabId == null) return;
    setActionError(null);
    setActionSuccess(null);
    setLoadingAction(true);
    try {
      const res = (await browser.runtime.sendMessage({ type: 'hover.command', tabId, enabled })) as Reply<PageStatus>;
      if (res.ok) setPageStatus(res.value);
      else setActionError(res.error.message);
    } catch {
      setActionError('指向翻译启停失败，请稍后重试。');
    } finally {
      setLoadingAction(false);
    }
  };

  // 触发选区翻译
  const handleSelectionTranslate = async () => {
    if (tabId == null) return;
    setActionError(null);
    setActionSuccess(null);
    setLoadingAction(true);
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'selection.start',
        tabId,
      })) as Reply<SelectionState>;
      if (res.ok) {
        setActionSuccess('已在新标签页打开选区翻译结果。');
      } else {
        setActionError(res.error.message);
      }
    } catch {
      setActionError('选区翻译发起失败。');
    } finally {
      setLoadingAction(false);
    }
  };

  const handleOpenOptions = () => {
    if (browser.runtime.openOptionsPage) {
      browser.runtime.openOptionsPage();
    } else {
      window.open(browser.runtime.getURL('options.html'));
    }
  };

  const handleOpenSubtitles = async () => {
    setActionError(null);
    try {
      await browser.tabs.create({ url: browser.runtime.getURL('subtitles.html') });
    } catch {
      setActionError('无法打开 SRT 字幕翻译页面。');
    }
  };

  const openWorkbench = async () => {
    setActionError(null);
    try { await browser.tabs.create({ url: browser.runtime.getURL('workbench.html') }); }
    catch { setActionError('无法打开工作台。'); }
  };

  const captureInput = async () => {
    if (tabId === null) return;
    setLoadingAction(true);
    setActionError(null);
    try {
      const reply = await browser.runtime.sendMessage({ type: 'input.start', tabId }) as Reply<null>;
      if (!reply.ok) setActionError(reply.error.message);
    } catch { setActionError('无法捕获源字段，请聚焦普通网页中的输入框后再次打开工具栏。'); }
    finally { setLoadingAction(false); }
  };

  const openSidebar = () => {
    setActionError(null);
    const native = globalThis as typeof globalThis & {
      chrome?: { sidePanel?: { open: (options: { windowId: number }) => Promise<void> } };
    };
    let opened: Promise<void>;
    if (native.chrome?.sidePanel?.open && windowId !== null) opened = native.chrome.sidePanel.open({ windowId });
    else if (browser.sidebarAction?.open) opened = browser.sidebarAction.open();
    else { setActionError('当前浏览器没有可用的原生侧栏能力，请使用工作台标签页。'); return; }
    void opened.catch(() => setActionError('原生侧栏打开失败，请检查浏览器权限或使用工作台标签页。'));
  };

  const isConfigured = Boolean(
    settings && settings.prefix.trim() && settings.model.trim()
  );
  const isAuthorized = Boolean(settings && settings.authorized);

  // 计算进度百分比
  const progressPercent =
    pageStatus.total > 0
      ? Math.min(100, Math.round((pageStatus.completed / pageStatus.total) * 100))
      : 0;

  const currentMode = pageStatus.mode || settings?.mode || 'bilingual';

  return (
    <Box sx={{ width: 360, p: 2, bgcolor: 'background.default' }}>
      {/* 顶部标题栏 */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Typography variant="h6" sx={{ fontSize: '1.1rem', fontWeight: 600 }}>
          网页翻译
        </Typography>
        <Button
          size="small"
          variant="outlined"
          onClick={handleOpenOptions}
          sx={{ py: 0.25, px: 1, fontSize: '0.8rem' }}
        >
          设置
        </Button>
      </Stack>

      {/* 配置状态提示 */}
      {!isConfigured && (
        <Alert
          severity="warning"
          sx={{ mb: 1.5, py: 0.5 }}
          action={
            <Button color="inherit" size="small" onClick={handleOpenOptions}>
              去配置
            </Button>
          }
        >
          未配置有效服务地址或模型。
        </Alert>
      )}

      {isConfigured && !isAuthorized && (
        <Alert
          severity="warning"
          sx={{ mb: 1.5, py: 0.5 }}
          action={
            <Button color="inherit" size="small" onClick={handleOpenOptions}>
              去授权
            </Button>
          }
        >
          所配服务主机尚未获得权限授权。
        </Alert>
      )}

      {isUnsupportedTab && (
        <Alert severity="info" sx={{ mb: 1.5, py: 0.5 }}>
          无法访问此页面，请在普通展示型网页中使用。
        </Alert>
      )}

      {pageStatus.phase === 'empty' && (
        <Alert severity="info" sx={{ mb: 1.5, py: 0.5 }}>
          当前页面未检测到可翻译的有效普通文字。
        </Alert>
      )}

      {pageStatus.phase === 'limit' && (
        <Alert
          severity="warning"
          sx={{ mb: 1.5, py: 0.5 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => handlePageCommand('resume')}
              disabled={loadingAction}
            >
              继续
            </Button>
          }
        >
          已达到单次会话上限（100 请求），请点击继续处理后续文字。
        </Alert>
      )}

      {actionError && (
        <Alert severity="error" sx={{ mb: 1.5, py: 0.5 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {actionSuccess && (
        <Alert severity="success" sx={{ mb: 1.5, py: 0.5 }} onClose={() => setActionSuccess(null)}>
          {actionSuccess}
        </Alert>
      )}

      {pageStatus.error && !actionError && (
        <Alert severity="error" sx={{ mb: 1.5, py: 0.5 }}>
          {pageStatus.error.message}
        </Alert>
      )}

      {/* 基础配置与当前状态卡片 */}
      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, bgcolor: 'background.paper' }}>
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">
              服务配置:
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 500, maxWidth: 200 }} noWrap>
              {settings?.prefix ? settings.prefix : '未设置'}
            </Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">
              模型 / 语言:
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {settings?.model || '未设置'} · {getLanguageLabel(settings?.targetLanguage || 'zh-CN')}
            </Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">
              显示模式:
            </Typography>
            <Chip
              size="small"
              label={currentMode === 'bilingual' ? '双语对照' : '仅译文'}
              variant="outlined"
              color="primary"
            />
          </Stack>
          <Divider sx={{ my: 0.5 }} />
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">
              状态:
            </Typography>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                color:
                  pageStatus.phase === 'running'
                    ? 'primary.main'
                    : pageStatus.phase === 'partial' || pageStatus.phase === 'limit'
                    ? 'warning.main'
                    : pageStatus.phase === 'interrupted'
                    ? 'error.main'
                    : 'text.primary',
              }}
            >
              {pageStatus.hoverEnabled ? '指向翻译已启用' : phaseLabels[pageStatus.phase]}
            </Typography>
          </Stack>

          {/* 进度条与数量统计 */}
          {pageStatus.total > 0 && (
            <Box sx={{ mt: 0.5 }}>
              <LinearProgress
                variant="determinate"
                value={progressPercent}
                sx={{ height: 6, borderRadius: 3, mb: 0.5 }}
              />
              <Typography variant="caption" color="text.secondary" display="block">
                总计 {pageStatus.total} 块 · 已完成 {pageStatus.completed}
                {pageStatus.failed > 0 && ` · 失败 ${pageStatus.failed}`}
                {pageStatus.pending > 0 && ` · 待处理 ${pageStatus.pending}`}
              </Typography>
            </Box>
          )}
        </Stack>
      </Paper>

      {/* 页面操作按钮组 */}
      <Stack spacing={1}>
        <Stack direction="row" spacing={1}>
          {pageStatus.phase === 'running' ? (
            <Button
              fullWidth
              variant="contained"
              color="primary"
              onClick={() => handlePageCommand('pause')}
              disabled={loadingAction || isUnsupportedTab}
            >
              暂停翻译
            </Button>
          ) : pageStatus.phase === 'paused' || pageStatus.phase === 'limit' ? (
            <Button
              fullWidth
              variant="contained"
              color="primary"
              onClick={() => handlePageCommand('resume')}
              disabled={loadingAction || isUnsupportedTab}
            >
              继续翻译
            </Button>
          ) : pageStatus.phase === 'complete' || pageStatus.phase === 'empty' || pageStatus.phase === 'partial' ? (
            <>
              <Button
                fullWidth
                variant="outlined"
                color="primary"
                onClick={() => handlePageCommand('pause')}
                disabled={loadingAction || isUnsupportedTab}
              >
                暂停翻译
              </Button>
              <Button
                fullWidth
                variant="contained"
                color="primary"
                onClick={() => handlePageCommand('start')}
                disabled={loadingAction || isUnsupportedTab || !isConfigured || !isAuthorized}
              >
                重新翻译
              </Button>
            </>
          ) : (
            <Button
              fullWidth
              variant="contained"
              color="primary"
              onClick={() => handlePageCommand('start')}
              disabled={loadingAction || isUnsupportedTab || !isConfigured || !isAuthorized}
            >
              开始翻译
            </Button>
          )}

          {pageStatus.failed > 0 && (
            <Button
              variant="outlined"
              color="warning"
              onClick={() => handlePageCommand('retry')}
              disabled={loadingAction || isUnsupportedTab}
              sx={{ whiteSpace: 'nowrap' }}
            >
              重试失败
            </Button>
          )}
        </Stack>

        <Stack direction="row" spacing={1}>
          <Button
            fullWidth
            variant="outlined"
            onClick={() =>
              handlePageCommand('mode', currentMode === 'bilingual' ? 'translation' : 'bilingual')
            }
            disabled={loadingAction || isUnsupportedTab}
            size="small"
          >
            切换为{currentMode === 'bilingual' ? '仅译文' : '双语对照'}
          </Button>

          <Button
            fullWidth
            variant="outlined"
            color="inherit"
            onClick={() => handlePageCommand('restore')}
            disabled={loadingAction || isUnsupportedTab || pageStatus.phase === 'idle'}
            size="small"
          >
            还原页面
          </Button>
        </Stack>

        <Divider sx={{ my: 0.5 }} />

        <Stack spacing={0.5}>
          <Button
            fullWidth
            variant={pageStatus.hoverEnabled ? 'contained' : 'outlined'}
            color={pageStatus.hoverEnabled ? 'warning' : 'secondary'}
            onClick={() => handleHoverCommand(!pageStatus.hoverEnabled)}
            disabled={loadingAction || isUnsupportedTab || (!pageStatus.hoverEnabled && (!isConfigured || !isAuthorized))}
            size="small"
          >
            {pageStatus.hoverEnabled ? '关闭指向翻译' : '启用指向翻译'}
          </Button>
          <Typography variant="caption" color="text.secondary">
            启用后，按住 Alt 并左键点击普通文字；普通移动和点击不会发送内容。
          </Typography>
        </Stack>

        <Divider sx={{ my: 0.5 }} />

        {/* 选区翻译按钮 */}
        <Button
          fullWidth
          variant="outlined"
          color="secondary"
          onClick={handleSelectionTranslate}
          disabled={loadingAction || isUnsupportedTab}
          size="small"
        >
          选区翻译（在新标签页打开）
        </Button>

        <Divider sx={{ my: 0.5 }} />

        <Button
          fullWidth
          variant="outlined"
          onClick={() => void handleOpenSubtitles()}
          size="small"
        >
          SRT 字幕翻译（在新标签页打开）
        </Button>
        <SiteRulesPanel settings={settings} tab={tabId !== null && !isUnsupportedTab ? { id: tabId, url: tabUrl } : undefined} />
        <Button fullWidth variant="outlined" onClick={() => void openWorkbench()}>翻译与写作工作台</Button>
        <Button fullWidth variant="outlined" onClick={openSidebar}>打开原生侧栏</Button>
        <Button fullWidth variant="outlined" disabled={loadingAction || isUnsupportedTab || tabId === null}
          onClick={() => void captureInput()}>捕获输入并打开工作台</Button>
        <Typography variant="caption" color="text.secondary">
          输入辅助先捕获当前聚焦字段，发送后仅预览；另行确认才写回。密码、验证码和支付字段不可用。
        </Typography>
      </Stack>
    </Box>
  );
};

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <ThemeProvider theme={md2Theme}>
        <CssBaseline />
        <PopupApp />
      </ThemeProvider>
    </React.StrictMode>
  );
}
