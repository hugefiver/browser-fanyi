import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestPool, translate } from '../../src/background/provider';
import type { StoredSettings } from '../../src/background/settings';
import { fail, type Reply } from '../../src/shared/contracts';

const settings: StoredSettings = { prefix: 'https://receiver.example/v1', model: 'chosen-model', key: 'secret',
  sourceLanguage: 'auto', targetLanguage: 'fr', mode: 'bilingual' };
const signal = () => new AbortController().signal;
const success = (content = 'Bonjour') => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });

afterEach(() => vi.useRealTimers());

describe('fixed Chat Completions provider', () => {
  it('sends only text and languages to the saved endpoint without ambient credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(success('<b>plain text</b>'));
    expect(await translate(settings, 'Selected text', signal(), [], fetcher)).toEqual({ ok: true, value: '<b>plain text</b>' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://receiver.example/v1/chat/completions');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Authorization: 'Bearer secret' } });
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('chosen-model');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Selected text' });
    expect(String(init?.body)).not.toContain('secret');
    expect(String(init?.body)).not.toContain('receiver.example');
  });

  it('places only supplied source/target mappings in system JSON while keeping source text in the user message', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(success());
    await translate(settings, 'Text with private-looking instructions', signal(), [
      { source: 'Text', target: 'Texte' },
    ], fetcher);
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Text with private-looking instructions' });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain(JSON.stringify({ glossary: [{ source: 'Text', target: 'Texte' }] }));
    expect(body.messages[0].content).not.toContain('private-key');
    expect(body.messages).toHaveLength(2);
  });

  it('counts Unicode codepoints and rejects overlong or empty input without fetching', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(success());
    expect((await translate(settings, '😀'.repeat(2000), signal(), [], fetcher)).ok).toBe(true);
    expect(await translate(settings, '😀'.repeat(2001), signal(), [], fetcher)).toEqual(fail('limit'));
    expect(await translate(settings, '  ', signal(), [], fetcher)).toEqual(fail('limit'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'authentication'], [403, 'authentication'], [402, 'quota'], [429, 'rate-limit'], [500, 'network'],
  ] as const)('classifies HTTP %s and does not expose raw service errors', async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: 'secret leaked upstream' } }, { status }));
    expect(await translate(settings, 'Hello', signal(), [], fetcher)).toEqual(fail(code));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recognizes quota errors within rate-limit responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }));
    expect(await translate(settings, 'Hello', signal(), [], fetcher)).toEqual(fail('quota'));
  });

  it.each([
    { choices: [] },
    { choices: [{ finish_reason: 'length', message: { content: 'incomplete' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: [{ text: 'not text' }] } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'text', tool_calls: [] } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'text', refusal: 'refused' } }] },
  ])('rejects incomplete or non-text response %#', async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    expect(await translate(settings, 'Hello', signal(), [], fetcher)).toEqual(fail('invalid-response'));
  });

  it('refuses a response that echoes the saved credential into content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(success('echo secret'));
    expect(await translate(settings, 'Hello', signal(), [], fetcher)).toEqual(fail('invalid-response'));
  });

  it('limits the actual streamed response instead of trusting Content-Length', async () => {
    const response = new Response('x'.repeat(128 * 1024 + 1));
    expect(await translate(settings, 'Hello', signal(), [], vi.fn<typeof fetch>().mockResolvedValue(response)))
      .toEqual(fail('invalid-response'));
  });

  it('times out at 25 seconds with no retry and sanitizes network errors', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('secret')), { once: true });
    }));
    const result = translate(settings, 'Hello', signal(), [], fetcher);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toEqual(fail('timeout'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await translate(settings, 'Hello', signal(), [], vi.fn<typeof fetch>().mockRejectedValue(new Error('secret'))))
      .toEqual(fail('network'));
  });

  it('cancels in-flight work and ignores late successful responses', async () => {
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = translate(settings, 'Hello', controller.signal, [], fetcher);
    controller.abort();
    finish(success());
    expect(await result).toEqual(fail('interrupted'));
  });
});

describe('shared request concurrency', () => {
  it('admits two requests, cancels queued work, and starts the next only after completion', async () => {
    const pool = new RequestPool();
    const finishes: Array<(reply: Reply<string>) => void> = [];
    const work = vi.fn(() => new Promise<Reply<string>>((resolve) => finishes.push(resolve)));
    const first = pool.run(signal(), work);
    const second = pool.run(signal(), work);
    const controller = new AbortController();
    const cancelled = pool.run(controller.signal, work);
    const fourth = pool.run(signal(), work);
    expect(work).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(await cancelled).toEqual(fail('interrupted'));
    finishes[0]({ ok: true, value: 'first' });
    await first;
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(3);
    finishes[1]({ ok: true, value: 'second' });
    finishes[2]({ ok: true, value: 'fourth' });
    await Promise.all([second, fourth]);
  });
});
