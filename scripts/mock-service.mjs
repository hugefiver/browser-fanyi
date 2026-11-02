import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function startMock() {
  const requests = [];
  const control = { delay: 0, status: 200, badJson: false, output: null, failText: null };
  const fixture = await readFile(new URL('../tests/fixtures/page.html', import.meta.url));
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/fixture')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture); return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = body.messages?.find(message => message.role === 'user')?.content;
    requests.push({ body, text, hasAuthorization: !!req.headers.authorization, cookie: req.headers.cookie, referer: req.headers.referer });
    const status = control.failText && text?.includes(control.failText) ? 429 : control.status;
    const output = control.output ?? `译文：${text}`;
    const badJson = control.badJson;
    setTimeout(() => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(badJson ? '{broken' : JSON.stringify(status === 200
        ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: output } }] }
        : { error: { code: status === 402 ? 'insufficient_quota' : 'controlled_error' } }));
    }, control.delay);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, requests, control,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
