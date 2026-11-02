import type browser from '../shared/browser';
import type { Runtime } from 'webextension-polyfill';
import { errorMessages, fail, type Reply, type SelectionState } from '../shared/contracts';
import type { StoredSettings } from './settings';

interface Task {
  state: SelectionState;
  tabId?: number;
  controller: AbortController;
}

export class Selections {
  private tasks = new Map<string, Task>();

  constructor(private readonly api: typeof browser,
    private readonly ready: () => Promise<Reply<StoredSettings>>,
    private readonly send: (settings: StoredSettings, text: string, signal: AbortSignal) => Promise<Reply<string>>) {}

  async start(source: string, showLimit = false): Promise<Reply<SelectionState>> {
    if (!source.trim()) return fail('unsupported');
    const tooLong = Array.from(source).length > 2000;
    if (tooLong && !showLimit) return fail('limit');
    const settings = await this.ready();
    if (!settings.ok) return settings;
    const id = crypto.randomUUID();
    const task: Task = { state: tooLong
      ? { id, source, phase: 'failed', error: { code: 'limit', message: errorMessages.limit } }
      : { id, source, phase: 'running' }, controller: new AbortController() };
    this.tasks.set(id, task);
    try {
      const tab = await this.api.tabs.create({ url: this.api.runtime.getURL(`selection.html?id=${id}`) });
      task.tabId = tab.id;
      if (task.controller.signal.aborted || tooLong) return { ok: true, value: { ...task.state } };
      void this.run(task, settings.value);
      return { ok: true, value: { ...task.state } };
    } catch {
      this.tasks.delete(id);
      task.controller.abort();
      return fail('unsupported');
    }
  }

  private async run(task: Task, settings: StoredSettings): Promise<void> {
    const controller = task.controller;
    const reply = await this.send(settings, task.state.source, controller.signal);
    if (controller !== task.controller || controller.signal.aborted) return;
    task.state = reply.ok ? { ...task.state, phase: 'complete', text: reply.value, error: undefined }
      : { ...task.state, phase: 'failed', error: reply.error, text: undefined };
  }

  private own(id: string, sender: Runtime.MessageSender): Task | undefined {
    const task = this.tasks.get(id);
    if (!task || !sender.url) return;
    if (sender.tab?.id !== undefined && task.tabId !== undefined && sender.tab.id !== task.tabId) return;
    const query = new URL(sender.url).searchParams;
    if (query.get('id') !== id || [...query.keys()].length !== 1) return;
    return task;
  }

  get(id: string, sender: Runtime.MessageSender): Reply<SelectionState> {
    const task = this.own(id, sender);
    return task ? { ok: true, value: { ...task.state } } : fail('interrupted');
  }

  async retry(id: string, sender: Runtime.MessageSender): Promise<Reply<SelectionState>> {
    const task = this.own(id, sender);
    if (!task) return fail('interrupted');
    if (task.state.phase !== 'failed') return { ok: true, value: { ...task.state } };
    const settings = await this.ready();
    if (!settings.ok) return settings;
    if (this.own(id, sender) !== task) return fail('interrupted');
    task.controller.abort();
    task.controller = new AbortController();
    task.state = { id, source: task.state.source, phase: 'running' };
    void this.run(task, settings.value);
    return { ok: true, value: { ...task.state } };
  }

  async close(id: string, sender: Runtime.MessageSender): Promise<Reply<null>> {
    const task = this.own(id, sender);
    if (!task) return fail('interrupted');
    task.controller.abort();
    this.tasks.delete(id);
    if (task.tabId !== undefined) await this.api.tabs.remove(task.tabId);
    return { ok: true, value: null };
  }

  invalidate(): void {
    for (const task of this.tasks.values()) {
      task.controller.abort();
      task.state = { id: task.state.id, source: task.state.source, phase: 'failed', error: { code: 'interrupted', message: errorMessages.interrupted } };
    }
  }

  removed(tabId: number): void {
    for (const [id, task] of this.tasks) {
      if (task.tabId === tabId) { task.controller.abort(); this.tasks.delete(id); }
    }
  }
}
