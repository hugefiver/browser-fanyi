import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Failure, PublicSettings, Reply } from '../../src/shared/contracts';
import type { SubtitlesServerMessage } from '../../src/shared/subtitles';

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../src/shared/browser', () => ({
  default: { runtime: { connect: (...args: unknown[]) => mocks.connect(...args) } },
}));

import { SubtitlesApp } from '../../src/ui/subtitles';

class PortEvent<T extends (...args: never[]) => void> {
  listeners: T[] = [];
  addListener = (listener: T) => { this.listeners.push(listener); };
  emit(...args: Parameters<T>) { for (const listener of this.listeners) listener(...args); }
}

class UiPort {
  readonly onMessage = new PortEvent<(message: unknown) => void>();
  readonly onDisconnect = new PortEvent<() => void>();
  readonly sent: unknown[] = [];
  disconnected = false;
  postMessage = (message: unknown) => { this.sent.push(message); };
  disconnect = () => {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  };
  emit(message: SubtitlesServerMessage) { this.onMessage.emit(message); }
}

const settings: PublicSettings = {
  prefix: 'https://receiver.example/v1',
  model: 'test-model',
  hasKey: true,
  authorized: true,
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  mode: 'bilingual',
};
const context = { contextId: 'boot-a:0', settings };
const ports: UiPort[] = [];
const srt = (count: number) => Array.from({ length: count }, (_, index) => `${index + 1}\n00:00:${String(index % 60).padStart(2, '0')},000 --> 00:00:${String((index + 1) % 60).padStart(2, '0')},000\nsource ${index + 1}`).join('\n\n');

function file(name: string, source: string, read?: () => Promise<ArrayBuffer>): File {
  const bytes = new TextEncoder().encode(source);
  const value = new File([bytes], name, { type: 'application/x-subrip' });
  Object.defineProperty(value, 'arrayBuffer', { value: read ?? (async () => bytes.buffer) });
  return value;
}

async function choose(value: File): Promise<void> {
  const input = screen.getByLabelText('选择 SRT 文件');
  fireEvent.change(input, { target: { files: [value] } });
  await screen.findByText(/已在本机校验/);
}

function hello(port: UiPort, nextContext = context): void {
  act(() => port.emit({ type: 'hello', context: nextContext }));
}

function failure(code: Failure['code'], message: string): Reply<never> {
  return { ok: false, error: { code, message } };
}

beforeEach(() => {
  ports.length = 0;
  mocks.connect.mockReset();
  mocks.connect.mockImplementation(() => {
    const port = new UiPort();
    ports.push(port);
    return port;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('subtitle file selection and preview', () => {
  it('reads and validates locally, sends nothing, and paginates by 50 cues', async () => {
    render(<SubtitlesApp />);
    expect(ports).toHaveLength(1);
    hello(ports[0]);
    await choose(file('captions.srt', srt(51)));
    expect(ports).toHaveLength(2);
    expect(ports[0].disconnected).toBe(true);
    expect(ports[1].sent).toEqual([]);
    expect(screen.getByText('条目 1 · 编号 1')).not.toBeNull();
    expect(screen.queryByText('条目 51 · 编号 51')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('条目 51 · 编号 51')).not.toBeNull();
    expect(screen.queryByText('条目 1 · 编号 1')).toBeNull();
  });

  it('ignores a stale asynchronous file read after a newer selection', async () => {
    let finish!: (buffer: ArrayBuffer) => void;
    const oldBytes = new TextEncoder().encode(srt(1));
    const old = file('old.srt', srt(1), () => new Promise((resolve) => { finish = resolve; }));
    const newer = file('new.srt', srt(2));
    render(<SubtitlesApp />);
    hello(ports[0]);

    fireEvent.change(screen.getByLabelText('选择 SRT 文件'), { target: { files: [old] } });
    fireEvent.change(screen.getByLabelText('选择 SRT 文件'), { target: { files: [newer] } });
    await screen.findByText(/new\.srt · 2 条/);
    finish(oldBytes.buffer);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/new\.srt · 2 条/)).not.toBeNull();
    expect(screen.queryByText(/old\.srt/)).toBeNull();
  });
});

describe('subtitle attempts and export', () => {
  it('requires confirmation, retries only unfinished cues, and downloads complete CRLF output', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:subtitle');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    render(<SubtitlesApp />);
    hello(ports[0]);
    await choose(file('captions.srt', srt(2)));
    hello(ports[1]);
    const start = screen.getByRole('button', { name: '开始翻译全部字幕' });
    expect(start.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText(/我确认/));
    expect(start.hasAttribute('disabled')).toBe(false);
    fireEvent.click(start);

    expect(ports).toHaveLength(3);
    hello(ports[2]);
    const firstStart = ports[2].sent.at(-1) as {
      type: string; runId: string; contextId: string; source: string; indices?: number[]; completedTranslationBytes: number;
    };
    expect(firstStart).toMatchObject({
      type: 'start', contextId: context.contextId, source: srt(2), indices: undefined, completedTranslationBytes: 0,
    });
    act(() => ports[2].emit({ type: 'started', runId: firstStart.runId, contextId: context.contextId, indices: [0, 1] }));
    act(() => ports[2].emit({ type: 'cue', runId: firstStart.runId, contextId: context.contextId, index: 0, reply: { ok: true, value: '译文一' } }));
    act(() => ports[2].emit({ type: 'cue', runId: firstStart.runId, contextId: context.contextId, index: 1, reply: failure('network', '网络失败') }));
    act(() => ports[2].emit({ type: 'done', runId: firstStart.runId, contextId: context.contextId, requested: 2, completed: 1, failed: 1 }));

    const retry = screen.getByRole('button', { name: '重试未完成或失败（1）' });
    fireEvent.click(retry);
    expect(ports).toHaveLength(4);
    hello(ports[3]);
    const secondStart = ports[3].sent.at(-1) as {
      type: string; runId: string; contextId: string; indices: number[]; completedTranslationBytes: number;
    };
    expect(secondStart.indices).toEqual([1]);
    expect(secondStart.completedTranslationBytes).toBe(new TextEncoder().encode('译文一').byteLength);
    act(() => ports[3].emit({ type: 'started', runId: secondStart.runId, contextId: context.contextId, indices: [1] }));
    act(() => ports[3].emit({ type: 'cue', runId: secondStart.runId, contextId: context.contextId, index: 1, reply: { ok: true, value: '译文二' } }));
    act(() => ports[3].emit({ type: 'done', runId: secondStart.runId, contextId: context.contextId, requested: 1, completed: 1, failed: 0 }));

    const download = screen.getByRole('button', { name: '下载完整译文 SRT' });
    expect(download.hasAttribute('disabled')).toBe(false);
    fireEvent.click(download);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(text).toContain('00:00:00,000 --> 00:00:01,000\r\n译文一');
    expect(text).toContain('00:00:01,000 --> 00:00:02,000\r\n译文二');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('cancels the owning port, preserves successes, and offers only unresolved cues', async () => {
    render(<SubtitlesApp />);
    hello(ports[0]);
    await choose(file('cancel.srt', srt(2)));
    hello(ports[1]);
    fireEvent.click(screen.getByLabelText(/我确认/));
    fireEvent.click(screen.getByRole('button', { name: '开始翻译全部字幕' }));
    hello(ports[2]);
    const message = ports[2].sent.at(-1) as { runId: string };
    act(() => ports[2].emit({ type: 'started', runId: message.runId, contextId: context.contextId, indices: [0, 1] }));
    act(() => ports[2].emit({ type: 'cue', runId: message.runId, contextId: context.contextId, index: 0, reply: { ok: true, value: '保留结果' } }));
    fireEvent.click(screen.getByRole('button', { name: '取消翻译' }));

    expect(ports[2].sent).toContainEqual({ type: 'cancel', runId: message.runId });
    expect(ports[2].disconnected).toBe(true);
    expect(ports).toHaveLength(4);
    hello(ports[3]);
    expect(screen.getByText('保留结果')).not.toBeNull();
    expect(screen.getByRole('button', { name: '重试未完成或失败（1）' })).not.toBeNull();
  });

  it('reports a concrete serialization error and disables the invalid export', async () => {
    render(<SubtitlesApp />);
    hello(ports[0]);
    await choose(file('invalid-output.srt', srt(1)));
    hello(ports[1]);
    fireEvent.click(screen.getByLabelText(/我确认/));
    fireEvent.click(screen.getByRole('button', { name: '开始翻译全部字幕' }));
    hello(ports[2]);
    const message = ports[2].sent.at(-1) as { runId: string };
    act(() => ports[2].emit({ type: 'started', runId: message.runId, contextId: context.contextId, indices: [0] }));
    act(() => ports[2].emit({
      type: 'cue', runId: message.runId, contextId: context.contextId, index: 0, reply: { ok: true, value: '无效\0译文' },
    }));
    act(() => ports[2].emit({
      type: 'done', runId: message.runId, contextId: context.contextId, requested: 1, completed: 1, failed: 0,
    }));

    fireEvent.click(screen.getByRole('button', { name: '下载完整译文 SRT' }));
    expect(screen.getByText(/译文.*NUL/)).not.toBeNull();
    expect(screen.getByRole('button', { name: '下载完整译文 SRT' }).hasAttribute('disabled')).toBe(true);
  });

  it('revokes completed export when the listening port reports a context change', async () => {
    render(<SubtitlesApp />);
    hello(ports[0]);
    await choose(file('context.srt', srt(1)));
    hello(ports[1]);
    fireEvent.click(screen.getByLabelText(/我确认/));
    fireEvent.click(screen.getByRole('button', { name: '开始翻译全部字幕' }));
    hello(ports[2]);
    const message = ports[2].sent.at(-1) as { runId: string };
    act(() => ports[2].emit({ type: 'started', runId: message.runId, contextId: context.contextId, indices: [0] }));
    act(() => ports[2].emit({ type: 'cue', runId: message.runId, contextId: context.contextId, index: 0, reply: { ok: true, value: '完成' } }));
    act(() => ports[2].emit({ type: 'done', runId: message.runId, contextId: context.contextId, requested: 1, completed: 1, failed: 0 }));
    expect(screen.getByRole('button', { name: '下载完整译文 SRT' }).hasAttribute('disabled')).toBe(false);

    act(() => ports[2].emit({
      type: 'invalidated',
      contextId: 'boot-a:1',
      error: { code: 'interrupted', message: '配置已变化。' },
    }));
    expect(screen.getByRole('button', { name: '下载完整译文 SRT' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('配置已变化。')).not.toBeNull();
    expect(ports[2].disconnected).toBe(true);
    expect(ports).toHaveLength(4);
  });

  it('treats an unexpected completed-port disconnect as an interrupted fresh start', async () => {
    render(<SubtitlesApp />);
    hello(ports[0]);
    await choose(file('restart.srt', srt(1)));
    hello(ports[1]);
    fireEvent.click(screen.getByLabelText(/我确认/));
    fireEvent.click(screen.getByRole('button', { name: '开始翻译全部字幕' }));
    hello(ports[2]);
    const message = ports[2].sent.at(-1) as { runId: string };
    act(() => ports[2].emit({ type: 'started', runId: message.runId, contextId: context.contextId, indices: [0] }));
    act(() => ports[2].emit({ type: 'cue', runId: message.runId, contextId: context.contextId, index: 0, reply: { ok: true, value: '完成' } }));
    act(() => ports[2].emit({ type: 'done', runId: message.runId, contextId: context.contextId, requested: 1, completed: 1, failed: 0 }));
    act(() => ports[2].disconnect());

    expect(screen.getByText(/与后台的连接已中断/)).not.toBeNull();
    expect(screen.getByRole('button', { name: '下载完整译文 SRT' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '开始翻译全部字幕' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '重新连接后台' })).not.toBeNull();
  });
});
