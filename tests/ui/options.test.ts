import { describe, it, expect } from 'vitest';
import { resolveDraftOrigin, shouldClearKeyInput, buildKeyAction } from '../../src/ui/options-logic';

describe('options UI logic', () => {
  describe('resolveDraftOrigin', () => {
    it('resolves origin for valid https endpoint', () => {
      expect(resolveDraftOrigin('https://api.openai.com/v1')).toBe('https://api.openai.com');
      expect(resolveDraftOrigin('https://custom.service.com:8443/chat')).toBe('https://custom.service.com:8443');
    });

    it('resolves origin for localhost http endpoint', () => {
      expect(resolveDraftOrigin('http://localhost:11434/v1')).toBe('http://localhost:11434');
      expect(resolveDraftOrigin('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080');
    });

    it('returns null for empty, invalid, or disallowed URLs', () => {
      expect(resolveDraftOrigin('')).toBeNull();
      expect(resolveDraftOrigin('   ')).toBeNull();
      expect(resolveDraftOrigin('not-a-url')).toBeNull();
      expect(resolveDraftOrigin('http://insecure.example.com/v1')).toBeNull();
      expect(resolveDraftOrigin('https://user:pass@api.openai.com/v1')).toBeNull();
      expect(resolveDraftOrigin('https://api.openai.com/v1?query=1')).toBeNull();
      expect(resolveDraftOrigin('https://api.openai.com/v1#hash')).toBeNull();
    });
  });

  describe('shouldClearKeyInput', () => {
    it('clears key when draft origin changes to another host', () => {
      expect(shouldClearKeyInput('https://api.openai.com', 'https://api.deepseek.com')).toBe(true);
      expect(shouldClearKeyInput('https://api.openai.com', 'http://localhost:11434')).toBe(true);
    });

    it('clears key when draft becomes invalid or empty', () => {
      expect(shouldClearKeyInput('https://api.openai.com', null)).toBe(true);
      expect(shouldClearKeyInput(null, null)).toBe(true);
    });

    it('does not clear key when origin remains identical', () => {
      expect(shouldClearKeyInput('https://api.openai.com', 'https://api.openai.com')).toBe(false);
    });
  });

  describe('buildKeyAction', () => {
    it('replaces key when non-empty key is provided', () => {
      const res = buildKeyAction({
        apiKey: 'sk-test-1234',
        currentOrigin: 'https://api.openai.com',
        savedOrigin: 'https://api.openai.com',
        savedHasKey: true,
      });
      expect(res).toEqual({
        kind: 'replace',
        value: 'sk-test-1234',
        forOrigin: 'https://api.openai.com',
      });
    });

    it('keeps existing key only when origin matches and saved has key', () => {
      const res = buildKeyAction({
        apiKey: '  ',
        currentOrigin: 'https://api.openai.com',
        savedOrigin: 'https://api.openai.com',
        savedHasKey: true,
      });
      expect(res).toEqual({ kind: 'keep' });
    });

    it('clears key when origin has changed even if previous had key', () => {
      const res = buildKeyAction({
        apiKey: '',
        currentOrigin: 'http://localhost:11434',
        savedOrigin: 'https://api.openai.com',
        savedHasKey: true,
      });
      expect(res).toEqual({ kind: 'clear' });
    });

    it('clears key when saved setting had no key and no new key entered', () => {
      const res = buildKeyAction({
        apiKey: '',
        currentOrigin: 'https://api.openai.com',
        savedOrigin: 'https://api.openai.com',
        savedHasKey: false,
      });
      expect(res).toEqual({ kind: 'clear' });
    });
  });
});
