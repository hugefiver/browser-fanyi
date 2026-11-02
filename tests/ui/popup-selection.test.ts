import { describe, it, expect } from 'vitest';
import { isUnsupportedTabUrl } from '../../src/ui/tab-utils';
import { getLanguageLabel } from '../../src/ui/languages';

describe('popup & selection UI logic', () => {
  describe('isUnsupportedTabUrl', () => {
    it('identifies internal browser URLs as unsupported', () => {
      expect(isUnsupportedTabUrl('chrome://extensions')).toBe(true);
      expect(isUnsupportedTabUrl('chrome-extension://xyz/popup.html')).toBe(true);
      expect(isUnsupportedTabUrl('edge://settings')).toBe(true);
      expect(isUnsupportedTabUrl('about:blank')).toBe(true);
      expect(isUnsupportedTabUrl('about:config')).toBe(true);
      expect(isUnsupportedTabUrl('moz-extension://abc/index.html')).toBe(true);
      expect(isUnsupportedTabUrl('devtools://devtools/bundled/inspector.html')).toBe(true);
      expect(isUnsupportedTabUrl('view-source:https://example.com')).toBe(true);
    });

    it('identifies regular web pages as supported', () => {
      expect(isUnsupportedTabUrl('https://example.com')).toBe(false);
      expect(isUnsupportedTabUrl('https://news.ycombinator.com/')).toBe(false);
      expect(isUnsupportedTabUrl('http://localhost:3000')).toBe(false);
      expect(isUnsupportedTabUrl('http://127.0.0.1:8080')).toBe(false);
    });

    it('handles empty or undefined url', () => {
      expect(isUnsupportedTabUrl('')).toBe(false);
      expect(isUnsupportedTabUrl(undefined)).toBe(false);
    });
  });

  describe('getLanguageLabel', () => {
    it('returns human-readable Chinese label for common language codes', () => {
      expect(getLanguageLabel('auto')).toBe('自动检测');
      expect(getLanguageLabel('zh-CN')).toBe('简体中文');
      expect(getLanguageLabel('en')).toBe('英语');
      expect(getLanguageLabel('ja')).toBe('日语');
    });

    it('falls back to raw code when code is unknown', () => {
      expect(getLanguageLabel('unknown-code')).toBe('unknown-code');
    });
  });
});
