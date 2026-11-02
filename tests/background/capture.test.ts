import { describe, expect, it, vi } from 'vitest';
import type browser from '../../src/shared/browser';
import {
  Capture,
  crop,
  scaleCaptureRect,
  type CaptureContentBridge,
  type CapturePageEnvelope,
  type CaptureSelectionEnvelope,
} from '../../src/background/capture';
import type { CaptureViewport } from '../../src/content/capture-region';

const pageUrl = 'https://page.example/article';
const wholePage = 'data:image/png;base64,d2hvbGU=';
const cropped = 'data:image/png;base64,iVBORw0KGgo=';
const viewport: CaptureViewport = {
  width: 800,
  height: 600,
  scrollX: 10,
  scrollY: 20,
  dpr: 2,
};

const selected: CaptureSelectionEnvelope = {
  documentId: 'document-a',
  result: {
    ok: true,
    value: {
      rect: { x: 100, y: 50, width: 200, height: 100 },
      viewport,
      url: pageUrl,
    },
  },
};

function page(overrides: Partial<CapturePageEnvelope> = {}): CapturePageEnvelope {
  return {
    documentId: 'document-a',
    page: { viewport: { ...viewport }, url: pageUrl },
    ...overrides,
  };
}

function fixture() {
  let activeId = 7;
  let activated: ((info: { tabId: number; windowId: number }) => void) | undefined;
  const get = vi.fn(async () => ({
    id: 7,
    windowId: 3,
    url: pageUrl,
    active: activeId === 7,
  }));
  const query = vi.fn(async () => [{
    id: activeId,
    windowId: 3,
    url: activeId === 7 ? pageUrl : 'https://other.example/',
    active: true,
  }]);
  const captureVisibleTab = vi.fn(async () => wholePage);
  const api = {
    windows: { get: vi.fn(async () => ({ focused: true })), onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    tabs: {
      get,
      query,
      captureVisibleTab,
      onActivated: {
        addListener: vi.fn((listener: typeof activated) => { activated = listener; }),
        removeListener: vi.fn((listener: typeof activated) => {
          if (activated === listener) activated = undefined;
        }),
      },
    },
  };
  const bridge: CaptureContentBridge = {
    select: vi.fn(async () => selected),
    inspect: vi.fn(async () => page()),
    cancel: vi.fn(),
  };
  const cropper = vi.fn(async () => cropped);
  const capture = new Capture(api as unknown as typeof browser, bridge, cropper);
  return {
    api,
    bridge,
    cropper,
    capture,
    emitActivated(info: { tabId: number; windowId: number }) { activated?.(info); },
    setActive(id: number) { activeId = id; },
  };
}

describe('capture crop coordinates', () => {
  it('scales the CSS selection against actual screenshot pixels and rounds outward', async () => {
    const draw = vi.fn(async () => cropped);
    const dispose = vi.fn();
    const decoder = vi.fn(async () => ({ width: 1600, height: 1200, crop: draw, dispose }));

    expect(scaleCaptureRect(
      { x: 100.25, y: 50.5, width: 200.25, height: 100.25 },
      viewport,
      { width: 1600, height: 1200 },
    )).toEqual({ x: 200, y: 101, width: 401, height: 201 });
    if (!selected.result.ok) throw new Error('Expected successful selection');
    expect(await crop(wholePage, selected.result.value.rect, viewport, decoder)).toBe(cropped);
    expect(draw).toHaveBeenCalledWith({ x: 200, y: 100, width: 400, height: 200 });
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe('Capture tab and page binding', () => {
  it('captures once, revalidates the same page on both sides, and returns only the cropped PNG', async () => {
    const ctx = fixture();

    if (!selected.result.ok) throw new Error('Expected successful selection');
    expect(await ctx.capture.capture(7)).toEqual({
      ok: true,
      value: { dataUrl: cropped, selection: selected.result.value },
    });
    expect(ctx.api.tabs.captureVisibleTab).toHaveBeenCalledWith(3, { format: 'png' });
    expect(ctx.bridge.inspect).toHaveBeenNthCalledWith(1, 7, 'document-a');
    expect(ctx.bridge.inspect).toHaveBeenNthCalledWith(2, 7, 'document-a');
    expect(ctx.cropper).toHaveBeenCalledWith(
      wholePage,
      { x: 100, y: 50, width: 200, height: 100 },
      viewport,
    );
    expect(ctx.api.tabs.onActivated.removeListener).toHaveBeenCalledOnce();
  });

  it('cancels selection when another tab activates in the target window', async () => {
    const ctx = fixture();
    let resolveSelection!: (value: CaptureSelectionEnvelope) => void;
    vi.mocked(ctx.bridge.select).mockReturnValueOnce(new Promise(resolve => { resolveSelection = resolve; }));
    vi.mocked(ctx.bridge.cancel).mockImplementationOnce(() => {
      resolveSelection({ documentId: 'document-a', result: { ok: false, reason: 'cancelled' } });
    });

    const pending = ctx.capture.capture(7);
    await vi.waitFor(() => expect(ctx.bridge.select).toHaveBeenCalledOnce());
    ctx.setActive(8);
    ctx.emitActivated({ tabId: 8, windowId: 3 });

    expect(await pending).toMatchObject({ ok: false, error: { code: 'tab-changed' } });
    expect(ctx.bridge.cancel).toHaveBeenCalledWith(7);
    expect(ctx.api.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'viewport',
      changed: page({ page: { url: pageUrl, viewport: { ...viewport, scrollY: 21 } } }),
      code: 'viewport-changed',
    },
    {
      name: 'document',
      changed: page({ documentId: 'document-b' }),
      code: 'document-changed',
    },
  ])('discards the whole screenshot when the $name changes after capture', async ({ changed, code }) => {
    const ctx = fixture();
    vi.mocked(ctx.bridge.inspect).mockResolvedValueOnce(page()).mockResolvedValueOnce(changed);

    expect(await ctx.capture.capture(7)).toMatchObject({ ok: false, error: { code } });
    expect(ctx.api.tabs.captureVisibleTab).toHaveBeenCalledOnce();
    expect(ctx.cropper).not.toHaveBeenCalled();
  });

  it('reports browser capture failure without retrying or cropping', async () => {
    const ctx = fixture();
    ctx.api.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('capture denied'));

    expect(await ctx.capture.capture(7)).toMatchObject({
      ok: false,
      error: { code: 'capture-failed' },
    });
    expect(ctx.api.tabs.captureVisibleTab).toHaveBeenCalledOnce();
    expect(ctx.cropper).not.toHaveBeenCalled();
  });
});
