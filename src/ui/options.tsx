import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Typography,
  TextField,
  Button,
  Alert,
  Paper,
  Stack,
  Divider,
  MenuItem,
  Chip,
} from '@mui/material';
import browser from '../shared/browser';
import {
  PublicSettings,
  SaveSettings,
  DisplayMode,
  Reply,
  defaultPreferences,
} from '../shared/contracts';
import { endpoint } from '../shared/endpoint';
import { md2Theme } from './theme';
import { sourceLanguageOptions, targetLanguageOptions } from './languages';
import { resolveDraftOrigin, shouldClearKeyInput, buildKeyAction } from './options-logic';
import { GlossaryPanel } from './glossary';
import { SiteRulesPanel } from './site-rules';

export const OptionsApp: React.FC = () => {
  const [savedSettings, setSavedSettings] = useState<PublicSettings | null>(null);

  const [prefix, setPrefix] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [sourceLanguage, setSourceLanguage] = useState<string>(defaultPreferences.sourceLanguage);
  const [targetLanguage, setTargetLanguage] = useState<string>(defaultPreferences.targetLanguage);
  const [mode, setMode] = useState<DisplayMode>(defaultPreferences.mode);

  const [prefixError, setPrefixError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    severity: 'success' | 'info' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [authorizing, setAuthorizing] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [glossaryReloadKey, setGlossaryReloadKey] = useState(0);

  const prevDraftOriginRef = useRef<string | null>(null);

  const loadSettings = async () => {
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'settings.get',
      })) as Reply<PublicSettings>;
      if (res.ok) {
        const val = res.value;
        setSavedSettings(val);
        setPrefix(val.prefix);
        setModel(val.model);
        setSourceLanguage(val.sourceLanguage);
        setTargetLanguage(val.targetLanguage);
        setMode(val.mode);
        setApiKey('');
        prevDraftOriginRef.current = resolveDraftOrigin(val.prefix);
      } else {
        setStatusMessage({ severity: 'error', text: res.error.message });
      }
    } catch {
      setStatusMessage({ severity: 'error', text: '读取设置失败。' });
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handlePrefixChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextVal = e.target.value;
    setPrefix(nextVal);

    const nextOrigin = resolveDraftOrigin(nextVal);
    if (shouldClearKeyInput(prevDraftOriginRef.current, nextOrigin)) {
      setApiKey('');
    }
    prevDraftOriginRef.current = nextOrigin;

    if (!nextVal.trim()) {
      setPrefixError(null);
      return;
    }

    try {
      endpoint(nextVal);
      setPrefixError(null);
    } catch (err) {
      setPrefixError(err instanceof Error ? err.message : '服务地址格式不符合规范');
    }
  };

  const handleSave = async () => {
    setStatusMessage(null);

    let ep;
    try {
      ep = endpoint(prefix);
    } catch (err) {
      setStatusMessage({ severity: 'error', text: err instanceof Error ? err.message : '服务地址不合法' });
      return;
    }

    if (!model.trim()) {
      setStatusMessage({ severity: 'error', text: '请填写模型名称。' });
      return;
    }

    const savedOrigin = savedSettings?.prefix ? resolveDraftOrigin(savedSettings.prefix) || '' : '';
    const keyAction = buildKeyAction({
      apiKey,
      currentOrigin: ep.origin,
      savedOrigin,
      savedHasKey: Boolean(savedSettings?.hasKey),
    });

    const payload: SaveSettings = {
      prefix: ep.prefix,
      model: model.trim(),
      sourceLanguage,
      targetLanguage,
      mode,
      key: keyAction,
    };

    setSaving(true);
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'settings.save',
        settings: payload,
      })) as Reply<PublicSettings>;

      if (res.ok) {
        setSavedSettings(res.value);
        setPrefix(res.value.prefix);
        setModel(res.value.model);
        setApiKey('');
        prevDraftOriginRef.current = resolveDraftOrigin(res.value.prefix);
        setStatusMessage({
          severity: 'success',
          text: '设置已成功保存到本地存储（保存未发起网络请求）。',
        });
      } else {
        setStatusMessage({ severity: 'error', text: `保存失败: ${res.error.message}` });
      }
    } catch {
      setStatusMessage({ severity: 'error', text: '保存设置时出现异常。' });
    } finally {
      setSaving(false);
    }
  };

  const handleRequestPermission = async () => {
    setStatusMessage(null);

    if (!savedSettings?.prefix) {
      setStatusMessage({
        severity: 'warning',
        text: '请先保存服务前缀地址，然后再进行主机权限授权。',
      });
      return;
    }

    const perm = endpoint(savedSettings.prefix).permission;
    setAuthorizing(true);
    try {
      const granted = await browser.permissions.request({ origins: [perm] });
      if (granted) {
        await loadSettings();
        setStatusMessage({ severity: 'success', text: `已成功授权主机权限: ${perm}` });
      } else {
        setStatusMessage({
          severity: 'warning',
          text: '用户取消或拒绝了主机权限授权，扩展将无法连接所配服务。',
        });
      }
    } catch {
      setStatusMessage({ severity: 'error', text: '请求权限时发生错误。' });
    } finally {
      setAuthorizing(false);
    }
  };

  const handleTestService = async () => {
    setStatusMessage(null);

    if (!savedSettings?.prefix || !savedSettings?.model) {
      setStatusMessage({ severity: 'warning', text: '请先填写并保存服务地址与模型，再进行测试。' });
      return;
    }

    if (!savedSettings.authorized) {
      setStatusMessage({ severity: 'warning', text: '所配服务尚未获得主机权限，请先点击“授权主机”按钮。' });
      return;
    }

    setTesting(true);
    try {
      const res = (await browser.runtime.sendMessage({ type: 'service.test' })) as Reply<unknown>;
      if (res.ok) {
        setStatusMessage({ severity: 'success', text: '服务连接测试成功！已向服务端点发送微小测试文本并收到正确响应。' });
      } else {
        setStatusMessage({ severity: 'error', text: `测试失败 [${res.error.code}]: ${res.error.message}` });
      }
    } catch {
      setStatusMessage({ severity: 'error', text: '连接测试请求失败，请检查网络。' });
    } finally {
      setTesting(false);
    }
  };

  const handleClearSettings = async (all: boolean) => {
    setStatusMessage(null);
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'settings.clear',
        all,
      })) as Reply<PublicSettings>;

      if (res.ok) {
        setSavedSettings(res.value);
        setPrefix(res.value.prefix);
        setModel(res.value.model);
        setSourceLanguage(res.value.sourceLanguage);
        setTargetLanguage(res.value.targetLanguage);
        setMode(res.value.mode);
        setApiKey('');
        prevDraftOriginRef.current = resolveDraftOrigin(res.value.prefix);
        if (all) setGlossaryReloadKey((value) => value + 1);
        setStatusMessage({
          severity: 'success',
          text: all ? '已清除全部数据与偏好设置。' : '已清除服务地址、模型与密钥配置。',
        });
      } else {
        setStatusMessage({ severity: 'error', text: `清除失败: ${res.error.message}` });
      }
    } catch {
      setStatusMessage({ severity: 'error', text: '清除操作失败。' });
    }
  };

  const currentDraftOrigin = resolveDraftOrigin(prefix);
  const savedOrigin = savedSettings?.prefix ? resolveDraftOrigin(savedSettings.prefix) : null;
  const isOriginMismatched = Boolean(currentDraftOrigin && savedOrigin && currentDraftOrigin !== savedOrigin);

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', p: { xs: 2, sm: 3 } }}>
      <Typography variant="h5" component="h1" sx={{ fontWeight: 600, mb: 2 }}>
        翻译扩展设置
      </Typography>

      <Alert severity="info" sx={{ mb: 3 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
          使用须知与隐私边界说明
        </Typography>
        <Typography variant="body2" component="div">
          1. <strong>按需发送</strong>：仅在您主动发起翻译时，将待翻译文字发送至您所配置的翻译服务。未启动翻译时不发送任何页面文本。<br />
          2. <strong>服务与费用</strong>：本扩展不提供内置模型，所有请求发送至您指定的服务地址，相关 API 费用或额度消耗由您自行承担。<br />
          3. <strong>敏感信息提示</strong>：网页文本中可能包含敏感信息，扩展无法自动脱敏，请谨慎选择受信任的接收方。<br />
          4. <strong>本地存储凭据</strong>：API 密钥保存在浏览器扩展本地存储中，未进行高强度本地加密，请勿在不信任的设备上保存关键凭据。
        </Typography>
      </Alert>

      {statusMessage && (
        <Alert
          severity={statusMessage.severity}
          sx={{ mb: 3 }}
          onClose={() => setStatusMessage(null)}
        >
          {statusMessage.text}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600, mb: 2 }}>
          翻译服务配置 (OpenAI 兼容 Chat Completions)
        </Typography>

        <Stack spacing={2.5}>
          <TextField
            fullWidth
            label="API 前缀地址 (Prefix)"
            value={prefix}
            onChange={handlePrefixChange}
            error={Boolean(prefixError)}
            helperText={
              prefixError ||
              '仅支持 HTTPS 地址，或本地 HTTP 地址 (http://localhost 或 http://127.0.0.1)。末尾不含斜杠。'
            }
            placeholder="https://api.example.com/v1"
            size="small"
          />

          <TextField
            fullWidth
            label="模型名称 (Model)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            helperText="填写服务所支持的模型标识。"
            placeholder="服务提供的模型标识"
            size="small"
          />

          <Box>
            <TextField
              fullWidth
              type="password"
              label="API 密钥 (Key，可选)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              helperText={
                isOriginMismatched
                  ? '服务主机已更改，原主机的密钥无法沿用，如需密钥请重新填写。'
                  : savedSettings?.hasKey
                  ? '当前已保存密钥。如无需更换可留空；填写新密钥并保存将覆盖旧密钥。'
                  : '可选填写。保存后输入框将自动清空，密钥保存在本机扩展存储中。'
              }
              placeholder={savedSettings?.hasKey && !isOriginMismatched ? '•••••••• (已保存密钥)' : '可选'}
              size="small"
            />
          </Box>

          <Divider />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Box sx={{ flex: 1 }}>
              <TextField
                select
                fullWidth
                size="small"
                label="源语言"
                value={sourceLanguage}
                onChange={(e) => setSourceLanguage(e.target.value)}
              >
                {sourceLanguageOptions.map((opt) => (
                  <MenuItem key={opt.code} value={opt.code}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>
            </Box>

            <Box sx={{ flex: 1 }}>
              <TextField
                select
                fullWidth
                size="small"
                label="目标语言"
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
              >
                {targetLanguageOptions.map((opt) => (
                  <MenuItem key={opt.code} value={opt.code}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>
            </Box>

            <Box sx={{ flex: 1 }}>
              <TextField
                select
                fullWidth
                size="small"
                label="默认显示模式"
                value={mode}
                onChange={(e) => setMode(e.target.value as DisplayMode)}
              >
                <MenuItem value="bilingual">双语对照</MenuItem>
                <MenuItem value="translation">仅译文</MenuItem>
              </TextField>
            </Box>
          </Stack>

          <Box sx={{ pt: 1 }}>
            <Button
              variant="contained"
              color="primary"
              onClick={handleSave}
              disabled={saving}
              sx={{ minWidth: 120 }}
            >
              {saving ? '正在保存...' : '保存设置'}
            </Button>
            <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
              保存操作仅写入本机存储，不发起任何网络连接。
            </Typography>
          </Box>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600, mb: 2 }}>
          主机权限授权与连接测试
        </Typography>

        <Stack spacing={2}>
          <Box>
            <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1 }}>
              <Button
                variant="outlined"
                color="primary"
                onClick={handleRequestPermission}
                disabled={authorizing || !savedSettings?.prefix}
              >
                {authorizing ? '正在请求授权...' : '授权主机权限'}
              </Button>
              {savedSettings?.authorized ? (
                <Chip size="small" label="已授权" color="success" variant="outlined" />
              ) : (
                <Chip size="small" label="未授权" color="warning" variant="outlined" />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block">
              依据浏览器安全策略，必须由您的点击直接发起主机权限申请。权限基于当前已保存的服务前缀 Origin 计算。
            </Typography>
          </Box>

          <Divider />

          <Box>
            <Button
              variant="outlined"
              color="secondary"
              onClick={handleTestService}
              disabled={testing || !savedSettings?.prefix || !savedSettings?.authorized}
              sx={{ mb: 1 }}
            >
              {testing ? '正在测试...' : '测试服务连接'}
            </Button>
            <Typography variant="caption" color="text.secondary" display="block">
              <strong>网络提示</strong>：测试将向所配端点发送微小固定文本（如“Hello”）以校验接口与模型连通性。该操作会产生实际网络请求，可能消耗微量额度。
            </Typography>
          </Box>
        </Stack>
      </Paper>

      <GlossaryPanel reloadKey={glossaryReloadKey} />
      <Paper sx={{ p: 3, my: 3 }}><SiteRulesPanel settings={savedSettings} /></Paper>

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600, mb: 2 }}>
          清除本地配置
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          您可以随时清空本机保存的服务配置或重置扩展所有数据。清除后，本扩展不再使用原有凭据发起新请求。
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Button
            variant="outlined"
            color="warning"
            onClick={() => handleClearSettings(false)}
          >
            仅清除服务配置（地址、模型、密钥）
          </Button>
          <Button
            variant="outlined"
            color="error"
            onClick={() => handleClearSettings(true)}
          >
            清除全部数据（恢复初始状态）
          </Button>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3, bgcolor: '#fbfbfb' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
          系统运行限制与规格清单
        </Typography>
        <Stack spacing={1} sx={{ fontSize: '0.85rem', color: 'text.secondary' }}>
          <div>• <strong>文本范围限制</strong>：仅翻译当前授权顶层页面中的普通展示文本；不覆盖跨源 iframe、Shadow DOM 封闭组件及系统内置页面。</div>
          <div>• <strong>单片段字符上限</strong>：每个待翻译文本片段限制最多 2000 个字符。</div>
          <div>• <strong>会话请求预算</strong>：单次网页翻译会话最多连续发起 100 个请求。达到预算时将暂停，需用户主动确认继续。</div>
          <div>• <strong>选区字符限制</strong>：单次选区翻译最多支持 2000 个字符，超过限制将明确提示缩小选区。</div>
          <div>• <strong>并发与超时控制</strong>：后台请求最大并发数为 2 路，单次请求超时时限为 25 秒，不进行后台无限静默重试。</div>
          <div>• <strong>请求撤回限制</strong>：点击暂停或还原时，扩展将立即丢弃尚未写入的迟到结果；但已发送至远程服务的网络请求可能已被处理并计费。</div>
        </Stack>
      </Paper>
    </Box>
  );
};

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <ThemeProvider theme={md2Theme}>
        <CssBaseline />
        <OptionsApp />
      </ThemeProvider>
    </React.StrictMode>
  );
}
