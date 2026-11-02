import { describe, expect, it, vi } from 'vitest';
import { translate } from '../../src/background/provider';
import type { StoredSettings } from '../../src/background/settings';
import { writingOperations } from '../../src/shared/workbench';

const settings: StoredSettings = { prefix: 'https://receiver.example/v1', model: 'chosen-model', key: 'secret',
  sourceLanguage: 'auto', targetLanguage: 'fr', mode: 'bilingual' };

describe('fixed writing operations use the real provider boundary', () => {
  it.each(writingOperations)('sends %s with user text isolated and no tools', async operation => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Revised text' } }] }));
    expect(await translate(settings, 'Private draft', new AbortController().signal, [], fetcher, operation))
      .toEqual({ ok: true, value: 'Revised text' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://receiver.example/v1/chat/completions');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    const body = JSON.parse(String(init?.body));
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Private draft' });
    expect(body.messages[0].content).not.toContain('Private draft');
    expect(body.messages[0].content.toLowerCase()).toContain(operation === 'translate' ? 'translate' : operation);
    expect(body.tools).toBeUndefined();
  });

  it('rejects tool-call responses for writing just as for translation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: 'text', tool_calls: [{ function: { name: 'execute' } }],
    } }] }));
    expect(await translate(settings, 'draft', new AbortController().signal, [], fetcher, 'polish'))
      .toMatchObject({ ok: false, error: { code: 'invalid-response' } });
  });
});
