import 'fake-indexeddb/auto';
import { vi } from 'vitest';
import type browser from '../../src/shared/browser';
import type { Runtime, Tabs } from 'webextension-polyfill';
import { BackgroundController } from '../../src/background/controller';
import { SettingsStore } from '../../src/background/settings';
import { translate } from '../../src/background/provider';
import { defaultPreferences, idleStatus, type ContentCommand, type Grant, type PageStatus, type Reply } from '../../src/shared/contracts';

export const pageUrl = 'https://page.example/article';
export const ui = (page: string): Runtime.MessageSender => ({ id: 'clean-room', url: `chrome-extension://clean-room/${page}.html` });
export const tab = (id: number): Tabs.Tab => ({ id, index: 0, highlighted: true, active: true,
  pinned: false, incognito: false, url: pageUrl });
export const content = (): Runtime.MessageSender => ({ id: 'clean-room', frameId: 0, tab: tab(1), url: pageUrl });

export async function fixture() {
  const sendMessage = vi.fn(async (_id: number, message: ContentCommand): Promise<Reply<PageStatus> | Reply<string>> => {
    if (message.type === 'content.selection') return { ok: true, value: 'Only selected text' };
    return { ok: true, value: { ...idleStatus(), phase: 'running' } };
  });
  const onMessage = vi.fn();
  const onCommitted = vi.fn();
  const onHistoryStateUpdated = vi.fn();
  const onReferenceFragmentUpdated = vi.fn();
  const onRemoved = vi.fn();
  const permissionsRemoved = vi.fn();
  const menuClicked = vi.fn();
  const sessionValues: Record<string, unknown> = {};
  const api = {
    storage: { session: {
      get: vi.fn(async (key: string): Promise<Record<string, unknown>> => ({ [key]: sessionValues[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(sessionValues, values); }),
      remove: vi.fn(async (key: string) => { delete sessionValues[key]; }),
    } },
    runtime: { id: 'clean-room', getURL: (path: string) => `chrome-extension://clean-room/${path}`,
      onMessage: { addListener: onMessage }, onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() },
      openOptionsPage: vi.fn(async (): Promise<void> => undefined) },
    permissions: { contains: vi.fn(async () => true), onRemoved: { addListener: permissionsRemoved } },
    tabs: { query: vi.fn(async () => [{ id: 1, url: pageUrl }]), get: vi.fn(async () => ({ id: 1, url: pageUrl })),
      sendMessage, create: vi.fn(async (_options: { url: string }) => ({ id: 22 })),
      remove: vi.fn(async (_id: number) => undefined), onRemoved: { addListener: onRemoved } },
    scripting: { executeScript: vi.fn(async () => []) },
    webNavigation: { onCommitted: { addListener: onCommitted }, onHistoryStateUpdated: { addListener: onHistoryStateUpdated },
      onReferenceFragmentUpdated: { addListener: onReferenceFragmentUpdated } },
    contextMenus: { onClicked: { addListener: menuClicked }, removeAll: vi.fn(async () => undefined), create: vi.fn() },
  };
  const store = new SettingsStore(`controller-${crypto.randomUUID()}`);
  await store.save({ ...defaultPreferences, prefix: 'https://receiver.example/v1', model: 'test',
    key: { kind: 'replace', value: 'private-key', forOrigin: 'https://receiver.example' } });
  const translator = vi.fn<typeof translate>().mockResolvedValue({ ok: true, value: 'translated' });
  const controller = new BackgroundController(api as unknown as typeof browser, store, translator);
  controller.install();
  const grant = (): Grant => {
    const commands = sendMessage.mock.calls.map(([, command]) => command).reverse();
    for (const command of commands) {
      if ((command.type === 'content.command' || command.type === 'hover.command') && command.grant) return command.grant;
    }
    throw new Error('No issued grant');
  };
  const start = async () => {
    await controller.handle({ type: 'page.command', tabId: 1, action: 'start' }, ui('popup'));
    return grant();
  };
  return { api, store, controller, translator, sendMessage, grant, start, onMessage, onCommitted,
    onHistoryStateUpdated, onReferenceFragmentUpdated, onRemoved, permissionsRemoved, menuClicked };
}
