export interface Endpoint { prefix: string; origin: string; requestUrl: string; permission: string }
export function endpoint(value: string): Endpoint {
  const input = value.trim();
  const url = new URL(input);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(input);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('只允许 HTTPS 或 localhost/127.0.0.1 HTTP，且不能包含凭据、查询或片段。');
  }
  const prefix = url.href.replace(/\/+$/, '');
  return { prefix, origin: url.origin, requestUrl: `${prefix}/chat/completions`, permission: `${url.protocol}//${url.hostname}/*` };
}
