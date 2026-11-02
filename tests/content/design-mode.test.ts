// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Reply } from '../../src/shared/contracts';
import { deferred, fixture, success } from './helpers';

describe('content document editing exclusion', () => {
  it('does not collect a document already in designMode', async () => {
    const { engine, send, start } = fixture('<p>Editable document draft</p>');
    document.designMode = 'on';
    await start();
    expect(send).not.toHaveBeenCalled();
    expect(engine.status()).toMatchObject({ phase: 'empty', total: 0 });
    expect(document.querySelector('p')!.textContent).toBe('Editable document draft');
  });

  it('rechecks eligibility before every send even without a mutation record', async () => {
    const { engine, send, start } = fixture('<p>First</p><p>Private draft</p>', async () => {
      document.designMode = 'on';
      return success('Do not display');
    });
    await start();
    await vi.waitFor(() => expect(engine.status().pending).toBe(0));
    expect(send.mock.calls).toEqual([['First']]);
    expect(document.querySelector('[data-browser-fanyi]')).toBeNull();
    expect(document.body.textContent).toBe('FirstPrivate draft');
  });

  it('drops queued pieces and never applies in-flight results after designMode is enabled', async () => {
    const inFlight = deferred<Reply<string>>();
    const { engine, send, start } = fixture('<p>First</p><p>Second</p><p>Unsent draft</p>', () => inFlight.promise);
    await start();
    expect(send).toHaveBeenCalledTimes(2);
    document.designMode = 'on';
    inFlight.resolve(success('Do not display'));
    await vi.waitFor(() => expect(engine.status()).toMatchObject({ phase: 'empty', total: 0, pending: 0 }));
    expect(send.mock.calls.map(call => call[0])).toEqual(['First', 'Second']);
    expect(document.querySelector('[data-browser-fanyi]')).toBeNull();
    expect(document.body.textContent).toBe('FirstSecondUnsent draft');
  });
});
