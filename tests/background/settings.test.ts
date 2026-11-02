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

  it('opens an existing version-one database without a glossary record as an empty glossary', async () => {
    const settings = store();
    await settings.save(input());
    expect(await settings.listGlossary()).toEqual([]);
    expect(await settings.snapshot()).toMatchObject({ prefix: 'https://first.example/v1', glossary: [] });
  });

  it('persists glossary CRUD independently from settings and rejects a missing edit id', async () => {
    const name = `settings-test-${crypto.randomUUID()}`;
    const settings = new SettingsStore(name);
    let entries = await settings.upsertGlossary({ source: 'source', target: 'target', targetLanguage: 'fr' });
    expect(entries).toHaveLength(1);
    entries = await new SettingsStore(name).upsertGlossary({ id: entries[0].id, source: 'source', target: 'updated', targetLanguage: 'fr' });
    expect(entries[0].target).toBe('updated');
    await expect(settings.upsertGlossary({ id: 'missing', source: 'other', target: 'value', targetLanguage: 'fr' }))
      .rejects.toThrow(/不存在/);
    expect(await settings.deleteGlossary(entries[0].id)).toEqual([]);
  });

  it('serializes concurrent writes and rejects a concurrent duplicate without losing the winner', async () => {
    const settings = store();
    await Promise.all([
      settings.upsertGlossary({ source: 'one', target: '一', targetLanguage: 'zh-CN' }),
      settings.upsertGlossary({ source: 'two', target: '二', targetLanguage: 'zh-CN' }),
    ]);
    expect((await settings.listGlossary()).map(({ source }) => source).sort()).toEqual(['one', 'two']);
    const duplicate = await Promise.allSettled([
      settings.upsertGlossary({ source: 'same', target: '甲', targetLanguage: 'zh-CN' }),
      settings.upsertGlossary({ source: 'same', target: '乙', targetLanguage: 'zh-CN' }),
    ]);
    expect(duplicate.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await settings.listGlossary()).filter(({ source }) => source === 'same')).toHaveLength(1);
  });

  it('imports atomically with entry positions and applies clear service/all semantics', async () => {
    const settings = store();
    await settings.save(input());
    await settings.upsertGlossary({ source: 'existing', target: '已有', targetLanguage: 'zh-CN' });
    await expect(settings.importGlossary([
      { source: 'new', target: '新增', targetLanguage: 'zh-CN' },
      { source: 'existing', target: '重复', targetLanguage: 'zh-CN' },
    ])).rejects.toThrow(/第 2 项/);
    expect((await settings.listGlossary()).map(({ source }) => source)).toEqual(['existing']);
    await settings.importGlossary([
      { source: 'new', target: '新增', targetLanguage: 'zh-CN' },
      { source: 'existing', target: 'Existing', targetLanguage: 'en' },
    ]);
    const snapshot = await settings.snapshot();
    expect(snapshot.glossary).toHaveLength(3);
    expect(snapshot.key).toBe('private-key');
    await settings.save({ ...input(), model: 'updated', key: { kind: 'keep' } });
    expect(await settings.listGlossary()).toHaveLength(3);
    await settings.clear(false);
    expect(await settings.listGlossary()).toHaveLength(3);
    await settings.clear(true);
    expect(await settings.listGlossary()).toEqual([]);
  });

  it('has no default network receiver or model', async () => {
    const settings = await store().publicSettings(async () => { throw new Error('must not check an absent receiver'); });
    expect(settings).toMatchObject({ prefix: '', model: '', hasKey: false, authorized: false });
  });
});
