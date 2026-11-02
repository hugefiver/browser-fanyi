import { defaultPreferences, type PublicSettings, type SaveSettings } from '../shared/contracts';
import { endpoint } from '../shared/endpoint';

export interface StoredSettings {
  prefix: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  mode: 'bilingual' | 'translation';
  key: string;
}

const emptySettings = (): StoredSettings => ({ ...defaultPreferences, prefix: '', model: '', key: '' });

export class SettingsStore {
  private database?: Promise<IDBDatabase>;

  constructor(private readonly name = 'browser-translator') {}

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('settings');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.database;
  }

  async read(): Promise<StoredSettings> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction('settings').objectStore('settings').get('current');
      request.onsuccess = () => resolve((request.result as StoredSettings | undefined) ?? emptySettings());
      request.onerror = () => reject(request.error);
    });
  }

  async save(input: SaveSettings): Promise<void> {
    const next = endpoint(input.prefix);
    if (!input.model.trim() || !input.sourceLanguage.trim() || !input.targetLanguage.trim()) throw new Error('configuration');
    if (input.key.kind === 'replace' && input.key.forOrigin !== next.origin) throw new Error('configuration');
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('settings', 'readwrite');
      const store = transaction.objectStore('settings');
      const request = store.get('current');
      request.onsuccess = () => {
        const previous = (request.result as StoredSettings | undefined) ?? emptySettings();
        const sameOrigin = previous.prefix !== '' && endpoint(previous.prefix).origin === next.origin;
        const key = input.key.kind === 'replace' ? input.key.value : input.key.kind === 'keep' && sameOrigin ? previous.key : '';
        store.put({ prefix: next.prefix, model: input.model.trim(), sourceLanguage: input.sourceLanguage.trim(),
          targetLanguage: input.targetLanguage.trim(), mode: input.mode, key } satisfies StoredSettings, 'current');
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async clear(all: boolean): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('settings', 'readwrite');
      const store = transaction.objectStore('settings');
      if (all) store.delete('current');
      else {
        const request = store.get('current');
        request.onsuccess = () => {
          const previous = (request.result as StoredSettings | undefined) ?? emptySettings();
          store.put({ ...previous, prefix: '', model: '', key: '' }, 'current');
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async publicSettings(authorized: (permission: string) => Promise<boolean>): Promise<PublicSettings> {
    const { key, ...settings } = await this.read();
    return { ...settings, hasKey: key.length > 0,
      authorized: settings.prefix !== '' && await authorized(endpoint(settings.prefix).permission) };
  }
}
