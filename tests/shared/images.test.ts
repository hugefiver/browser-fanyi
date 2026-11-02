import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_MAX_BYTES,
  displaySelectionToCrop,
  exportImageCrop,
  loadImageBlob,
  loadImageDataUrl,
  validateImageCrop,
  type LoadedImage,
} from '../../src/shared/images';

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);
const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const pngDataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...pngBytes))}`;
let dimensions = { width: 1200, height: 800 };
let decodeFailure = false;
const createObjectURL = vi.fn(() => 'blob:decoded-image');
const revokeObjectURL = vi.fn();

class TestImage {
  decoding = '';
  src = '';
  get naturalWidth() { return dimensions.width; }
  get naturalHeight() { return dimensions.height; }
  async decode() {
    if (decodeFailure) throw new Error('decode failed');
  }
}

function blobWithBytes(bytes: Uint8Array, type = ''): Blob {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  return blob;
}

beforeEach(() => {
  dimensions = { width: 1200, height: 800 };
  decodeFailure = false;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('Image', TestImage);
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local image decoding boundary', () => {
  it.each<[string, Uint8Array, 'image/png' | 'image/jpeg' | 'image/webp']>([
    ['PNG', pngBytes, 'image/png'],
    ['JPEG', jpegBytes, 'image/jpeg'],
    ['WebP', webpBytes, 'image/webp'],
  ])('accepts real %s signatures and retains the object URL until disposal', async (_label, bytes, type) => {
    const loaded = await loadImageBlob(blobWithBytes(bytes));
    expect(loaded).toMatchObject({ type, width: 1200, height: 800, encodedBytes: bytes.length });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    loaded.dispose();
    loaded.dispose();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('rejects SVG, HTML and a mismatched data URL before they can become previews', async () => {
    const encoder = new TextEncoder();
    await expect(loadImageBlob(blobWithBytes(encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')))
      .rejects.toMatchObject({ code: 'unsupported-type' });
    await expect(loadImageBlob(blobWithBytes(encoder.encode('<html><img src=x></html>'), 'image/webp')))
      .rejects.toMatchObject({ code: 'unsupported-type' });
    const mismatched = `data:image/jpeg;base64,${pngDataUrl.split(',')[1]}`;
    await expect(loadImageDataUrl(mismatched)).rejects.toMatchObject({ code: 'unsupported-type' });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('enforces encoded bytes before decode and real decoded pixel dimensions afterward', async () => {
    const oversized = new Blob([new Uint8Array(IMAGE_MAX_BYTES + 1)]);
    await expect(loadImageBlob(oversized)).rejects.toMatchObject({ code: 'file-too-large' });
    dimensions = { width: 4001, height: 4000 };
    await expect(loadImageBlob(blobWithBytes(pngBytes))).rejects.toMatchObject({ code: 'pixel-limit' });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:decoded-image');
  });

  it('reports a real browser decode failure and revokes only the failed URL', async () => {
    decodeFailure = true;
    await expect(loadImageBlob(blobWithBytes(pngBytes))).rejects.toMatchObject({ code: 'decode-failed' });
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
});

describe('crop coordinates and safe PNG export', () => {
  it('scales a displayed drag selection into an integer source-pixel region', () => {
    expect(displaySelectionToCrop(
      { x: 120, y: 60 },
      { x: 180, y: 90 },
      { left: 100, top: 50, width: 200, height: 100 },
      { width: 1000, height: 500 },
    )).toEqual({ x: 100, y: 50, width: 300, height: 150 });
    expect(displaySelectionToCrop(
      { x: 350, y: 170 },
      { x: 50, y: 20 },
      { left: 100, top: 50, width: 200, height: 100 },
      { width: 1000, height: 500 },
    )).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
  });

  it('rejects invalid manual regions instead of silently clamping them', () => {
    expect(() => validateImageCrop(
      { x: 900, y: 10, width: 101, height: 20 },
      { width: 1000, height: 500 },
    )).toThrowError(expect.objectContaining({ code: 'invalid-crop' }));
    expect(() => validateImageCrop(
      { x: 0.5, y: 0, width: 10, height: 10 },
      { width: 1000, height: 500 },
    )).toThrowError(expect.objectContaining({ code: 'invalid-crop' }));
  });

  it('draws exactly the selected source pixels and exports a PNG data URL', () => {
    const drawImage = vi.fn();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(pngDataUrl);
    const element = document.createElement('img');
    const loaded: LoadedImage = {
      type: 'image/png', encodedBytes: pngBytes.length, previewUrl: 'blob:source', element,
      width: 1000, height: 500, dispose: vi.fn(),
    };
    const prepared = exportImageCrop(loaded, { x: 100, y: 50, width: 300, height: 150 });
    expect(prepared).toEqual({ dataUrl: pngDataUrl, encodedBytes: pngBytes.length, width: 300, height: 150 });
    expect(drawImage).toHaveBeenCalledWith(element, 100, 50, 300, 150, 0, 0, 300, 150);
    const canvas = getContext.mock.contexts[0] as HTMLCanvasElement;
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
  });
});
