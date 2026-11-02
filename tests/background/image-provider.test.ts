import { describe, expect, it, vi } from 'vitest';
import { recognizeImage } from '../../src/background/provider';
import { defaultPreferences } from '../../src/shared/contracts';

const settings = { ...defaultPreferences, prefix: 'https://service.example/v1', model: 'chosen', key: 'secret' };
const image = 'data:image/png;base64,iVBORw0KGgo=';
const response = (content: string) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));

describe('image provider public protocol', () => {
  it('sends only the image to the chosen endpoint with shared network safeguards', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('{"source":"Hello","translation":"你好"}'));
    expect(await recognizeImage(settings, image, new AbortController().signal, fetcher)).toEqual({ ok: true, value: '{"source":"Hello","translation":"你好"}' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://service.example/v1/chat/completions');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('chosen');
    expect(body.messages[1].content).toEqual([{ type: 'image_url', image_url: { url: image } }]);
    expect(body.messages[0].content).not.toContain('glossary');
  });

  it.each(['plain output', '{"source":"","translation":""}', '{"source":"A","translation":4}', '{"source":"A","translation":"B","extra":true}'])('rejects invalid or empty structured recognition: %s', async output => {
    expect(await recognizeImage(settings, image, new AbortController().signal, vi.fn<typeof fetch>().mockResolvedValue(response(output))))
      .toMatchObject({ ok: false, error: { code: 'invalid-response' } });
  });

  it('rejects remote image URLs and cancellation before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await recognizeImage(settings, 'https://other.example/image.png', new AbortController().signal, fetcher)).toMatchObject({ ok: false });
    const abort = new AbortController(); abort.abort();
    expect(await recognizeImage(settings, image, abort.signal, fetcher)).toMatchObject({ ok: false, error: { code: 'interrupted' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
