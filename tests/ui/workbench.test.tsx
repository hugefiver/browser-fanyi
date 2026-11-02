import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { idleStatus, type Reply } from '../../src/shared/contracts';
import type { WorkbenchServerMessage } from '../../src/shared/workbench';
import type { InputAssistCapture } from '../../src/content/input-assist';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), openOptionsPage: vi.fn(), activated: vi.fn(), unlisten: vi.fn() }));
vi.mock('../../src/shared/browser', () => ({ default: { runtime: mocks,
  tabs: { onActivated: { addListener: mocks.activated, removeListener: mocks.unlisten } },
} }));
import { TextWorkbench, WorkbenchApp } from '../../src/ui/workbench';

const capture: InputAssistCapture = { id: 'id', instanceId: 'instance', kind: 'textarea', url: 'https://page.example/',
  originalValue: 'source draft', sourceText: 'source draft', selectedText: '', selection: null, canApply: true };
const context = { contextId: 'boot:0', settings: { prefix: 'https://receiver.example/v1', model: 'chosen-model',
  sourceLanguage: 'auto', targetLanguage: 'zh-CN', mode: 'bilingual' as const, hasKey: true, authorized: true } };
function connect() {
  let onMessage!: (message: WorkbenchServerMessage) => void;
  let onDisconnect!: () => void;
  const port = { postMessage: vi.fn(), disconnect: vi.fn(),
    onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
    onDisconnect: { addListener: (listener: typeof onDisconnect) => { onDisconnect = listener; } },
  };
  mocks.connect.mockReturnValue(port);
  return { port, emit: (message: WorkbenchServerMessage) => act(() => onMessage(message)), close: () => act(() => onDisconnect()) };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); history.replaceState({}, '', '/'); });

describe('workbench visible controls', () => {
  it('sidebar tracks the active tab and ignores an old tab command reply after switching', async () => {
    history.replaceState({}, '', '?sidebar=1');
    const ctx = connect();
    render(<WorkbenchApp />);
    ctx.emit({ type: 'hello', context });
    const status = ctx.port.postMessage.mock.calls[0][0];
    expect(status.type).toBe('page.status');
    ctx.emit({ type: 'page', id: status.id, contextId: context.contextId, tabId: 1, reply: { ok: true, value: idleStatus() } });
    fireEvent.click(screen.getByRole('button', { name: '开始整页翻译' }));
    const command = ctx.port.postMessage.mock.calls[1][0];
    expect(command).toMatchObject({ type: 'page.command', tabId: 1, action: 'start' });
    act(() => mocks.activated.mock.calls[0][0]());
    expect((screen.getByRole('button', { name: '开始整页翻译' }) as HTMLButtonElement).disabled).toBe(true);
    ctx.emit({ type: 'page', id: command.id, contextId: context.contextId, tabId: 1, reply: { ok: true, value: { ...idleStatus(), phase: 'running' } } });
    expect(screen.queryByText(/标签页 1/)).toBeNull();
    const current = ctx.port.postMessage.mock.calls[2][0];
    ctx.emit({ type: 'page', id: current.id, contextId: context.contextId, tabId: 2, reply: { ok: true, value: idleStatus() } });
    fireEvent.click(screen.getByRole('button', { name: '暂停整页翻译' }));
    expect(ctx.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'page.command', tabId: 2, action: 'pause' }));
  });

  it('requires send, supports editing/restoring/copying result and writes only after separate confirmation', async () => {
    const translate = vi.fn(async (): Promise<Reply<string>> => ({ ok: true, value: 'service result' }));
    const writeInput = vi.fn();
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    render(<TextWorkbench translate={translate} ready capture={capture} bindingValid applied={false} inputBusy={false} inputNotice="" writeInput={writeInput} />);
    expect(translate).not.toHaveBeenCalled();
    expect(writeInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认发送并翻译' }));
    await screen.findByLabelText('结果预览（可编辑）');
    expect(writeInput).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('结果预览（可编辑）'), { target: { value: 'edited result' } });
    fireEvent.click(screen.getByRole('button', { name: '恢复服务结果' }));
    expect((screen.getByLabelText('结果预览（可编辑）') as HTMLTextAreaElement).value).toBe('service result');
    fireEvent.click(screen.getByRole('button', { name: '复制结果' }));
    expect(copy).toHaveBeenCalledWith('service result');
    fireEvent.click(screen.getByRole('button', { name: '确认写回源字段' }));
    expect(writeInput).toHaveBeenCalledWith('apply', 'service result');
    expect(translate).toHaveBeenCalledOnce();
  });

  it('cancel aborts and retry is explicit; late results cannot replace a fresh request', async () => {
    let finish!: (reply: Reply<string>) => void;
    const translate = vi.fn((_text: string, _signal: AbortSignal) => new Promise<Reply<string>>(resolve => { finish = resolve; }));
    render(<TextWorkbench translate={translate} ready bindingValid={false} applied={false} inputBusy={false} inputNotice="" writeInput={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('待处理文字'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: '确认发送并翻译' }));
    fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
    expect(translate.mock.calls[0][1].aborted).toBe(true);
    await act(async () => finish({ ok: true, value: 'late reply' }));
    expect(screen.queryByLabelText('结果预览（可编辑）')).toBeNull();
    translate.mockResolvedValue({ ok: true, value: 'fresh reply' });
    fireEvent.click(screen.getByRole('button', { name: '重试本段' }));
    await screen.findByLabelText('结果预览（可编辑）');
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('connects without sending and ties local requests to exact context', async () => {
    const ctx = connect();
    render(<WorkbenchApp />);
    ctx.emit({ type: 'hello', context });
    expect(ctx.port.postMessage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('待处理文字'), { target: { value: 'local draft' } });
    expect(ctx.port.postMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认发送并翻译' }));
    const request = ctx.port.postMessage.mock.calls[0][0];
    expect(request).toMatchObject({ type: 'translate', contextId: context.contextId, text: 'local draft', operation: 'translate' });
    ctx.emit({ type: 'result', id: request.id, contextId: 'wrong', reply: { ok: true, value: 'stale' } });
    expect(screen.queryByLabelText('结果预览（可编辑）')).toBeNull();
    ctx.emit({ type: 'result', id: request.id, contextId: context.contextId, reply: { ok: true, value: 'current' } });
    await screen.findByLabelText('结果预览（可编辑）');
    ctx.emit({ type: 'invalidated', context: { ...context, contextId: 'boot:1' } });
    expect(screen.queryByLabelText('结果预览（可编辑）')).toBeNull();
    expect(ctx.port.postMessage).toHaveBeenCalledOnce();
  });

  it('keeps the draft, edited text result and completed document translations when switching tools', async () => {
    const ctx = connect();
    render(<WorkbenchApp />);
    ctx.emit({ type: 'hello', context });
    fireEvent.change(screen.getByLabelText('待处理文字'), { target: { value: 'draft to preserve' } });
    fireEvent.click(screen.getByRole('button', { name: '确认发送并翻译' }));
    const writing = ctx.port.postMessage.mock.calls[0][0];
    ctx.emit({ type: 'result', id: writing.id, contextId: context.contextId, reply: { ok: true, value: 'service result' } });
    await screen.findByLabelText('结果预览（可编辑）');
    fireEvent.change(screen.getByLabelText('结果预览（可编辑）'), { target: { value: 'edited result to preserve' } });
    fireEvent.click(screen.getByRole('tab', { name: 'TXT / HTML 文档' }));
    fireEvent.change(screen.getByLabelText('选择文档文件'), { target: { files: [new File([new TextEncoder().encode('Document draft')], 'draft.txt')] } });
    await screen.findByRole('region', { name: '文档原文预览' });
    fireEvent.click(screen.getByRole('button', { name: '确认发送并翻译（最多100段）' }));
    await waitFor(() => expect(ctx.port.postMessage).toHaveBeenCalledTimes(2));
    const documentRequest = ctx.port.postMessage.mock.calls[1][0];
    ctx.emit({ type: 'result', id: documentRequest.id, contextId: context.contextId, reply: { ok: true, value: '文档已译内容' } });
    await waitFor(() => expect(screen.getByRole('region', { name: '文档成果预览' }).textContent).toContain('文档已译内容'));
    fireEvent.click(screen.getByRole('tab', { name: '文字与写作' }));
    expect((screen.getByLabelText('待处理文字') as HTMLTextAreaElement).value).toBe('draft to preserve');
    expect((screen.getByLabelText('结果预览（可编辑）') as HTMLTextAreaElement).value).toBe('edited result to preserve');
    fireEvent.click(screen.getByRole('tab', { name: 'TXT / HTML 文档' }));
    expect(screen.getByRole('region', { name: '文档成果预览' }).textContent).toContain('文档已译内容');
    expect(ctx.port.postMessage).toHaveBeenCalledTimes(2);
  });

  it('integrates document preview locally and sends only text via the same context', async () => {
    const ctx = connect();
    render(<WorkbenchApp />);
    ctx.emit({ type: 'hello', context });
    fireEvent.click(screen.getByRole('tab', { name: 'TXT / HTML 文档' }));
    fireEvent.change(screen.getByLabelText('选择文档文件'), { target: { files: [new File([new TextEncoder().encode('<p>Document body</p>')], 'secret-name.html')] } });
    await screen.findByRole('region', { name: '文档原文预览' });
    expect(ctx.port.postMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认发送并翻译（最多100段）' }));
    await waitFor(() => expect(ctx.port.postMessage).toHaveBeenCalledOnce());
    const request = ctx.port.postMessage.mock.calls[0][0];
    expect(request).toMatchObject({ type: 'translate', contextId: context.contextId, text: 'Document body', operation: 'translate' });
    expect(JSON.stringify(request)).not.toContain('secret-name');
    ctx.emit({ type: 'result', id: request.id, contextId: context.contextId, reply: { ok: true, value: '文档正文' } });
    await waitFor(() => expect(screen.getByRole('region', { name: '文档成果预览' }).textContent).toContain('文档正文'));
    ctx.close();
    expect((screen.getByRole('button', { name: '选择文档' })).textContent).toContain('选择文档');
    expect(screen.queryByRole('region', { name: '文档成果预览' })).toBeNull();
  });
});
