import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createEngine } from '../backend/engine.js';
import { createGateway } from '../backend/gateway.js';

async function setup(t, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nexamiro-http-'));
  const engine = await createEngine({ dataDir: join(directory, 'data'), env: {}, demoDelayMs: 15 });
  const staticDir = join(directory, 'dist');
  await mkdir(staticDir);
  await writeFile(join(staticDir, 'index.html'), '<html>Nexamiro</html>');
  const server = createGateway({ engine, env, staticDir });
  t.after(async () => { await engine.close(); server.emit('close'); await rm(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:8080';
  // Exercise the real HTTP handler in-process; no listening socket is needed.
  const requestRaw = (path, options = {}) => new Promise((resolveResponse, reject) => {
    const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
    req.url = path;
    req.method = options.method || 'GET';
    req.headers = { host: '127.0.0.1:8080', ...Object.fromEntries(Object.entries(options.headers || {}).map(([k,v]) => [k.toLowerCase(), v])) };
    req.socket = { remoteAddress: '127.0.0.1' };
    const headers = new Headers();
    let status = 200;
    const res = {
      headersSent: false, destroyed: false,
      setHeader(key, value) { headers.set(key, value); },
      writeHead(code, values) { status = code; Object.entries(values).forEach(([k,v]) => headers.set(k,v)); this.headersSent = true; },
      end(body) { resolveResponse(new Response(body, { status, headers })); },
    };
    req.on('error', reject);
    server.emit('request', req, res);
  });
  const request = (path, method = 'GET', body, headers = {}) => requestRaw(path, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { request, requestRaw, engine, base };
}

test('HTTP workspace lifecycle: ingest, retrieve, run, retry, remove', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/status')).status, 200);
  const createdDoc = await request('/api/documents', 'POST', { name: 'Operations.md', text: 'Allied facilities security proposal targets UK facilities managers.' });
  assert.equal(createdDoc.status, 201);
  const { document } = await createdDoc.json();
  const results = await (await request('/api/knowledge/search', 'POST', { query: 'facilities' })).json();
  assert.equal(results.results[0].documentId, document.id);
  const created = await request('/api/tasks', 'POST', { prompt: 'Draft facilities security proposal', mode: 'reasoning', documentIds: [document.id] });
  assert.equal(created.status, 202);
  const { task } = await created.json();
  let completed;
  for (let i = 0; i < 100; i++) {
    completed = (await (await request('/api/tasks/' + task.id)).json()).task;
    if (completed.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(completed.status, 'completed');
  assert.match(completed.answer, /No language model was called/);
  assert.equal(completed.sources[0].documentId, document.id);
  const retry = await request('/api/tasks/' + task.id + '/retry', 'POST', {});
  assert.equal(retry.status, 202);
  const retried = (await retry.json()).task;
  assert.notEqual(retried.id, task.id);
  assert.equal((await request('/api/tasks/' + retried.id + '/cancel', 'POST', {})).status, 200);
  assert.equal((await request('/api/documents/' + document.id, 'DELETE')).status, 200);
  assert.equal((await request('/api/documents/' + document.id, 'DELETE')).status, 404);
});

test('token authentication, HttpOnly session, logout, and secret-free status', async t => {
  const token = 'test-workspace-access-token-at-least-24';
  const { request } = await setup(t, { ACCESS_TOKEN: token });
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/status')).status, 401);
  assert.equal((await request('/api/session', 'POST', { token: 'wrong' })).status, 401);
  const session = await request('/api/session', 'POST', { token });
  assert.equal(session.status, 200);
  const setCookie = session.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  assert.ok(!setCookie.includes(token));
  const cookie = setCookie.split(';')[0];
  const status = await request('/api/status', 'GET', undefined, { Cookie: cookie });
  assert.equal(status.status, 200);
  assert.ok(!(await status.text()).includes(token));
  assert.equal((await request('/api/tasks', 'GET', undefined, { Authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await request('/api/session', 'DELETE', undefined, { Cookie: cookie })).status, 200);
  assert.equal((await request('/api/status', 'GET', undefined, { Cookie: cookie })).status, 401);
});

test('rejects cross-origin writes, DNS rebinding host, invalid body, and unsafe bind', async t => {
  const { request, requestRaw } = await setup(t);
  assert.equal((await request('/api/tasks', 'POST', { prompt: 'hello' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/status', 'GET', undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await requestRaw('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await requestRaw('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await request('/api/tasks', 'POST', { prompt: ' ' })).status, 400);
  assert.equal((await request('/api/tasks', 'POST', { prompt: 'hello', mode: 'shell' })).status, 400);
  assert.equal((await request('/api/tasks/missing')).status, 404);
  assert.equal((await request('/api/unknown')).status, 404);
  assert.throws(() => createGateway({ engine: {}, env: { HOST: '0.0.0.0' } }), /ACCESS_TOKEN/);
});

test('serves built frontend and denies API leakage into SPA fallback', async t => {
  const { request } = await setup(t);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Nexamiro/);
  const unknown = await request('/api/nonexistent');
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type'), /application\/json/);
});
