import type browser from '../shared/browser';
import type { Tabs } from 'webextension-polyfill';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  ImageError,
  validateImageCrop,
  type ImageCrop,
  type ImageDimensions,
} from '../shared/images';
import type {
  CapturePageSnapshot,
  CaptureRect,
  CaptureRegionFailureReason,
  CaptureRegionResult,
  CaptureRegionSelection,
  CaptureViewport,
} from '../content/capture-region';

export interface CaptureSelectionEnvelope {
  documentId: string;
  result: CaptureRegionResult;
}

export interface CapturePageEnvelope {
  documentId: string;
  page: CapturePageSnapshot;
}

export interface CaptureContentBridge {
  select(tabId: number): Promise<CaptureSelectionEnvelope>;
  inspect(tabId: number, documentId: string): Promise<CapturePageEnvelope>;
  cancel(tabId: number): void | Promise<void>;
}

export interface DecodedCaptureImage extends ImageDimensions {
  crop(area: ImageCrop): Promise<string>;
  dispose(): void;
}

export type CaptureDecoder = (dataUrl: string) => Promise<DecodedCaptureImage>;
export type CaptureCropper = (
  dataUrl: string,
  rect: CaptureRect,
  viewport: CaptureViewport,
) => Promise<string>;

export type CaptureFailureCode =
  | CaptureRegionFailureReason
  | 'unsupported'
  | 'tab-changed'
  | 'document-changed'
  | 'invalid-selection'
  | 'capture-failed'
  | 'crop-failed';

export interface CaptureFailure {
  code: CaptureFailureCode;
  message: string;
}

export type CaptureReply =
  | { ok: true; value: { dataUrl: string; selection: CaptureRegionSelection } }
  | { ok: false; error: CaptureFailure };

interface ActiveTabSnapshot {
  id: number;
  windowId: number;
  url: string;
}

const failureMessages: Record<CaptureFailureCode, string> = {
  busy: '已有区域截图操作正在进行。',
  cancelled: '区域截图已取消。',
  escape: '区域截图已取消。',
  'viewport-changed': '页面滚动、缩放或可见区域已变化，请重新框选。',
  'url-changed': '页面地址已变化，请重新框选。',
  'empty-area': '截图区域不能为空。',
  unsupported: '当前标签页不支持区域截图。',
  'tab-changed': '活动标签页或窗口已变化，请重新框选。',
  'document-changed': '页面文档已变化，请重新框选。',
  'invalid-selection': '截图区域或页面尺寸无效。',
  'capture-failed': '浏览器未能捕获当前可见页面。',
  'crop-failed': '浏览器未能在本地裁剪截图。',
};

class CaptureStateError extends Error {
  constructor(readonly code: CaptureFailureCode) {
    super(failureMessages[code]);
  }
}

function failure(code: CaptureFailureCode, message = failureMessages[code]): CaptureReply {
  return { ok: false, error: { code, message } };
}

function validViewport(viewport: CaptureViewport): boolean {
  return [viewport.width, viewport.height, viewport.scrollX, viewport.scrollY, viewport.dpr].every(Number.isFinite)
    && viewport.width > 0 && viewport.height > 0 && viewport.dpr > 0;
}

function sameViewport(left: CaptureViewport, right: CaptureViewport): boolean {
  return left.width === right.width && left.height === right.height
    && left.scrollX === right.scrollX && left.scrollY === right.scrollY && left.dpr === right.dpr;
}

export function scaleCaptureRect(
  rect: CaptureRect,
  viewport: CaptureViewport,
  image: ImageDimensions,
): ImageCrop {
  if (!validViewport(viewport)
    || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height
    || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1) {
    throw new ImageError('invalid-crop', '截图区域或页面尺寸无效。');
  }
  const x = Math.floor(rect.x * image.width / viewport.width);
  const y = Math.floor(rect.y * image.height / viewport.height);
  const right = Math.ceil((rect.x + rect.width) * image.width / viewport.width);
  const bottom = Math.ceil((rect.y + rect.height) * image.height / viewport.height);
  const area = validateImageCrop({ x, y, width: right - x, height: bottom - y }, image);
  if (area.width * area.height > IMAGE_MAX_PIXELS) {
    throw new ImageError('pixel-limit', '截图区域超过 1600 万像素，请缩小后重试。');
  }
  return area;
}

export async function crop(
  dataUrl: string,
  rect: CaptureRect,
  viewport: CaptureViewport,
  decoder: CaptureDecoder = decodeCaptureImage,
): Promise<string> {
  const image = await decoder(dataUrl);
  try {
    const output = await image.crop(scaleCaptureRect(rect, viewport, image));
    assertEncodedSize(output);
    return output;
  } finally {
    image.dispose();
  }
}

function assertEncodedSize(dataUrl: string): void {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new ImageError('canvas-failed', '本地截图裁剪未生成有效 PNG。');
  const padding = match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0;
  const bytes = match[1].length / 4 * 3 - padding;
  if (bytes > IMAGE_MAX_BYTES) {
    throw new ImageError('encoded-too-large', '实际待发送 PNG 超过 4 MiB，请明确选择更小的裁剪范围。');
  }
}

async function blobDataUrl(blob: Blob): Promise<string> {
  if (blob.size > IMAGE_MAX_BYTES) {
    throw new ImageError('encoded-too-large', '实际待发送 PNG 超过 4 MiB，请明确选择更小的裁剪范围。');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(chunks.join(''))}`;
}

async function decodeOffscreen(dataUrl: string): Promise<DecodedCaptureImage> {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new ImageError('decode-failed', '浏览器无法解码可见页面截图。');
  const bitmap = await createImageBitmap(await response.blob());
  if (bitmap.width < 1 || bitmap.height < 1) {
    bitmap.close();
    throw new ImageError('decode-failed', '浏览器返回了无效截图尺寸。');
  }
  return {
    width: bitmap.width,
    height: bitmap.height,
    async crop(area) {
      const canvas = new OffscreenCanvas(area.width, area.height);
      const context = canvas.getContext('2d');
      if (!context) throw new ImageError('canvas-failed', '浏览器无法创建后台裁剪画布。');
      context.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
      return blobDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
    },
    dispose: () => bitmap.close(),
  };
}

async function decodeDom(dataUrl: string): Promise<DecodedCaptureImage> {
  const image = new Image();
  image.decoding = 'async';
  image.src = dataUrl;
  try {
    await image.decode();
  } catch {
    throw new ImageError('decode-failed', '浏览器无法解码可见页面截图。');
  }
  if (image.naturalWidth < 1 || image.naturalHeight < 1) {
    throw new ImageError('decode-failed', '浏览器返回了无效截图尺寸。');
  }
  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    async crop(area) {
      const canvas = document.createElement('canvas');
      canvas.width = area.width;
      canvas.height = area.height;
      const context = canvas.getContext('2d');
      if (!context) throw new ImageError('canvas-failed', '浏览器无法创建本地裁剪画布。');
      context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
      return canvas.toDataURL('image/png');
    },
    dispose: () => { image.src = ''; },
  };
}

export async function decodeCaptureImage(dataUrl: string): Promise<DecodedCaptureImage> {
  if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
    return decodeOffscreen(dataUrl);
  }
  if (typeof document !== 'undefined' && typeof Image === 'function') return decodeDom(dataUrl);
  throw new ImageError('canvas-failed', '当前后台上下文不支持本地截图裁剪。');
}

export class Capture {
  constructor(
    private readonly api: typeof browser,
    private readonly bridge: CaptureContentBridge,
    private readonly cropper: CaptureCropper = crop,
  ) {}

  async capture(tabId: number): Promise<CaptureReply> {
    let initial: ActiveTabSnapshot;
    try {
      initial = await this.activeTab(tabId);
    } catch (error) {
      return this.stateFailure(error, 'unsupported');
    }

    let switched = false;
    const activated = (info: Tabs.OnActivatedActiveInfoType): void => {
      if (info.windowId !== initial.windowId || info.tabId === tabId) return;
      switched = true;
      void Promise.resolve().then(() => this.bridge.cancel(tabId)).catch(() => undefined);
    };
    const focused = (windowId: number): void => {
      if (windowId === initial.windowId) return;
      switched = true;
      void Promise.resolve(this.bridge.cancel(tabId)).catch(() => undefined);
    };
    this.api.tabs.onActivated.addListener(activated);
    this.api.windows.onFocusChanged.addListener(focused);

    try {
      let envelope: CaptureSelectionEnvelope;
      try {
        envelope = await this.bridge.select(tabId);
      } catch {
        return failure(switched ? 'tab-changed' : 'unsupported');
      }
      if (switched) return failure('tab-changed');
      if (!envelope.result.ok) return failure(envelope.result.reason);

      const selection = envelope.result.value;
      try {
        this.assertSelection(envelope.documentId, selection, initial);
        await this.activeTab(tabId, initial);
        await this.assertPage(tabId, envelope.documentId, selection);
      } catch (error) {
        return this.stateFailure(error, 'document-changed');
      }

      let visiblePage: string;
      try {
        visiblePage = await this.api.tabs.captureVisibleTab(initial.windowId, { format: 'png' });
      } catch {
        return failure('capture-failed');
      }

      try {
        if (switched) throw new CaptureStateError('tab-changed');
        await this.activeTab(tabId, initial);
        await this.assertPage(tabId, envelope.documentId, selection);
      } catch (error) {
        return this.stateFailure(error, 'document-changed');
      }

      let dataUrl: string;
      try {
        dataUrl = await this.cropper(visiblePage, selection.rect, selection.viewport);
      } catch (error) {
        return failure('crop-failed', error instanceof ImageError ? error.message : failureMessages['crop-failed']);
      }
      if (switched) return failure('tab-changed');
      return {
        ok: true,
        value: {
          dataUrl,
          selection: {
            rect: { ...selection.rect },
            viewport: { ...selection.viewport },
            url: selection.url,
          },
        },
      };
    } finally {
      this.api.tabs.onActivated.removeListener(activated);
      this.api.windows.onFocusChanged.removeListener(focused);
    }
  }

  private stateFailure(error: unknown, fallback: CaptureFailureCode): CaptureReply {
    return failure(error instanceof CaptureStateError ? error.code : fallback);
  }

  private async activeTab(tabId: number, expected?: ActiveTabSnapshot): Promise<ActiveTabSnapshot> {
    let tab: Tabs.Tab;
    let activeTabs: Tabs.Tab[];
    try {
      tab = await this.api.tabs.get(tabId);
      if (tab.windowId === undefined || !(await this.api.windows.get(tab.windowId)).focused) throw new Error('Inactive window');
      activeTabs = await this.api.tabs.query({ active: true, windowId: tab.windowId });
    } catch {
      throw new CaptureStateError(expected ? 'tab-changed' : 'unsupported');
    }
    const active = activeTabs.length === 1 ? activeTabs[0] : undefined;
    if (tab.id !== tabId || !tab.active || !active || active.id !== tabId || active.windowId !== tab.windowId) {
      throw new CaptureStateError(expected ? 'tab-changed' : 'unsupported');
    }
    if (!tab.url || !/^https?:\/\//.test(tab.url) || active.url !== tab.url) {
      throw new CaptureStateError(expected ? 'url-changed' : 'unsupported');
    }
    const snapshot = { id: tabId, windowId: tab.windowId, url: tab.url };
    if (expected) {
      if (snapshot.id !== expected.id || snapshot.windowId !== expected.windowId) throw new CaptureStateError('tab-changed');
      if (snapshot.url !== expected.url) throw new CaptureStateError('url-changed');
    }
    return snapshot;
  }

  private assertSelection(documentId: string, selection: CaptureRegionSelection, tab: ActiveTabSnapshot): void {
    const rect = selection.rect;
    if (!documentId || selection.url !== tab.url) {
      throw new CaptureStateError(selection.url === tab.url ? 'document-changed' : 'url-changed');
    }
    if (!validViewport(selection.viewport)
      || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
      || rect.x + rect.width > selection.viewport.width
      || rect.y + rect.height > selection.viewport.height) {
      throw new CaptureStateError('invalid-selection');
    }
  }

  private async assertPage(
    tabId: number,
    documentId: string,
    selection: CaptureRegionSelection,
  ): Promise<void> {
    let current: CapturePageEnvelope;
    try {
      current = await this.bridge.inspect(tabId, documentId);
    } catch {
      throw new CaptureStateError('document-changed');
    }
    if (current.documentId !== documentId) throw new CaptureStateError('document-changed');
    if (current.page.url !== selection.url) throw new CaptureStateError('url-changed');
    if (!sameViewport(current.page.viewport, selection.viewport)) throw new CaptureStateError('viewport-changed');
  }
}
