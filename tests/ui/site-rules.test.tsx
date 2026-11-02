import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SiteRulesManager, type SiteRulesManagerProps } from '../../src/ui/site-rules';
import type { SiteRule, SiteRuleCandidate, SiteServiceBinding } from '../../src/background/site-rules';

vi.mock('../../src/shared/browser', () => ({ default: {} }));

const service: SiteServiceBinding = { prefix: 'https://translator.example/v1', model: 'chosen-model' };
const candidate: SiteRuleCandidate = {
  tabUrl: 'https://news.example:8443/private/article#section',
  targetLanguage: 'zh-CN',
  mode: 'bilingual',
  service,
};
const existingRule: SiteRule = {
  origin: 'https://existing.example',
  enabled: false,
  targetLanguage: 'ja',
  mode: 'translation',
  service,
};

function props(overrides: Partial<SiteRulesManagerProps> = {}): SiteRulesManagerProps {
  return {
    rules: [],
    currentService: service,
    requestPermission: vi.fn(async () => true),
    saveRule: vi.fn(async () => undefined),
    enableRule: vi.fn(async () => undefined),
    disableRule: vi.fn(async () => undefined),
    removeRule: vi.fn(async () => undefined),
    ...overrides,
  };
}

afterEach(cleanup);

describe('site rules manager', () => {
  it('shows long-term sending, exact full-site permission, receiver, model, language, and mode', () => {
    render(<SiteRulesManager {...props({ candidate })} />);
    expect(screen.getByText(/长期自动发送给/).textContent).toContain('https://translator.example/v1');
    expect(screen.getByText(/由模型/).textContent).toContain('chosen-model');
    expect(screen.getByText(/目标语言/).textContent).toContain('zh-CN');
    expect(screen.getByText(/目标语言/).textContent).toContain('双语显示');
    expect(screen.getByText(/浏览器将申请主机权限/).textContent).toContain('https://news.example/*');
    expect(screen.getByText(/浏览器将申请主机权限/).textContent).toContain('同主机的所有端口');
    expect(screen.getByText(/自动发送仍只匹配/).textContent).toContain('完整 origin');
    expect(screen.getByText(/自动发送仍只匹配/).textContent).toContain('其他协议或子域');
  });

  it('requests permission directly from the click before saving the enabled rule', async () => {
    const events: string[] = [];
    const requestPermission = vi.fn((permission: string) => {
      events.push(`request:${permission}`);
      return Promise.resolve(true);
    });
    const saveRule = vi.fn(async (rule: SiteRule) => { events.push(`save:${rule.origin}`); });
    render(<SiteRulesManager {...props({ candidate, requestPermission, saveRule })} />);
    fireEvent.click(screen.getByRole('button', { name: '同意长期自动发送并申请此主机所有端口权限' }));
    expect(requestPermission).toHaveBeenCalledWith('https://news.example/*');
    expect(saveRule).not.toHaveBeenCalled();
    await waitFor(() => expect(saveRule).toHaveBeenCalledOnce());
    expect(events).toEqual([
      'request:https://news.example/*',
      'save:https://news.example:8443',
    ]);
    expect(saveRule.mock.calls[0][0]).toMatchObject({ enabled: true, targetLanguage: 'zh-CN', mode: 'bilingual', service });
  });

  it('does not save or enable when the permission request is denied', async () => {
    const saveRule = vi.fn(async () => undefined);
    render(<SiteRulesManager {...props({
      candidate,
      requestPermission: vi.fn(async () => false),
      saveRule,
    })} />);
    fireEvent.click(screen.getByRole('button', { name: '同意长期自动发送并申请此主机所有端口权限' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('未取得站点权限'));
    expect(saveRule).not.toHaveBeenCalled();
  });

  it('lets options manage existing rules without presenting a hidden full-site application', async () => {
    const disableRule = vi.fn(async () => undefined);
    const removeRule = vi.fn(async () => undefined);
    render(<SiteRulesManager {...props({
      rules: [{ ...existingRule, enabled: true }],
      disableRule,
      removeRule,
    })} />);
    expect(screen.queryByRole('button', { name: '同意长期自动发送并申请此主机所有端口权限' })).toBeNull();
    expect(screen.getByText('接收方：https://translator.example/v1')).not.toBeNull();
    expect(screen.getByText('模型：chosen-model')).not.toBeNull();
    expect(screen.getByText(/目标语言：ja/).textContent).toContain('仅译文');
    fireEvent.click(screen.getByRole('button', { name: '停用自动翻译' }));
    await waitFor(() => expect(disableRule).toHaveBeenCalledWith('https://existing.example'));
    fireEvent.click(screen.getByRole('button', { name: '删除规则' }));
    await waitFor(() => expect(removeRule).toHaveBeenCalledWith('https://existing.example'));
  });

  it('requires permission again before enabling an existing disabled rule', async () => {
    const requestPermission = vi.fn(async () => true);
    const enableRule = vi.fn(async () => undefined);
    render(<SiteRulesManager {...props({ rules: [existingRule], requestPermission, enableRule })} />);
    fireEvent.click(screen.getByRole('button', { name: '启用自动翻译' }));
    expect(requestPermission).toHaveBeenCalledWith('https://existing.example/*');
    await waitFor(() => expect(enableRule).toHaveBeenCalledWith('https://existing.example'));
  });

  it('blocks re-enabling stale consent until the current site popup reconfirms the changed service', () => {
    render(<SiteRulesManager {...props({
      rules: [existingRule],
      currentService: { ...service, model: 'different-model' },
    })} />);
    expect(screen.getByText(/当前接收方或模型已经变化/)).not.toBeNull();
    expect((screen.getByRole('button', { name: '启用自动翻译' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
