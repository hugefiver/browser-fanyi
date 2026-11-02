import { describe, expect, it, vi } from 'vitest';
import { fixture, content, pageUrl, ui } from './fixture';
import { defaultPreferences, fail } from '../../src/shared/contracts';

const start = { type: 'video.command', tabId: 1, action: 'start', choiceId: 'choice-1', mode: 'bilingual' } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
describe('readable subtitle grants', () => {
  it('inspection sends zero and only popup consent issues a usable top-level video grant', async () => {
    const f = await fixture();
    expect(await f.controller.handle({ type: 'video.list', tabId: 1 }, ui('popup'))).toMatchObject({ ok: true });
    expect(f.translator).not.toHaveBeenCalled();
    expect(await f.controller.handle(start, content())).toEqual(fail('permission'));
    expect(await f.controller.handle(start, ui('popup'))).toMatchObject({ ok: true });
    expect(f.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'video.control', action: 'start', choiceId: 'choice-1',
    }), { frameId: 0 });
    const sessionId = f.grant().sessionId;
    expect(await f.controller.handle({ type: 'video.translate', sessionId, sequence: 1, text: 'Cue' }, { ...content(), frameId: 1 })).toEqual(fail('interrupted'));
    expect(await f.controller.handle({ type: 'content.translate', sessionId, text: 'Cue' }, content())).toEqual(fail('interrupted'));
    expect(await f.controller.handle({ type: 'video.translate', sessionId, sequence: 1, text: 'Cue' }, content())).toEqual({ ok: true, value: 'translated' });
  });

  it.each([
    ['settings', 'first'], ['navigation', 'first'],
    ['settings', 'final'], ['navigation', 'final'],
  ] as const)(
    'does not issue a grant or translate when %s invalidates the %s tab check',
    async (boundary, check) => {
      const f = await fixture();
      await f.controller.handle(start, ui('popup'));
      const sessionId = f.grant().sessionId;
      f.api.tabs.get.mockClear();
      f.api.permissions.contains.mockClear();
      f.sendMessage.mockClear();
      const tabRead = deferred<{ id: number; url: string }>();
      const tabReadStarted = deferred<void>();
      if (check === 'final') f.api.tabs.get.mockResolvedValueOnce({ id: 1, url: pageUrl });
      f.api.tabs.get.mockImplementationOnce(async () => {
        tabReadStarted.resolve();
        return tabRead.promise;
      });
      const pending = f.controller.handle(start, ui('popup'));
      await tabReadStarted.promise;
      expect(f.api.tabs.get).toHaveBeenCalledTimes(check === 'final' ? 2 : 1);
      expect(f.api.permissions.contains).toHaveBeenCalledTimes(check === 'final' ? 1 : 0);
      if (boundary === 'settings') {
        await f.controller.handle({ type: 'settings.save', settings: {
          ...defaultPreferences,
          prefix: 'https://receiver.example/v1',
          model: 'changed',
          key: { kind: 'keep' },
        } }, ui('options'));
      } else {
        const navigate = f.onHistoryStateUpdated.mock.calls[0][0] as (details: {
          tabId: number;
          frameId: number;
          url: string;
        }) => void;
        navigate({ tabId: 1, frameId: 0, url: `${pageUrl}#next` });
      }
      tabRead.resolve({ id: 1, url: 'https://page.example/article' });
      expect(await pending).toEqual(fail('interrupted'));
      expect(f.sendMessage.mock.calls.filter(([, command]) => command.type === 'video.control'
        && command.action === 'start')).toEqual([]);
      expect(await f.controller.handle({ type: 'video.translate', sessionId, sequence: 1, text: 'Late cue' }, content()))
        .toEqual(fail('interrupted'));
      expect(f.translator).not.toHaveBeenCalled();
    },
  );

  it('seek cancels outstanding provider work and suppresses a late result', async () => {
    const f = await fixture();
    let finish!: (reply: { ok: true; value: string }) => void;
    f.translator.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.controller.handle(start, ui('popup'));
    const sessionId = f.grant().sessionId;
    const pending = f.controller.handle({ type: 'video.translate', sessionId, sequence: 1, text: 'Old cue' }, content());
    await vi.waitFor(() => expect(f.translator).toHaveBeenCalledOnce());
    await f.controller.handle({ type: 'video.cancel', sessionId, sequence: 2 }, content());
    expect(f.translator.mock.calls[0][2].aborted).toBe(true);
    finish({ ok: true, value: 'late' });
    expect(await pending).toEqual(fail('interrupted'));
    await f.controller.handle({ type: 'video.end', sessionId }, content());
    expect(await f.controller.handle({ type: 'video.translate', sessionId, sequence: 3, text: 'New cue' }, content())).toEqual(fail('interrupted'));
  });

  it('requires explicit next-round consent after the bounded request budget', async () => {
    const f = await fixture();
    await f.controller.handle(start, ui('popup'));
    const sessionId = f.grant().sessionId;
    for (let sequence = 1; sequence <= 100; sequence++) await f.controller.handle({ type: 'video.translate', sessionId, sequence, text: 'Cue' }, content());
    expect(await f.controller.handle({ type: 'video.translate', sessionId, sequence: 101, text: 'Cue' }, content())).toEqual(fail('limit'));
    await f.controller.handle({ type: 'video.command', tabId: 1, action: 'continue' }, ui('popup'));
    expect(await f.controller.handle({ type: 'video.translate', sessionId, sequence: 102, text: 'Cue' }, content())).toMatchObject({ ok: true });
    f.permissionsRemoved.mock.calls[0][0]({ origins: ['https://receiver.example/*'] });
    expect(await f.controller.handle({ type: 'video.translate', sessionId, sequence: 103, text: 'Cue' }, content())).toEqual(fail('interrupted'));
  });
});
