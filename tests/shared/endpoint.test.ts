import { describe, expect, it } from 'vitest';
import { endpoint } from '../../src/shared/endpoint';

describe('service endpoint boundary', () => {
  it('keeps the API prefix and exact origin while granting only a host pattern', () => {
    expect(endpoint('https://service.example:8443/api/v1/')).toEqual({
      prefix: 'https://service.example:8443/api/v1', origin: 'https://service.example:8443',
      requestUrl: 'https://service.example:8443/api/v1/chat/completions', permission: 'https://service.example/*',
    });
  });
  it.each(['http://localhost:8000/v1', 'http://127.0.0.1:9000/v1'])('accepts an explicit local endpoint %s', value => {
    expect(endpoint(value).requestUrl).toBe(`${value}/chat/completions`);
  });
  it.each(['http://example.com/v1', 'http://localhost.example/v1', 'http://192.168.1.3/v1', 'http://[::1]/v1', 'http://127.1/v1', 'http://2130706433/v1',
    'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#route', 'file:///service'])('rejects %s', value => {
    expect(() => endpoint(value)).toThrow();
  });
});
