// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Reply } from '../../src/shared/contracts';
import { deferred, fixture, grant, success } from './helpers';

describe('content explicit retry after background cancellation', () => {
  it('uses the new user grant for failed and unfinished pieces while retaining successes', async () => {
    const cancelled = deferred<Reply<string>>();
    const { engine, send, start } = fixture('<p>Done</p><p>Failed</p><p>Pending</p>', async text => {
      if (text === 'Done') return success('Cached');
      if (text === 'Failed') return { ok: false, error: { code: 'network', message: 'Offline' } };
      return cancelled.promise;
    });
    await start();
    await vi.waitFor(() => expect(engine.status()).toMatchObject({ completed: 1, failed: 1, pending: 1 }));
    const cachedSpan = document.querySelector('[data-browser-fanyi]');
    cancelled.resolve({ ok: false, error: { code: 'interrupted', message: 'Background cancellation before retry command' } });
    await vi.waitFor(() => expect(engine.status().phase).toBe('interrupted'));
    expect(await engine.handle({ type: 'content.command', action: 'retry' })).toMatchObject({ ok: false, error: { code: 'interrupted' } });
    expect(send).toHaveBeenCalledTimes(3);
    send.mockImplementation(async text => success(`Retried:${text}`));
    await engine.handle({ type: 'content.command', action: 'retry', grant: grant('explicit-retry') });
    await vi.waitFor(() => expect(engine.status()).toMatchObject({ phase: 'complete', completed: 3, failed: 0, pending: 0 }));
    expect(send.mock.calls.map(call => call[0])).toEqual(['Done', 'Failed', 'Pending', 'Failed', 'Pending']);
    expect(document.querySelector('[data-browser-fanyi]')).toBe(cachedSpan);
    expect(document.body.textContent).toBe('DoneCachedFailedRetried:FailedPendingRetried:Pending');
  });
});
