import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { PopupApp } from '../../src/ui/popup';
import { PublicSettings, PageStatus, idleStatus } from '../../src/shared/contracts';

const mockTabsQuery = vi.fn();
const mockTabsCreate = vi.fn();
const mockSendMessage = vi.fn();
const mockOpenOptionsPage = vi.fn();
const mockGetURL = vi.fn((path: string) => `chrome-extension://mock-id/${path}`);

vi.mock('../../src/shared/browser', () => ({
  default: {
    tabs: {
      query: (...args: unknown[]) => mockTabsQuery(...args),
      create: (...args: unknown[]) => mockTabsCreate(...args),
    },
    runtime: {
      sendMessage: (...args: unknown[]) => mockSendMessage(...args),
      openOptionsPage: (...args: unknown[]) => mockOpenOptionsPage(...args),
      getURL: (path: string) => mockGetURL(path),
    },
  },
}));

describe('PopupApp component behavior', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/article' },
    ]);
    mockTabsCreate.mockResolvedValue({ id: 2 });
  });

  it('enables start and selection buttons when prefix + model + authorized=true even with hasKey=false', async () => {
    const keylessSettings: PublicSettings = {
      prefix: 'http://localhost:11434/v1',
      model: 'llama3',
      hasKey: false,
      authorized: true,
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
    };

    const initialStatus: PageStatus = idleStatus();

    mockSendMessage.mockImplementation((msg: unknown) => {
      const typed = msg as { type?: string };
      if (typed.type === 'sites.list') return Promise.resolve({ ok: true, value: [] });
      if (typed.type === 'settings.get') {
        return Promise.resolve({ ok: true, value: keylessSettings });
      }
      if (typed.type === 'page.status') {
        return Promise.resolve({ ok: true, value: initialStatus });
      }
      return Promise.resolve({ ok: true, value: {} });
    });

    render(<PopupApp />);

    // 等待异步查询完成
    await act(async () => {
      await Promise.resolve();
    });

    // 验证未显示未配置告警
    expect(screen.queryByText(/未配置有效服务地址或模型/)).toBeNull();
    // 验证未显示未授权告警
    expect(screen.queryByText(/所配服务主机尚未获得权限授权/)).toBeNull();

    // 验证开始翻译按钮与选区翻译按钮均处于可用状态（未禁用）
    const startButton = screen.getByRole('button', { name: '开始翻译' });
    expect(startButton).not.toBeNull();
    expect(startButton.hasAttribute('disabled')).toBe(false);

    const selectionButton = screen.getByRole('button', { name: '选区翻译（在新标签页打开）' });
    expect(selectionButton).not.toBeNull();
    expect(selectionButton.hasAttribute('disabled')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'SRT 字幕翻译（在新标签页打开）' }));
    expect(mockTabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://mock-id/subtitles.html' });
  });

  it('disables start button when unconfigured or unauthorized', async () => {
    const unconfiguredSettings: PublicSettings = {
      prefix: '',
      model: '',
      hasKey: false,
      authorized: false,
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
    };

    mockSendMessage.mockImplementation((msg: unknown) => {
      const typed = msg as { type?: string };
      if (typed.type === 'sites.list') return Promise.resolve({ ok: true, value: [] });
      if (typed.type === 'settings.get') {
        return Promise.resolve({ ok: true, value: unconfiguredSettings });
      }
      if (typed.type === 'page.status') {
        return Promise.resolve({ ok: true, value: idleStatus() });
      }
      return Promise.resolve({ ok: true, value: {} });
    });

    render(<PopupApp />);

    await act(async () => {
      await Promise.resolve();
    });

    // 应该显示未配置提示
    expect(screen.getByText(/未配置有效服务地址或模型/)).not.toBeNull();

    // 开始翻译按钮处于禁用状态
    const startButton = screen.getByRole('button', { name: '开始翻译' });
    expect(startButton.hasAttribute('disabled')).toBe(true);
  });

  it('provides pause button in complete state so active dynamic observation can be paused', async () => {
    const configuredSettings: PublicSettings = {
      prefix: 'https://api.example.com/v1',
      model: 'custom-model',
      hasKey: true,
      authorized: true,
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      mode: 'bilingual',
    };

    const completeStatus: PageStatus = {
      phase: 'complete',
      mode: 'bilingual',
      total: 5,
      completed: 5,
      failed: 0,
      pending: 0,
      hoverEnabled: false,
    };

    mockSendMessage.mockImplementation((msg: unknown) => {
      const typed = msg as { type?: string };
      if (typed.type === 'sites.list') return Promise.resolve({ ok: true, value: [] });
      if (typed.type === 'settings.get') {
        return Promise.resolve({ ok: true, value: configuredSettings });
      }
      if (typed.type === 'page.status') {
        return Promise.resolve({ ok: true, value: completeStatus });
      }
      return Promise.resolve({ ok: true, value: {} });
    });

    render(<PopupApp />);

    await act(async () => {
      await Promise.resolve();
    });

    // 暂停翻译按钮在 complete 状态下必须存在且可用
    const pauseButton = screen.getByRole('button', { name: '暂停翻译' });
    expect(pauseButton).not.toBeNull();
    expect(pauseButton.hasAttribute('disabled')).toBe(false);

    // 重新翻译按钮并列可用
    const restartButton = screen.getByRole('button', { name: '重新翻译' });
    expect(restartButton).not.toBeNull();
    expect(restartButton.hasAttribute('disabled')).toBe(false);
  });

  it('enables and disables explicit hover mode from the popup', async () => {
    const settings: PublicSettings = {
      prefix: 'https://api.example.com/v1', model: 'model', hasKey: false, authorized: true,
      sourceLanguage: 'auto', targetLanguage: 'zh-CN', mode: 'bilingual',
    };
    let status = idleStatus();
    mockSendMessage.mockImplementation((message: unknown) => {
      const typed = message as { type?: string; enabled?: boolean };
      if (typed.type === 'sites.list') return Promise.resolve({ ok: true, value: [] });
      if (typed.type === 'settings.get') return Promise.resolve({ ok: true, value: settings });
      if (typed.type === 'page.status') return Promise.resolve({ ok: true, value: status });
      if (typed.type === 'hover.command') {
        status = { ...idleStatus(), hoverEnabled: Boolean(typed.enabled) };
        return Promise.resolve({ ok: true, value: status });
      }
      return Promise.resolve({ ok: true, value: status });
    });

    render(<PopupApp />);
    await act(async () => { await Promise.resolve(); });
    const enable = screen.getByRole('button', { name: '启用指向翻译' });
    expect(enable.hasAttribute('disabled')).toBe(false);
    await act(async () => { fireEvent.click(enable); await Promise.resolve(); });
    expect(mockSendMessage).toHaveBeenCalledWith({ type: 'hover.command', tabId: 1, enabled: true });
    expect(screen.getByText('指向翻译已启用')).not.toBeNull();
    const disable = screen.getByRole('button', { name: '关闭指向翻译' });
    await act(async () => { fireEvent.click(disable); await Promise.resolve(); });
    expect(mockSendMessage).toHaveBeenCalledWith({ type: 'hover.command', tabId: 1, enabled: false });
    expect(screen.getByText(/普通移动和点击不会发送内容/)).not.toBeNull();
  });
});
