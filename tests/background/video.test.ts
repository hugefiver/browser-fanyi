import { describe, expect, it, vi } from 'vitest';
import { fixture, content, ui } from './fixture';
import { fail } from '../../src/shared/contracts';

const start = { type: 'video.command', tabId: 1, action: 'start', videoIndex: 0, trackIndex: 0, mode: 'bilingual' };
describe('readable subtitle grants', () => {
  it('inspection sends zero and only popup consent issues a usable top-level video grant', async () => {
    const f = await fixture();
    expect(await f.controller.handle({ type: 'video.list', tabId: 1 }, ui('popup'))).toMatchObject({ ok: true });
    expect(f.translator).not.toHaveBeenCalled();
    expect(await f.controller.handle(start, content())).toEqual(fail('permission'));
    expect(await f.controller.handle(start, ui('popup'))).toMatchObject({ ok: true });
    const sessionId = f.grant().sessionId;
    expect(await f.controller.handle({ type: 'video.translate', sessionId, sequence: 1, text: 'Cue' }, { ...content(), frameId: 1 })).toEqual(fail('interrupted'));
    expect(await f.controller.handle({ type: 'content.translate', sessionId, text: 'Cue' }, content())).toEqual(fail('interrupted'));
    expect(await f.controller.handle({ type: 'video.translate', sessionId, sequence: 1, text: 'Cue' }, content())).toEqual({ ok: true, value: 'translated' });
  });

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
