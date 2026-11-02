import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureRegion } from '../../src/content/capture-region';

type RegionHandlers = {
  pointerDown(event: PointerEvent): void;
  pointerMove(event: PointerEvent): void;
  pointerUp(event: PointerEvent): void;
};

const regions: CaptureRegion[] = [];

function pointer(
  x: number,
  y: number,
  type: 'down' | 'move' | 'up',
  pointerId = 7,
): PointerEvent {
  return {
    isTrusted: true,
    isPrimary: true,
    button: type === 'move' ? -1 : 0,
    pointerId,
    clientX: x,
    clientY: y,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  } as unknown as PointerEvent;
}

function begin(): { region: CaptureRegion; result: ReturnType<CaptureRegion['start']>; handlers: RegionHandlers } {
  const region = new CaptureRegion(document);
  regions.push(region);
  return {
    region,
    result: region.start(),
    handlers: region as unknown as RegionHandlers,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  history.replaceState({}, '', '/capture-region');
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 800 },
    innerHeight: { configurable: true, value: 600 },
    scrollX: { configurable: true, value: 12 },
    scrollY: { configurable: true, value: 34 },
    devicePixelRatio: { configurable: true, value: 2 },
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const region of regions.splice(0)) region.destroy();
  document.documentElement.querySelectorAll('[data-browser-fanyi="capture-region"]').forEach(node => node.remove());
});

describe('CaptureRegion', () => {
  it('returns viewport CSS coordinates from a trusted pointer drag after removing the overlay', async () => {
    const { result, handlers } = begin();
    expect(document.querySelector('[data-browser-fanyi="capture-region"]')).not.toBeNull();

    handlers.pointerDown(pointer(120.5, 90.25, 'down'));
    handlers.pointerMove(pointer(420.75, 310.5, 'move'));
    handlers.pointerUp(pointer(420.75, 310.5, 'up'));

    expect(await result).toEqual({
      ok: true,
      value: {
        rect: { x: 120.5, y: 90.25, width: 300.25, height: 220.25 },
        viewport: { width: 800, height: 600, scrollX: 12, scrollY: 34, dpr: 2 },
        url: window.location.href,
      },
    });
    expect(document.querySelector('[data-browser-fanyi="capture-region"]')).toBeNull();
  });

  it('ignores synthetic page pointer events', async () => {
    const { region, result } = begin();
    const overlay = document.querySelector('[data-browser-fanyi="capture-region"]')!;
    overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    overlay.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    region.cancel();
    expect(await result).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('rejects an empty drag and leaves no overlay behind', async () => {
    const { result, handlers } = begin();
    handlers.pointerDown(pointer(200, 150, 'down'));
    handlers.pointerUp(pointer(200, 150, 'up'));

    expect(await result).toEqual({ ok: false, reason: 'empty-area' });
    expect(document.querySelector('[data-browser-fanyi="capture-region"]')).toBeNull();
  });

  it('cancels with Escape and removes the overlay immediately', async () => {
    const { result } = begin();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(await result).toEqual({ ok: false, reason: 'escape' });
    expect(document.querySelector('[data-browser-fanyi="capture-region"]')).toBeNull();
  });

  it.each([
    ['scroll', () => document.dispatchEvent(new Event('scroll'))],
    ['resize', () => window.dispatchEvent(new Event('resize'))],
  ])('cancels when the viewport receives a %s change', async (_name, change) => {
    const { result } = begin();
    change();

    expect(await result).toEqual({ ok: false, reason: 'viewport-changed' });
    expect(document.querySelector('[data-browser-fanyi="capture-region"]')).toBeNull();
  });

  it('polls same-document URL changes that do not emit navigation events', async () => {
    vi.useFakeTimers();
    const { result } = begin();
    history.pushState({}, '', '/capture-region/changed');
    await vi.advanceTimersByTimeAsync(50);

    expect(await result).toEqual({ ok: false, reason: 'url-changed' });
    expect(document.querySelector('[data-browser-fanyi="capture-region"]')).toBeNull();
  });
});
