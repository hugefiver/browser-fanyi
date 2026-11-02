import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/background/settings';
import { defaultPreferences, type SaveSettings } from '../../src/shared/contracts';

const input = (prefix = 'https://first.example/v1'): SaveSettings => ({
  ...defaultPreferences, prefix, model: 'test-model', key: { kind: 'replace', value: 'private-key', forOrigin: new URL(prefix).origin },
});
const store = () => new SettingsStore(`settings-test-${crypto.randomUUID()}`);

describe('extension IndexedDB settings', () => {
  it('persists the key only in its private record and exposes hasKey', async () => {
    const name = `settings-test-${crypto.randomUUID()}`;
    await new SettingsStore(name).save(input());
    const reopened = new SettingsStore(name);
    expect((await reopened.read()).key).toBe('private-key');
    const settings = await reopened.publicSettings(async () => true);
    expect(settings.hasKey).toBe(true);
    expect(settings.authorized).toBe(true);
    expect(settings).not.toHaveProperty('key');
    expect(JSON.stringify(settings)).not.toContain('private-key');
  });

  it('keeps keys on the same origin and discards them when origin changes', async () => {
    const settings = store();
    await settings.save(input());
    await settings.save({ ...input('https://first.example/other'), key: { kind: 'keep' } });
    expect((await settings.read()).key).toBe('private-key');
    await settings.save({ ...input('https://second.example/v1'), key: { kind: 'keep' } });
    expect((await settings.read()).key).toBe('');
  });

  it('rejects replacement credentials bound to another origin without changing the record', async () => {
    const settings = store();
    await settings.save(input());
    await expect(settings.save({ ...input('https://second.example/v1'),
      key: { kind: 'replace', value: 'old-key', forOrigin: 'https://first.example' } })).rejects.toThrow();
    expect((await settings.read()).prefix).toBe('https://first.example/v1');
    expect((await settings.read()).key).toBe('private-key');
  });

  it('clears service data independently of preferences, or clears everything', async () => {
    const settings = store();
    await settings.save({ ...input(), targetLanguage: 'fr', mode: 'translation' });
    await settings.clear(false);
    expect(await settings.read()).toMatchObject({ prefix: '', model: '', key: '', targetLanguage: 'fr', mode: 'translation' });
    await settings.clear(true);
    expect(await settings.read()).toEqual({ ...defaultPreferences, prefix: '', model: '', key: '' });
  });

  it('has no default network receiver or model', async () => {
    const settings = await store().publicSettings(async () => { throw new Error('must not check an absent receiver'); });
    expect(settings).toMatchObject({ prefix: '', model: '', hasKey: false, authorized: false });
  });
});
