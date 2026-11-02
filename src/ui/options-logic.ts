import { endpoint } from '../shared/endpoint';
import { SaveSettings } from '../shared/contracts';

export function resolveDraftOrigin(prefix: string): string | null {
  if (!prefix.trim()) return null;
  try {
    return endpoint(prefix).origin;
  } catch {
    return null;
  }
}

export function shouldClearKeyInput(prevOrigin: string | null, nextOrigin: string | null): boolean {
  if (nextOrigin === null) return true;
  return prevOrigin !== nextOrigin;
}

export function buildKeyAction(params: {
  apiKey: string;
  currentOrigin: string;
  savedOrigin: string;
  savedHasKey: boolean;
}): SaveSettings['key'] {
  const trimmed = params.apiKey.trim();
  if (trimmed.length > 0) {
    return {
      kind: 'replace',
      value: trimmed,
      forOrigin: params.currentOrigin,
    };
  }
  if (params.savedHasKey && params.currentOrigin === params.savedOrigin) {
    return { kind: 'keep' };
  }
  return { kind: 'clear' };
}
