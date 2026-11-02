import React from 'react';
import { ThemeProvider } from '@mui/material';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reply } from '../../src/shared/contracts';
import { ImagesPanel, type ImageRecognition, type ImagesPanelProps } from '../../src/ui/images';
import { md2Theme } from '../../src/ui/theme';

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngDataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...pngBytes))}`;
const configuration = {
  revision: 'images-1', recipient: 'https://vision.invalid/v1', model: 'user-model', targetLanguage: 'zh-CN', ready: true,
};
const drawImage = vi.fn();
const createObjectURL = vi.fn(() => `blob:preview-${createObjectURL.mock.calls.length}`);
const revokeObjectURL = vi.fn();

class TestImage {
  decoding = '';
  src = '';
  naturalWidth = 1000;
  naturalHeight = 500;
  async decode() {}
}

function success(value: ImageRecognition): Reply<ImageRecognition> {
  return { ok: true, value };
}

function imageFile(name: string): File {
  const file = new File([pngBytes], name, { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => pngBytes.slice().buffer });
  return file;
}

function deferred() {
  let resolve!: (reply: Reply<ImageRecognition>) => void;
  const promise = new Promise<Reply<ImageRecognition>>(done => { resolve = done; });
  return { promise, resolve };
}

function view(props: Partial<ImagesPanelProps> = {}) {
  return (
    <ThemeProvider theme={md2Theme}>
      <ImagesPanel
        configuration={configuration}
        recognize={async () => success({ source: 'source', translation: 'translation' })}
        {...props}
      />
    </ThemeProvider>
  );
}

async function upload(name = 'private-name.png'): Promise<void> {
  fireEvent.change(screen.getByLabelText('选择图像文件'), { target: { files: [imageFile(name)] } });
  await screen.findByRole('region', { name: '实际待上传图像' });
}

function pointer(target: Element, type: 'pointerdown' | 'pointerup', x: number, y: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
  fireEvent(target, event);
}

beforeEach(() => {
  drawImage.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('Image', TestImage);
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(pngDataUrl);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ImagesPanel local preview and explicit sending', () => {
  it('keeps selection and crop local, maps drag coordinates, and sends only the previewed PNG after confirmation', async () => {
    const recognize = vi.fn(async (_dataUrl: string, _signal: AbortSignal) => success({ source: 'hello', translation: '你好' }));
    render(view({ recognize }));
    await upload();
    expect(recognize).not.toHaveBeenCalled();
    expect(screen.getByText(/接收方：https:\/\/vision.invalid\/v1/).textContent).toContain('user-model');
    expect(screen.getByText(/此名称仅本地显示，不会发送/).textContent).toContain('private-name.png');

    const image = screen.getByAltText('待裁剪原图');
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 50, left: 100, top: 50, right: 300, bottom: 150, width: 200, height: 100, toJSON: () => ({}),
    });
    pointer(image, 'pointerdown', 120, 60);
    pointer(image, 'pointerup', 180, 90);
    await waitFor(() => expect((screen.getByLabelText('裁剪 X') as HTMLInputElement).value).toBe('100'));
    expect((screen.getByLabelText('裁剪 Y') as HTMLInputElement).value).toBe('50');
    expect((screen.getByLabelText('裁剪宽度') as HTMLInputElement).value).toBe('300');
    expect((screen.getByLabelText('裁剪高度') as HTMLInputElement).value).toBe('150');
    expect(drawImage).toHaveBeenLastCalledWith(expect.anything(), 100, 50, 300, 150, 0, 0, 300, 150);
    expect(recognize).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认并发送当前区域' }));
    await screen.findByRole('region', { name: '图像识别结果' });
    expect(recognize).toHaveBeenCalledOnce();
    expect(recognize.mock.calls[0][0]).toBe(pngDataUrl);
    expect(recognize.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it('accepts a controlled screenshot crop without sending it on mount', async () => {
    const recognize = vi.fn(async () => success({ source: 'unused', translation: 'unused' }));
    render(view({ recognize, initialImage: pngDataUrl }));
    await screen.findByText(/截图裁剪结果/);
    expect(await screen.findByRole('region', { name: '实际待上传图像' })).not.toBeNull();
    expect(recognize).not.toHaveBeenCalled();
  });

  it('keeps invalid manual coordinates visible and refuses to produce or send a silently clamped region', async () => {
    const recognize = vi.fn(async () => success({ source: 'unused', translation: 'unused' }));
    render(view({ recognize }));
    await upload();
    fireEvent.click(screen.getByRole('button', { name: '启用坐标裁剪' }));
    fireEvent.change(screen.getByLabelText('裁剪 X'), { target: { value: '999' } });
    fireEvent.change(screen.getByLabelText('裁剪宽度'), { target: { value: '2' } });
    await screen.findByText(/裁剪坐标必须是原图范围内/);
    expect(screen.queryByRole('region', { name: '实际待上传图像' })).toBeNull();
    expect(screen.getByRole('button', { name: '确认并发送当前区域' }).hasAttribute('disabled')).toBe(true);
    expect(recognize).not.toHaveBeenCalled();
  });
});

describe('ImagesPanel cancellation and stale results', () => {
  it('aborts on cancel and replacement, ignores both late replies, and releases only replaced previews', async () => {
    const first = deferred();
    const second = deferred();
    const recognize = vi.fn<ImagesPanelProps['recognize']>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(view({ recognize }));
    await upload('old-private.png');
    fireEvent.click(screen.getByRole('button', { name: '确认并发送当前区域' }));
    await waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '取消识别' }));
    expect(recognize.mock.calls[0][1].aborted).toBe(true);
    await act(async () => first.resolve(success({ source: 'cancelled stale', translation: '取消迟到' })));
    expect(screen.queryByText('cancelled stale')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '确认并发送当前区域' }));
    await waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await upload('new-private.png');
    expect(recognize.mock.calls[1][1].aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    await act(async () => second.resolve(success({ source: 'replaced stale', translation: '换图迟到' })));
    expect(screen.queryByText('replaced stale')).toBeNull();
    expect(screen.getByText(/new-private\.png/)).not.toBeNull();
  });

  it('aborts and clears state on configuration revision changes and panel close', async () => {
    const first = deferred();
    const second = deferred();
    const recognize = vi.fn<ImagesPanelProps['recognize']>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const mounted = render(view({ recognize }));
    await upload('configuration.png');
    fireEvent.click(screen.getByRole('button', { name: '确认并发送当前区域' }));
    await waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    mounted.rerender(view({ recognize, configuration: { ...configuration, revision: 'images-2' } }));
    expect(recognize.mock.calls[0][1].aborted).toBe(true);
    expect(screen.queryByAltText('待裁剪原图')).toBeNull();

    await upload('close.png');
    fireEvent.click(screen.getByRole('button', { name: '确认并发送当前区域' }));
    await waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    mounted.unmount();
    expect(recognize.mock.calls[1][1].aborted).toBe(true);
    await act(async () => second.resolve(success({ source: 'closed stale', translation: '关闭迟到' })));
  });
});

describe('ImagesPanel result safety and honest failures', () => {
  it('renders malicious-looking recognition text literally and switches between image and result', async () => {
    const source = '<img src=x onerror="attack()"> recognized';
    const translation = '<script>attack()</script> translated';
    render(view({ recognize: async () => success({ source, translation }) }));
    await upload();
    fireEvent.click(screen.getByRole('button', { name: '确认并发送当前区域' }));
    const result = await screen.findByRole('region', { name: '图像识别结果' });
    expect(result.textContent).toContain(source);
    expect(result.textContent).toContain(translation);
    expect(result.querySelector('img,script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看原图与发送区域' }));
    expect(screen.queryByRole('region', { name: '图像识别结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看识别结果' }));
    expect(screen.getByRole('region', { name: '图像识别结果' })).not.toBeNull();
  });

  it('does not claim success for an empty recognition and surfaces unsupported and rejected requests', async () => {
    const recognize = vi.fn<ImagesPanelProps['recognize']>()
      .mockResolvedValueOnce(success({ source: ' ', translation: '' }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'unsupported', message: '当前模型不支持图像输入。' } })
      .mockRejectedValueOnce(new Error('private transport details'));
    render(view({ recognize }));
    await upload();
    fireEvent.click(screen.getByRole('button', { name: '确认并发送当前区域' }));
    await screen.findByText(/未返回可用的识别原文和译文/);
    expect(screen.queryByRole('region', { name: '图像识别结果' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '确认并发送当前区域' }));
    await screen.findByText(/unsupported：当前模型不支持图像输入/);
    fireEvent.click(screen.getByRole('button', { name: '确认并发送当前区域' }));
    await screen.findByText(/network：图像请求失败/);
    expect(screen.queryByText(/private transport details/)).toBeNull();
  });
});
