import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { defaultPreferences, idleStatus } from '../../src/shared/contracts';

const mocks = vi.hoisted(() => ({ query: vi.fn(), create: vi.fn(), sendMessage: vi.fn(), sidebarOpen: vi.fn() }));
vi.mock('../../src/shared/browser', () => ({ default: {
  tabs: { query: mocks.query, create: mocks.create },
  runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: mocks.sendMessage },
  sidebarAction: { open: mocks.sidebarOpen },
} }));
import { PopupApp } from '../../src/ui/popup';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([{ id: 7, windowId: 9, url: 'https://page.example/' }]);
  mocks.create.mockResolvedValue({ id: 22 });
  mocks.sidebarOpen.mockResolvedValue(undefined);
  mocks.sendMessage.mockImplementation(async (message: { type: string }) => ({ ok: true, value: message.type === 'settings.get'
    ? { ...defaultPreferences, prefix: '', model: '', authorized: false, hasKey: false } : message.type === 'sites.list' ? [] : idleStatus() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens local workbench without requiring a service or sending content', async () => {
  await act(async () => { render(<PopupApp />); });
  fireEvent.click(screen.getByRole('button', { name: '翻译与写作工作台' }));
  expect(mocks.create).toHaveBeenCalledWith({ url: 'chrome-extension://test/workbench.html' });
  expect(mocks.sendMessage.mock.calls.every(([message]) => ['settings.get', 'page.status', 'sites.list'].includes(message.type))).toBe(true);
});

it('invokes Chromium sidePanel synchronously from the click using cached window identity', async () => {
  const open = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', { sidePanel: { open } });
  await act(async () => { render(<PopupApp />); });
  fireEvent.click(screen.getByRole('button', { name: '打开原生侧栏' }));
  expect(open).toHaveBeenCalledWith({ windowId: 9 });
  expect(mocks.sidebarOpen).not.toHaveBeenCalled();
});

it('invokes Firefox sidebarAction from its click and captures only the selected tab on request', async () => {
  await act(async () => { render(<PopupApp />); });
  fireEvent.click(screen.getByRole('button', { name: '打开原生侧栏' }));
  expect(mocks.sidebarOpen).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '捕获输入并打开工作台' }));
  expect(mocks.sendMessage).toHaveBeenCalledWith({ type: 'input.start', tabId: 7 });
});
