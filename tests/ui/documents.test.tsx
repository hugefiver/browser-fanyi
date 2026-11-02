import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { DocumentsPanel, type DocumentConfiguration, type DocumentsPanelProps } from '../../src/ui/documents';
import type { Reply } from '../../src/shared/contracts';
import { md2Theme } from '../../src/ui/theme';

const configuration: DocumentConfiguration = {
  revision: 'context-1', recipient: 'https://translator.invalid/v1', model: 'chosen-model', targetLanguage: 'zh-CN', ready: true,
};
const success = (value: string): Reply<string> => ({ ok: true, value });
const failure: Reply<string> = { ok: false, error: { code: 'rate-limit', message: '限流，请稍后主动重试。' } };
function view(props: Partial<DocumentsPanelProps> = {}) {
  return <ThemeProvider theme={md2Theme}><DocumentsPanel configuration={configuration} translate={async text => success(`译:${text}`)} {...props} /></ThemeProvider>;
}
async function upload(text: string, name = 'private-name.txt') {
  fireEvent.change(screen.getByLabelText('选择文档文件'), { target: { files: [new File([new TextEncoder().encode(text)], name)] } });
  await waitFor(() => expect(screen.queryByRole('region', { name: '文档原文预览' })).not.toBeNull());
}
const start = () => fireEvent.click(screen.getByRole('button', { name: '确认发送并翻译（最多100段）' }));
const continueRound = () => fireEvent.click(screen.getByRole('button', { name: '继续发送（最多100段）' }));
const retry = () => fireEvent.click(screen.getByRole('button', { name: '仅重试失败段（最多100段）' }));
function deferred() {
  let resolve!: (value: Reply<string>) => void;
  const promise = new Promise<Reply<string>>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('reusable documents panel', () => {
  it('imports locally, displays recipient/model/range/cost, and sends only reading text on explicit confirmation', async () => {
    const translate = vi.fn(async (text: string, _signal: AbortSignal) => success(`译:${text}`));
    render(view({ translate }));
    await upload('<h2>Title</h2><p onclick="evil()">Body <a href="https://private.invalid/secret">label</a></p>'
      + '<img src="https://private.invalid/image"><script>private script</script>', 'private-name.html');
    expect(translate).not.toHaveBeenCalled();
    expect(screen.getByText(/https:\/\/translator.invalid\/v1/).textContent).toContain('chosen-model');
    expect(screen.getByText(/每轮最多发送 100 段/).textContent).toContain('费用');
    const preview = screen.getByRole('region', { name: '文档原文预览' });
    expect(preview.querySelector('h2')?.textContent).toBe('Title');
    expect(preview.querySelector('a,img,script,[onclick],[href],[src]')).toBeNull();
    start();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('翻译已完成'));
    expect(translate.mock.calls.map(call => call[0])).toEqual(['Title', 'Body ', 'label']);
    expect(translate.mock.calls.every(call => call[1] instanceof AbortSignal)).toBe(true);
    expect(screen.getByRole('region', { name: '文档成果预览' }).textContent).toContain('译:Title');
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it('keeps configuration-disabled import local and surfaces invalid UTF-8 instead of sending', async () => {
    const translate = vi.fn(async () => success('unused'));
    render(view({ translate, configuration: { ...configuration, ready: false } }));
    await upload('local');
    expect((screen.getByRole('button', { name: '确认发送并翻译（最多100段）' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('选择文档文件'), { target: { files: [new File([new Uint8Array([0xff])], 'invalid.txt')] } });
    await waitFor(() => expect(screen.getByText(/文件必须是有效 UTF-8/)).not.toBeNull());
    expect(screen.queryByRole('region', { name: '文档原文预览' })).toBeNull();
    expect(translate).not.toHaveBeenCalled();
  });

  it('requires an active continuation after 100 segments and never retransmits successful segments', async () => {
    const translate = vi.fn(async (text: string) => success(`translated ${text}`));
    render(view({ translate }));
    await upload(Array.from({ length: 102 }, (_, index) => `paragraph-${index}`).join('\n'));
    start();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('本轮已结束'));
    expect(translate).toHaveBeenCalledTimes(100);
    expect(screen.getByRole('status').textContent).toContain('待发送 2');
    continueRound();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('翻译已完成'));
    expect(translate).toHaveBeenCalledTimes(102);
    expect(new Set(translate.mock.calls.map(call => call[0])).size).toBe(102);
  });

  it('preserves successful segments, identifies failed source positions, and retries only failures by user action', async () => {
    const translate = vi.fn(async (text: string) => text === 'second' ? failure : success(`done ${text}`));
    render(view({ translate }));
    await upload('first\nsecond\nthird');
    start();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('部分失败'));
    expect(screen.getByText(/第 2 段 · rate-limit/)).not.toBeNull();
    expect(screen.getByRole('region', { name: '文档成果预览' }).textContent).toContain('[未译原文 · 第 2 段] second');
    expect(translate).toHaveBeenCalledTimes(3);
    translate.mockImplementation(async text => success(`retry ${text}`));
    retry();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('翻译已完成'));
    expect(translate.mock.calls.map(call => call[0])).toEqual(['first', 'second', 'third', 'second']);
    expect(screen.getByRole('region', { name: '文档成果预览' }).textContent).toContain('done first');
  });

  it('cancels promptly, ignores a late response, and can explicitly resume the unfinished segment', async () => {
    const old = deferred();
    const translate = vi.fn((_text: string, _signal: AbortSignal) => old.promise);
    render(view({ translate }));
    await upload('first\nsecond');
    start();
    await waitFor(() => expect(translate).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '取消翻译' }));
    expect(translate.mock.calls[0][1].aborted).toBe(true);
    await act(async () => old.resolve(success('stale result')));
    expect(screen.getByRole('status').textContent).toContain('成功 0');
    expect(screen.queryByText(/stale result/)).toBeNull();
    translate.mockImplementation(async text => success(`fresh ${text}`));
    continueRound();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('翻译已完成'));
    expect(translate.mock.calls.map(call => call[0])).toEqual(['first', 'first', 'second']);
  });

  it('invalidates work on file replacement and configuration revision changes, and aborts on unmount', async () => {
    const old = deferred();
    const translate = vi.fn((_text: string, _signal: AbortSignal) => old.promise);
    const mounted = render(view({ translate }));
    await upload('old file');
    start();
    await waitFor(() => expect(translate).toHaveBeenCalledOnce());
    await upload('new file', 'new.txt');
    expect(translate.mock.calls[0][1].aborted).toBe(true);
    await act(async () => old.resolve(success('obsolete translation')));
    expect(screen.getByRole('region', { name: '文档原文预览' }).textContent).toBe('new file');
    expect(screen.getByRole('region', { name: '文档成果预览' }).textContent).not.toContain('obsolete');
    const second = deferred();
    translate.mockImplementation(() => second.promise);
    start();
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
    mounted.rerender(view({ translate, configuration: { ...configuration, revision: 'context-2' } }));
    expect(translate.mock.calls[1][1].aborted).toBe(true);
    await act(async () => second.resolve(success('old configuration result')));
    expect(screen.queryByRole('region', { name: '文档成果预览' })).toBeNull();
    await upload('third file');
    const third = deferred();
    translate.mockImplementation(() => third.promise);
    start();
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(3));
    mounted.unmount();
    expect(translate.mock.calls[2][1].aborted).toBe(true);
    await act(async () => third.resolve(success('after close')));
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it('settles a nonresponsive external translator after 25 seconds without automatic retry', async () => {
    const translate = vi.fn((_text: string, _signal: AbortSignal) => new Promise<Reply<string>>(() => {}));
    render(view({ translate }));
    await upload('slow');
    vi.useFakeTimers();
    start();
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    expect(screen.getByRole('status').textContent).toContain('部分失败');
    expect(screen.getByText(/第 1 段 · timeout/)).not.toBeNull();
    expect(translate.mock.calls[0][1].aborted).toBe(true);
    expect(translate).toHaveBeenCalledOnce();
  });

  it('reports rejected and empty translator responses as retryable failures', async () => {
    const translate = vi.fn<DocumentsPanelProps['translate']>()
      .mockRejectedValueOnce(new Error('private transport details'))
      .mockResolvedValueOnce(success('  '));
    render(view({ translate }));
    await upload('first\nsecond');
    start();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('失败 2'));
    expect(screen.getByText(/第 1 段 · network/)).not.toBeNull();
    expect(screen.getByText(/第 2 段 · invalid-response/)).not.toBeNull();
    expect(screen.queryByText(/private transport details/)).toBeNull();
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('exports real text and safe HTML Blobs in the selected mode, including marked originals for failures', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:panel-output');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const translate = vi.fn(async (text: string) => text === 'second' ? failure : success('<script>alert(1)</script> translated'));
    render(view({ translate }));
    await upload('first\nsecond');
    start();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('部分失败'));
    expect(screen.getByRole('region', { name: '文档成果预览' }).querySelector('script')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '预览与导出模式' }));
    fireEvent.click(screen.getByRole('option', { name: '仅译文（未译段保留标识原文）' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 TXT' }));
    const readBlob = (blob: Blob): Promise<string> => new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    const textBlob = createObjectURL.mock.calls[0][0] as Blob;
    expect(textBlob).toBeInstanceOf(Blob);
    expect(await readBlob(textBlob)).toBe('<script>alert(1)</script> translated\n[未译原文 · 第 2 段] second');
    fireEvent.click(screen.getByRole('button', { name: '导出安全 HTML' }));
    const htmlBlob = createObjectURL.mock.calls[1][0] as Blob;
    const template = document.createElement('template');
    template.innerHTML = await readBlob(htmlBlob);
    expect(template.content.querySelector('script')).toBeNull();
    expect(template.content.querySelector('pre')?.textContent).toContain('<script>alert(1)</script> translated');
    expect(translate).toHaveBeenCalledTimes(2);
  });
});
