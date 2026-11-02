// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Reply } from '../../src/shared/contracts';
import { deferred, fixture, grant, success } from './helpers';

describe('content session lifecycle', () => {
  it('invalidates late results on pause and observes new source without sending', async () => {
    const late = deferred<Reply<string>>();
    const { engine, send, cancel, start } = fixture('<p>Old</p>', () => late.promise);
    await start();
    expect(send).toHaveBeenCalledOnce();
    await engine.handle({ type: 'content.command', action: 'pause' });
    expect(cancel).toHaveBeenCalledWith('session');
    document.querySelector('p')!.firstChild!.textContent = 'New';
    late.resolve(success('Stale translation'));
    await Promise.resolve();
    await vi.waitFor(() => expect(engine.status()).toMatchObject({ phase: 'paused', total: 1, completed: 0, pending: 1 }));
    expect(document.querySelector('[data-browser-fanyi]')).toBeNull();
    expect(engine.status()).toMatchObject({ phase: 'paused', completed: 0, pending: 1 });
    expect(send).toHaveBeenCalledOnce();
    send.mockImplementation(async text => success(`current:${text}`));
    await engine.handle({ type: 'content.command', action: 'resume', grant: grant('resumed') });
    await vi.waitFor(() => expect(engine.status().completed).toBe(1));
    expect(send.mock.calls.map(call => call[0])).toEqual(['Old', 'New']);
    expect(document.querySelector('p')!.textContent).toBe('Newcurrent:New');
  });

  it('honors pause after the background cancellation reply and resumes only unfinished pieces', async () => {
    const cancelled = deferred<Reply<string>>();
    const { engine, send, start } = fixture('<p>Done</p><p>Pending</p>', text => text === 'Done' ? Promise.resolve(success('Cached')) : cancelled.promise);
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(1));
    const cachedSpan = document.querySelector('[data-browser-fanyi]');
    cancelled.resolve({ ok: false, error: { code: 'interrupted', message: 'Background cancelled the request' } });
    await vi.waitFor(() => expect(engine.status().phase).toBe('interrupted'));
    const paused = await engine.handle({ type: 'content.command', action: 'pause' });
    expect(paused).toMatchObject({ ok: true, value: { phase: 'paused', total: 2, completed: 1, pending: 1 } });
    expect(engine.status().error).toBeUndefined();
    expect(document.querySelector('[data-browser-fanyi]')).toBe(cachedSpan);
    expect(await engine.handle({ type: 'content.command', action: 'resume' })).toMatchObject({ ok: false, error: { code: 'interrupted' } });
    expect(send).toHaveBeenCalledTimes(2);
    send.mockImplementation(async text => success(`Resumed:${text}`));
    await engine.handle({ type: 'content.command', action: 'resume', grant: grant('after-cancel') });
    await vi.waitFor(() => expect(engine.status().phase).toBe('complete'));
    expect(send.mock.calls.map(call => call[0])).toEqual(['Done', 'Pending', 'Pending']);
    expect(document.querySelector('[data-browser-fanyi]')).toBe(cachedSpan);
    expect(document.querySelectorAll('p')[1]!.textContent).toBe('PendingResumed:Pending');
  });

  it('keeps two requests concurrent and resumes a 100-request budget with a new grant', async () => {
    let concurrent = 0;
    let maximum = 0;
    const { engine, send, start } = fixture(Array.from({ length: 101 }, (_, index) => `<p>text ${index}</p>`).join(''), async text => {
      maximum = Math.max(maximum, ++concurrent);
      await Promise.resolve();
      --concurrent;
      return success(`T:${text}`);
    });
    await start();
    await vi.waitFor(() => expect(engine.status().phase).toBe('limit'));
    expect(engine.status()).toMatchObject({ total: 101, completed: 100, pending: 1, failed: 0, error: { code: 'limit' } });
    expect(send).toHaveBeenCalledTimes(100);
    expect(maximum).toBe(2);
    await engine.handle({ type: 'content.command', action: 'resume', grant: grant('more') });
    await vi.waitFor(() => expect(engine.status().phase).toBe('complete'));
    expect(send).toHaveBeenCalledTimes(101);
  });

  it('exposes a local timeout rather than waiting forever', async () => {
    vi.useFakeTimers();
    const { engine, start } = fixture('<p>Never returns</p>', () => new Promise(() => undefined));
    await start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engine.status()).toMatchObject({ phase: 'partial', pending: 0, failed: 1, error: { code: 'timeout' } });
  });

  it('requires a new start after a background interruption', async () => {
    const { engine, send, start } = fixture('<p>Source</p>', async () => ({ ok: false, error: { code: 'interrupted', message: 'Restarted' } }));
    await start();
    await vi.waitFor(() => expect(engine.status().phase).toBe('interrupted'));
    expect(await engine.handle({ type: 'content.command', action: 'resume', grant: grant('resume') })).toMatchObject({ ok: false, error: { code: 'interrupted' } });
    expect(send).toHaveBeenCalledOnce();
    send.mockImplementation(async () => success('Fresh'));
    await engine.handle({ type: 'content.command', action: 'start', grant: grant('new') });
    await vi.waitFor(() => expect(engine.status().completed).toBe(1));
    expect(document.querySelector('p')!.textContent).toBe('SourceFresh');
  });

  it('restores owned display on invalidate and ignores in-flight responses', async () => {
    const late = deferred<Reply<string>>();
    const { engine, start } = fixture('<p>Done</p><p>Pending</p>', text => text === 'Done' ? Promise.resolve(success('Translated')) : late.promise);
    await start();
    await vi.waitFor(() => expect(engine.status().completed).toBe(1));
    await engine.handle({ type: 'content.command', action: 'mode', mode: 'translation' });
    document.querySelector('p')!.firstChild!.textContent = 'Website owns this';
    await engine.handle({ type: 'content.invalidate', error: { code: 'permission', message: 'Permission removed' } });
    late.resolve(success('Late'));
    await Promise.resolve();
    expect(document.querySelector('p')!.textContent).toBe('Website owns this');
    expect(document.querySelectorAll('p')[1]!.textContent).toBe('Pending');
    expect(engine.status()).toMatchObject({ phase: 'interrupted', error: { code: 'permission' } });
    await engine.handle({ type: 'content.command', action: 'pause' });
    expect(engine.status().phase).toBe('interrupted');
    expect(await engine.handle({ type: 'content.command', action: 'resume', grant: grant('invalidated') })).toMatchObject({ ok: false, error: { code: 'interrupted' } });
    expect(await engine.handle({ type: 'content.command', action: 'retry', grant: grant('invalidated-retry') })).toMatchObject({ ok: false, error: { code: 'interrupted' } });
  });

  it('checks SPA URL before a command and never resumes old work automatically', async () => {
    const late = deferred<Reply<string>>();
    const { engine, start } = fixture('<p>Old route</p>', () => late.promise);
    await start();
    const previous = window.location.href;
    window.history.replaceState(null, '', '#next-content-route');
    const reply = await engine.handle({ type: 'content.status' });
    expect(reply).toMatchObject({ ok: true, value: { phase: 'interrupted', total: 0 } });
    late.resolve(success('Late'));
    await Promise.resolve();
    expect(document.querySelector('p')!.textContent).toBe('Old route');
    await engine.handle({ type: 'content.command', action: 'pause' });
    expect(engine.status().phase).toBe('interrupted');
    expect(await engine.handle({ type: 'content.command', action: 'resume', grant: grant('new-route') })).toMatchObject({ ok: false, error: { code: 'interrupted' } });
    expect(await engine.handle({ type: 'content.command', action: 'retry', grant: grant('new-route-retry') })).toMatchObject({ ok: false, error: { code: 'interrupted' } });
    window.history.replaceState(null, '', previous);
  });

  it('returns only explicit selection text and rejects oversize selections', async () => {
    const { engine, send } = fixture('<p>Selected</p><p>Not selected</p>');
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(await engine.handle({ type: 'content.selection' })).toEqual(success('Selected'));
    expect(send).not.toHaveBeenCalled();
    document.querySelector('p')!.textContent = '😀'.repeat(2001);
    range.selectNodeContents(document.querySelector('p')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(await engine.handle({ type: 'content.selection' })).toMatchObject({ ok: false, error: { code: 'limit' } });
    window.getSelection()!.removeAllRanges();
    expect(await engine.handle({ type: 'content.selection' })).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });
});
