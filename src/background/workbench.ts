import type browser from '../shared/browser';
import type { Runtime } from 'webextension-polyfill';
import type { InputAssistCapture, InputAssistResult } from '../content/input-assist';
import { errorMessages, fail, type Reply } from '../shared/contracts';
import { WORKBENCH_PORT_NAME, workbenchMessage, type WorkbenchContext, type WorkbenchServerMessage, type WritingOperation } from '../shared/workbench';
import type { PageSessions } from './pages';
import type { TranslationSnapshot } from './settings';

interface Binding {
  token: string;
  tabId: number;
  ownerTabId?: number;
  version: number;
  contextId: string;
  capture: InputAssistCapture;
  preview: boolean;
}
interface Connection {
  port: Runtime.Port;
  context?: WorkbenchContext;
  binding?: Binding;
  tasks: Map<string, AbortController>;
  closed: boolean;
  pageTask?: { tabId: number; windowId?: number; version: number };
}

export class Workbench {
  private connections = new Set<Connection>();
  private bindings = new Map<string, Binding>();
  private images = new Map<string, { dataUrl: string; ownerTabId?: number; contextId: string }>();

  constructor(private readonly api: typeof browser, private readonly pages: PageSessions,
    private readonly ready: () => Promise<Reply<TranslationSnapshot>>,
    private readonly send: (settings: TranslationSnapshot, text: string, signal: AbortSignal, operation: WritingOperation) => Promise<Reply<string>>,
    private readonly getContext: () => Promise<WorkbenchContext>,
    private readonly sendImage: (settings: TranslationSnapshot, dataUrl: string, signal: AbortSignal) => Promise<Reply<string>>) {}

  async openImage(dataUrl: string, contextId: string): Promise<Reply<null>> {
    if ((await this.getContext()).contextId !== contextId) return fail('interrupted');
    const token = crypto.randomUUID();
    const image = { dataUrl, contextId, ownerTabId: undefined as number | undefined };
    this.images.set(token, image);
    try {
      const tab = await this.api.tabs.create({ url: this.api.runtime.getURL(`workbench.html#image=${token}`) });
      image.ownerTabId = tab.id;
      return { ok: true, value: null };
    } catch { this.images.delete(token); return fail('unsupported'); }
  }

  install(): void {
    this.api.runtime.onConnect.addListener(port => {
      if (port.name === WORKBENCH_PORT_NAME) void this.connect(port);
    });
    const navigate = (details: { tabId: number; frameId: number }) => {
      if (details.frameId === 0) this.invalidateTab(details.tabId, false);
    };
    this.api.webNavigation.onCommitted.addListener(navigate);
    this.api.webNavigation.onHistoryStateUpdated.addListener(navigate);
    this.api.webNavigation.onReferenceFragmentUpdated.addListener(navigate);
    this.api.tabs.onRemoved.addListener(tabId => this.invalidateTab(tabId, true));
    this.api.tabs.onActivated.addListener(({ tabId, windowId }) => {
      for (const connection of this.connections) {
        if (connection.pageTask && connection.pageTask.windowId === windowId && connection.pageTask.tabId !== tabId) this.cancelPage(connection);
      }
    });
  }

  async capture(tabId: number): Promise<Reply<null>> {
    const url = await this.pages.activeTab(tabId);
    if (!url) return fail('unsupported');
    const version = this.pages.version(tabId);
    const context = await this.getContext();
    try {
      await this.pages.inject(tabId);
      const capture: InputAssistCapture | null = await this.api.tabs.sendMessage(tabId, { type: 'input.capture' }, { frameId: 0 });
      const tab = await this.api.tabs.get(tabId);
      if (version !== this.pages.version(tabId) || tab.url !== url
        || (await this.getContext()).contextId !== context.contextId) return fail('interrupted');
      if (!capture || !capture.sourceText.trim() || Array.from(capture.sourceText).length > 2000) {
        return { ok: false, error: { code: 'unsupported', message: '请先聚焦可用的文本输入框，选取不超过 2000 码点的文字；安全字段不可捕获。' } };
      }
      const token = crypto.randomUUID();
      const binding: Binding = { token, tabId, version, contextId: context.contextId, capture, preview: false };
      this.bindings.set(token, binding);
      try {
        const owner = await this.api.tabs.create({ url: this.api.runtime.getURL(`workbench.html#input=${token}`) });
        binding.ownerTabId = owner.id;
        return { ok: true, value: null };
      } catch { this.dropBinding(binding); return fail('unsupported'); }
    } catch { return fail('unsupported'); }
  }

  async contextChanged(): Promise<void> {
    this.images.clear();
    for (const binding of [...this.bindings.values()]) this.dropBinding(binding);
    for (const connection of this.connections) {
      this.cancel(connection);
      connection.binding = undefined;
      connection.context = undefined;
    }
    try {
      const context = await this.getContext();
      for (const connection of this.connections) {
        connection.context = context;
        this.post(connection, { type: 'invalidated', context });
      }
    } catch {
      for (const connection of [...this.connections]) {
        this.disconnect(connection);
        connection.port.disconnect();
      }
    }
  }

  private async connect(port: Runtime.Port): Promise<void> {
    const sender = port.sender;
    const expected = new URL(this.api.runtime.getURL('workbench.html'));
    let token: string | undefined;
    let imageToken: string | undefined;
    try {
      const url = new URL(sender?.url ?? '');
      if (sender?.id !== this.api.runtime.id || sender.frameId !== undefined && sender.frameId !== 0
        || url.origin !== expected.origin || url.protocol !== expected.protocol || url.host !== expected.host
        || url.pathname !== expected.pathname || url.search && url.search !== '?sidebar=1'
        || url.hash && (url.search || !/^#(?:input|image)=[\da-f-]{36}$/.test(url.hash))) throw new Error('sender');
      token = url.hash.startsWith('#input=') ? url.hash.slice(7) : undefined;
      imageToken = url.hash.startsWith('#image=') ? url.hash.slice(7) : undefined;
    } catch { port.disconnect(); return; }
    const binding = token ? this.bindings.get(token) : undefined;
    if (token && (!binding || binding.ownerTabId === undefined || binding.ownerTabId !== sender?.tab?.id
      || [...this.connections].some(connection => connection.binding === binding))) { port.disconnect(); return; }
    const image = imageToken ? this.images.get(imageToken) : undefined;
    if (imageToken && (!image || image.ownerTabId === undefined || image.ownerTabId !== sender?.tab?.id)) { port.disconnect(); return; }
    if (imageToken) this.images.delete(imageToken);
    const connection: Connection = { port, binding, tasks: new Map(), closed: false };
    this.connections.add(connection);
    port.onDisconnect.addListener(() => this.disconnect(connection));
    port.onMessage.addListener((message: unknown) => {
      void this.message(connection, message).catch(() => {
        this.disconnect(connection);
        port.disconnect();
      });
    });
    try {
      const context = await this.getContext();
      if (connection.closed) return;
      if (binding && context.contextId !== binding.contextId) {
        this.dropBinding(binding); connection.binding = undefined;
      }
      connection.context = context;
      this.post(connection, { type: 'hello', context, capture: connection.binding?.capture,
        image: image?.contextId === context.contextId ? image.dataUrl : undefined });
    } catch { this.disconnect(connection); port.disconnect(); }
  }

  private post(connection: Connection, message: WorkbenchServerMessage): void {
    if (!connection.closed) connection.port.postMessage(message);
  }

  private cancelPage(connection: Connection): void {
    const task = connection.pageTask;
    connection.pageTask = undefined;
    if (task && this.pages.version(task.tabId) === task.version) {
      this.pages.invalidate(task.tabId, { code: 'interrupted', message: errorMessages.interrupted });
    }
  }

  private cancel(connection: Connection): void {
    this.cancelPage(connection);
    for (const controller of connection.tasks.values()) controller.abort();
    connection.tasks.clear();
  }

  private disconnect(connection: Connection): void {
    connection.closed = true;
    this.cancel(connection);
    if (connection.binding) this.dropBinding(connection.binding);
    this.connections.delete(connection);
  }

  private dropBinding(binding: Binding): void {
    this.bindings.delete(binding.token);
    void this.api.tabs.sendMessage(binding.tabId, { type: 'input.invalidate', id: binding.capture.id,
      instanceId: binding.capture.instanceId }, { frameId: 0 }).catch(() => undefined);
  }

  private invalidateTab(tabId: number, closed: boolean): void {
    for (const [token, image] of this.images) if (closed && image.ownerTabId === tabId) this.images.delete(token);
    for (const binding of [...this.bindings.values()]) {
      if (binding.tabId !== tabId && !(closed && binding.ownerTabId === tabId)) continue;
      this.dropBinding(binding);
      for (const connection of this.connections) {
        if (connection.binding !== binding) continue;
        this.cancel(connection);
        connection.binding = undefined;
        if (connection.context) this.post(connection, { type: 'invalidated', context: connection.context });
      }
    }
  }

  private async message(connection: Connection, value: unknown): Promise<void> {
    if (connection.closed || !workbenchMessage(value)) return;
    if (value.type === 'cancel') {
      connection.tasks.get(value.id)?.abort();
      connection.tasks.delete(value.id);
      return;
    }
    if (!connection.context || value.contextId !== connection.context.contextId) return;
    if (value.type === 'translate' || value.type === 'image') await this.translate(connection, value);
    else if (value.type === 'page.status' || value.type === 'page.command') await this.pageRequest(connection, value);
    else await this.writeInput(connection, value);
  }

  private async pageRequest(connection: Connection, message: Extract<import('../shared/workbench').WorkbenchClientMessage, { type: 'page.status' | 'page.command' }>): Promise<void> {
    const [tab] = await this.api.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id;
    const unavailable = () => this.post(connection, { type: 'page', id: message.id, contextId: message.contextId,
      reply: { ok: false, error: { code: 'permission', message: '请切换到普通网页，并先点击该页的扩展工具栏授予访问权限；工作台不会自动增加网页权限。' } } });
    if (tabId === undefined || !await this.pages.activeTab(tabId)
      || message.type === 'page.command' && message.tabId !== tabId) { unavailable(); return; }
    const context = await this.getContext();
    if (connection.closed || connection.context?.contextId !== message.contextId || context.contextId !== message.contextId) return;
    let reply;
    if (message.type === 'page.status') reply = await this.pages.status(tabId);
    else if (message.action === 'start') {
      this.cancelPage(connection);
      const task = { tabId, windowId: tab.windowId, version: this.pages.version(tabId) };
      connection.pageTask = task;
      const pending = this.pages.command({ type: 'page.command', tabId, action: 'start' }, this.ready,
        () => !connection.closed && connection.pageTask === task && connection.context?.contextId === message.contextId);
      task.version = this.pages.version(tabId);
      reply = await pending;
    } else {
      connection.pageTask = undefined;
      reply = await this.pages.command({ type: 'page.command', tabId, action: message.action });
    }
    if (!await this.pages.activeTab(tabId)) { unavailable(); return; }
    this.post(connection, { type: 'page', id: message.id, contextId: message.contextId, tabId, reply });
  }

  private async translate(connection: Connection, message: Extract<import('../shared/workbench').WorkbenchClientMessage, { type: 'translate' | 'image' }>): Promise<void> {
    if (connection.tasks.has(message.id)) return;
    if (connection.tasks.size >= 2) {
      this.post(connection, { type: 'result', id: message.id, contextId: message.contextId, reply: fail('limit') });
      return;
    }
    if (connection.binding && (message.type === 'image' || message.text !== connection.binding.capture.sourceText)) return;
    const controller = new AbortController();
    connection.tasks.set(message.id, controller);
    try {
      const settings = await this.ready();
      const context = await this.getContext();
      if (controller.signal.aborted || context.contextId !== message.contextId) return;
      const reply = !settings.ok ? settings : message.type === 'image'
        ? await this.sendImage(settings.value, message.dataUrl, controller.signal)
        : await this.send(settings.value, message.text, controller.signal, message.operation);
      if (controller.signal.aborted || connection.closed || (await this.getContext()).contextId !== message.contextId) return;
      if (reply.ok && connection.binding) connection.binding.preview = true;
      this.post(connection, { type: 'result', id: message.id, contextId: message.contextId, reply });
    } finally { if (connection.tasks.get(message.id) === controller) connection.tasks.delete(message.id); }
  }

  private async writeInput(connection: Connection, message: Extract<import('../shared/workbench').WorkbenchClientMessage, { type: 'apply' | 'restore' }>): Promise<void> {
    const binding = connection.binding;
    let reply: InputAssistResult = { ok: false, reason: 'invalidated' };
    if (binding && binding.preview && this.bindings.get(binding.token) === binding
      && binding.contextId === message.contextId && binding.version === this.pages.version(binding.tabId)) {
      try {
        const tab = await this.api.tabs.get(binding.tabId);
        const context = await this.getContext();
        if (tab.url === binding.capture.url && !connection.closed && connection.binding === binding
          && this.bindings.get(binding.token) === binding && binding.version === this.pages.version(binding.tabId)
          && context.contextId === message.contextId) {
          reply = await this.api.tabs.sendMessage(binding.tabId, {
            type: message.type === 'apply' ? 'input.apply' : 'input.restore', id: binding.capture.id,
            instanceId: binding.capture.instanceId, ...(message.type === 'apply' ? { text: message.text } : {}),
          }, { frameId: 0 });
        }
      } catch { reply = { ok: false, reason: 'not-found' }; }
    }
    this.post(connection, { type: 'input-result', id: message.id, contextId: message.contextId, reply });
  }
}
