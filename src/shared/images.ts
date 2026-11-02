export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_000_000;

export type SupportedImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImagePoint {
  x: number;
  y: number;
}

export interface DisplayImageBounds extends ImageDimensions {
  left: number;
  top: number;
}

export interface LoadedImage extends ImageDimensions {
  type: SupportedImageType;
  encodedBytes: number;
  previewUrl: string;
  element: HTMLImageElement;
  dispose(): void;
}

export interface PreparedImage extends ImageDimensions {
  dataUrl: string;
  encodedBytes: number;
}

export type ImageErrorCode =
  | 'unsupported-type'
  | 'file-too-large'
  | 'decode-failed'
  | 'pixel-limit'
  | 'invalid-crop'
  | 'canvas-failed'
  | 'encoded-too-large';

export class ImageError extends Error {
  constructor(readonly code: ImageErrorCode, message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

function detectImageType(bytes: Uint8Array): SupportedImageType | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}

function assertEncodedSize(size: number, output: boolean): void {
  if (size > IMAGE_MAX_BYTES) {
    throw new ImageError(
      output ? 'encoded-too-large' : 'file-too-large',
      output
        ? '实际待发送 PNG 超过 4 MiB，请明确选择更小的裁剪范围。'
        : '图像编码超过 4 MiB，请选择更小的图像。',
    );
  }
}

export function parseDataUrl(dataUrl: string, output: boolean): { type: SupportedImageType; bytes: Uint8Array } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) {
    throw new ImageError('unsupported-type', '仅支持真实编码的 PNG、JPEG 或 WebP 图像；SVG 和 HTML 不受支持。');
  }
  const maximumBase64Length = Math.ceil(IMAGE_MAX_BYTES / 3) * 4;
  if (match[2].length > maximumBase64Length) assertEncodedSize(IMAGE_MAX_BYTES + 1, output);
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw new ImageError('unsupported-type', '图像数据编码无效。');
  }
  assertEncodedSize(binary.length, output);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const detected = detectImageType(bytes);
  if (!detected || detected !== match[1]) {
    throw new ImageError('unsupported-type', '仅支持真实编码的 PNG、JPEG 或 WebP 图像；SVG 和 HTML 不受支持。');
  }
  return { type: detected, bytes };
}

async function loadBytes(bytes: Uint8Array, expectedType?: SupportedImageType): Promise<LoadedImage> {
  if (bytes.length === 0) throw new ImageError('decode-failed', '图像内容为空。');
  assertEncodedSize(bytes.length, false);
  const type = detectImageType(bytes);
  if (!type || (expectedType && type !== expectedType)) {
    throw new ImageError('unsupported-type', '仅支持真实编码的 PNG、JPEG 或 WebP 图像；SVG 和 HTML 不受支持。');
  }

  const previewUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  const image = new Image();
  image.decoding = 'async';
  image.src = previewUrl;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(previewUrl);
    throw new ImageError('decode-failed', '浏览器无法解码此图像，请确认文件未损坏。');
  }

  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const pixels = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    URL.revokeObjectURL(previewUrl);
    throw new ImageError('decode-failed', '浏览器未能读取有效的图像尺寸。');
  }
  if (!Number.isSafeInteger(pixels) || pixels > IMAGE_MAX_PIXELS) {
    URL.revokeObjectURL(previewUrl);
    throw new ImageError('pixel-limit', '图像超过 1600 万像素，请先明确缩小后再选择。');
  }

  let disposed = false;
  return {
    type,
    encodedBytes: bytes.length,
    previewUrl,
    element: image,
    width,
    height,
    dispose() {
      if (disposed) return;
      disposed = true;
      URL.revokeObjectURL(previewUrl);
    },
  };
}

export async function loadImageBlob(blob: Blob): Promise<LoadedImage> {
  assertEncodedSize(blob.size, false);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return loadBytes(bytes);
}

export async function loadImageDataUrl(dataUrl: string): Promise<LoadedImage> {
  const parsed = parseDataUrl(dataUrl, false);
  return loadBytes(parsed.bytes, parsed.type);
}

export function validateImageCrop(crop: ImageCrop, image: ImageDimensions): ImageCrop {
  const values = [crop.x, crop.y, crop.width, crop.height, image.width, image.height];
  if (!values.every(Number.isInteger)
    || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1
    || image.width < 1 || image.height < 1
    || crop.x + crop.width > image.width || crop.y + crop.height > image.height) {
    throw new ImageError('invalid-crop', '裁剪坐标必须是原图范围内的整数像素区域。');
  }
  return { ...crop };
}

export function displaySelectionToCrop(
  start: ImagePoint,
  end: ImagePoint,
  bounds: DisplayImageBounds,
  image: ImageDimensions,
): ImageCrop {
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new ImageError('invalid-crop', '当前预览尺寸无效，无法换算裁剪区域。');
  }
  const left = Math.max(0, Math.min(bounds.width, Math.min(start.x, end.x) - bounds.left));
  const right = Math.max(0, Math.min(bounds.width, Math.max(start.x, end.x) - bounds.left));
  const top = Math.max(0, Math.min(bounds.height, Math.min(start.y, end.y) - bounds.top));
  const bottom = Math.max(0, Math.min(bounds.height, Math.max(start.y, end.y) - bounds.top));
  const x = Math.floor(left * image.width / bounds.width);
  const y = Math.floor(top * image.height / bounds.height);
  return validateImageCrop({
    x,
    y,
    width: Math.ceil(right * image.width / bounds.width) - x,
    height: Math.ceil(bottom * image.height / bounds.height) - y,
  }, image);
}

export function exportImageCrop(image: LoadedImage, crop?: ImageCrop): PreparedImage {
  const area = validateImageCrop(crop ?? { x: 0, y: 0, width: image.width, height: image.height }, image);
  const canvas = document.createElement('canvas');
  canvas.width = area.width;
  canvas.height = area.height;
  const context = canvas.getContext('2d');
  if (!context) throw new ImageError('canvas-failed', '浏览器无法创建本地图像处理画布。');
  try {
    context.drawImage(image.element, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
    const dataUrl = canvas.toDataURL('image/png');
    const parsed = parseDataUrl(dataUrl, true);
    if (parsed.type !== 'image/png') throw new Error('Canvas did not export PNG');
    return { dataUrl, encodedBytes: parsed.bytes.length, width: area.width, height: area.height };
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError('canvas-failed', '浏览器无法从真实图像像素导出安全 PNG。');
  }
}

export function imageErrorMessage(error: unknown): string {
  return error instanceof ImageError ? error.message : '读取或处理图像失败，请重新选择。';
}
