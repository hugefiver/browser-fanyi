import React, { useEffect, useState } from 'react';
import browser from '../shared/browser';
import type { PublicSettings, Reply, UiRequest } from '../shared/contracts';
import { Alert, Box, Button, Chip, Divider, Stack, Typography } from '@mui/material';
import {
  createSiteRule,
  sameSiteService,
  sitePermissionPattern,
  type SiteRule,
  type SiteRuleCandidate,
  type SiteServiceBinding,
} from '../background/site-rules';

export interface SiteRulesManagerProps {
  rules: readonly SiteRule[];
  currentService: SiteServiceBinding | null;
  candidate?: SiteRuleCandidate;
  requestPermission: (permission: string) => Promise<boolean>;
  saveRule: (rule: SiteRule) => Promise<void>;
  enableRule: (origin: string) => Promise<void>;
  disableRule: (origin: string) => Promise<void>;
  removeRule: (origin: string) => Promise<void>;
}

export function SiteRulesPanel({ settings, tab }: { settings: PublicSettings | null; tab?: { id: number; url: string } }) {
  const [rules, setRules] = useState<SiteRule[]>([]);
  const [error, setError] = useState('');
  const send = async (message: UiRequest) => {
    const reply = await browser.runtime.sendMessage(message) as Reply<SiteRule[]>;
    if (!reply.ok) throw new Error(reply.error.message);
    setRules(reply.value);
  };
  useEffect(() => {
    void send({ type: 'sites.list' }).catch(() => setError('无法读取站点规则。'));
  }, [settings]);
  const service = settings?.prefix && settings.model ? { prefix: settings.prefix, model: settings.model } : null;
  return <>
    {error && <Alert severity="error">{error}</Alert>}
    <SiteRulesManager rules={rules} currentService={service}
      candidate={tab && service && settings?.authorized ? { tabUrl: tab.url, service,
        targetLanguage: settings.targetLanguage, mode: settings.mode } : undefined}
      requestPermission={permission => browser.permissions.request({ origins: [permission] })}
      saveRule={rule => send({ type: 'sites.save', tabId: tab!.id, rule })}
      enableRule={origin => send({ type: 'sites.change', origin, action: 'enable' })}
      disableRule={origin => send({ type: 'sites.change', origin, action: 'disable' })}
      removeRule={origin => send({ type: 'sites.change', origin, action: 'remove' })} />
  </>;
}

type ActionState = { origin: string; message: string } | null;

const modeLabel = (rule: SiteRule): string => rule.mode === 'bilingual' ? '双语显示' : '仅译文';

export function SiteRulesManager(props: SiteRulesManagerProps) {
  const [pendingOrigin, setPendingOrigin] = useState<string | null>(null);
  const [result, setResult] = useState<ActionState>(null);
  let candidateRule: SiteRule | null = null;
  let candidateError = '';
  if (props.candidate) {
    try {
      candidateRule = createSiteRule(props.candidate);
    } catch {
      candidateError = '当前标签页或翻译服务配置不能用于逐站自动翻译。';
    }
  }

  const run = async (origin: string, action: () => Promise<void>, success: string) => {
    setPendingOrigin(origin);
    setResult(null);
    try {
      await action();
      setResult({ origin, message: success });
    } catch {
      setResult({ origin, message: '操作失败，请重试。' });
    } finally {
      setPendingOrigin(null);
    }
  };

  const requestThen = async (rule: SiteRule, action: () => Promise<void>, success: string) => {
    let permission: Promise<boolean>;
    try {
      permission = props.requestPermission(sitePermissionPattern(rule.origin));
    } catch {
      setResult({ origin: rule.origin, message: '未取得站点权限，规则未启用。' });
      return;
    }
    setPendingOrigin(rule.origin);
    setResult(null);
    try {
      if (!await permission) {
        setResult({ origin: rule.origin, message: '未取得站点权限，规则未启用。' });
        return;
      }
      await action();
      setResult({ origin: rule.origin, message: success });
    } catch {
      setResult({ origin: rule.origin, message: '操作失败，规则未启用。' });
    } finally {
      setPendingOrigin(null);
    }
  };

  return <Stack component="section" spacing={2} aria-labelledby="site-rules-title">
    <Box>
      <Typography id="site-rules-title" variant="h6">逐站自动翻译</Typography>
      <Typography variant="body2" color="text.secondary">
        规则只在当前可见的活动标签页自动运行。每个新文档最多发送 100 次请求；暂停或还原后，同一文档不会自动重新开始。
      </Typography>
    </Box>

    {candidateRule && <Alert severity="warning" variant="outlined">
      <Stack spacing={1}>
        <Typography variant="body2">
          启用不发送当前页；下次刷新或导航生效，可能产生费用。启用后，访问 <strong>{candidateRule.origin}</strong> 时，页面文字会长期自动发送给
          {' '}<strong>{candidateRule.service.prefix}</strong>，由模型 <strong>{candidateRule.service.model}</strong> 接收处理。
        </Typography>
        <Typography variant="body2">
          目标语言：<strong>{candidateRule.targetLanguage}</strong>；模式：<strong>{modeLabel(candidateRule)}</strong>。
          浏览器将申请主机权限 <strong>{sitePermissionPattern(candidateRule.origin)}</strong>，该权限覆盖同协议、同主机的所有端口；
          自动发送仍只匹配上方列出的完整 origin，不扩大到其他协议或子域。
        </Typography>
        <Button
          variant="contained"
          disabled={pendingOrigin !== null}
          onClick={() => void requestThen(candidateRule!, () => props.saveRule(candidateRule!), '站点规则已确认并启用。')}
        >
          同意长期自动发送并申请此主机所有端口权限
        </Button>
      </Stack>
    </Alert>}
    {candidateError && <Alert severity="info">{candidateError}</Alert>}

    <Divider />
    {props.rules.length === 0
      ? <Typography color="text.secondary">尚未保存逐站自动翻译规则。</Typography>
      : <Stack spacing={2}>
        {props.rules.map(rule => {
          const serviceMatches = props.currentService !== null && sameSiteService(rule.service, props.currentService);
          const pending = pendingOrigin === rule.origin;
          return <Box component="article" key={rule.origin} aria-label={`站点规则 ${rule.origin}`}>
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Typography component="h3" variant="subtitle1">{rule.origin}</Typography>
                <Chip size="small" label={rule.enabled ? '已启用' : '已停用'} color={rule.enabled ? 'success' : 'default'} />
              </Stack>
              <Typography variant="body2">接收方：{rule.service.prefix}</Typography>
              <Typography variant="body2">模型：{rule.service.model}</Typography>
              <Typography variant="body2">目标语言：{rule.targetLanguage}；模式：{modeLabel(rule)}</Typography>
              {!serviceMatches && <Typography variant="body2" color="warning.main">
                当前接收方或模型已经变化。请在该站点的 popup 中重新查看说明并同意，旧规则不会自动恢复。
              </Typography>}
              <Stack direction="row" spacing={1} flexWrap="wrap">
                {rule.enabled
                  ? <Button disabled={pendingOrigin !== null} onClick={() => void run(rule.origin, () => props.disableRule(rule.origin), '规则已停用。')}>停用自动翻译</Button>
                  : <Button
                    disabled={pendingOrigin !== null || !serviceMatches}
                    onClick={() => void requestThen(rule, () => props.enableRule(rule.origin), '规则已启用。')}
                  >启用自动翻译</Button>}
                <Button
                  color="error"
                  disabled={pendingOrigin !== null}
                  onClick={() => void run(rule.origin, () => props.removeRule(rule.origin), '规则已删除。')}
                >删除规则</Button>
              </Stack>
              {pending && <Typography role="status">正在处理…</Typography>}
              {result?.origin === rule.origin && <Typography role="status">{result.message}</Typography>}
            </Stack>
          </Box>;
        })}
      </Stack>}
    {candidateRule && result?.origin === candidateRule.origin && !props.rules.some(rule => rule.origin === candidateRule!.origin)
      && <Typography role="status">{result.message}</Typography>}
  </Stack>;
}
