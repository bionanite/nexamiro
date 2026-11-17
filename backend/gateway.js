import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from './engine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const SESSION_TTL = 12 * 60 * 60 * 1000;
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail('Use application/json for this request.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw fail('Request body exceeds 1 MB.', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw fail('Request body must be a JSON object.'); }
}

export function createGateway({ engine, env = process.env, staticDir = resolve(root, 'dist') }) {
  const token = env.ACCESS_TOKEN || '';
  const host = env.HOST || '127.0.0.1';
  if (!loopback.has(host) && token.length < 24) throw new Error('Set ACCESS_TOKEN to at least 24 characters before binding to a non-loopback address.');
  const sessions = new Map();
  const attempts = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const json = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const requestHost = req.headers.host;
      if (!requestHost) throw fail('Host header required.');
      let hostname;
      try { hostname = new URL('http://' + requestHost).hostname; } catch { throw fail('Invalid Host header.'); }
      if (loopback.has(host) && !loopback.has(hostname)) throw fail('Unrecognized local host.', 403);
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw fail('Origin not allowed.', 403); }
        const devOrigin = loopback.has(host) && loopback.has(origin.hostname) && origin.port === '3000';
        if (origin.host !== requestHost && !devOrigin) throw fail('Origin not allowed.', 403);
      }
      if (req.method === 'GET' && path === '/api/health') return json(200, { ok: true });
      const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('nexamiro_session='))?.slice('nexamiro_session='.length);
      const sessionValid = cookie && (sessions.get(cookie) || 0) > Date.now();
      if (path === '/api/session' && req.method === 'POST') {
        const address = req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        let attempt = attempts.get(address);
        if (!attempt || now - attempt.start > 60000) attempt = { start: now, count: 0 };
        attempt.count++;
        attempts.set(address, attempt);
        if (attempt.count > 10) throw fail('Too many sign-in attempts. Try again in a minute.', 429);
        const body = await readJson(req);
        if (token && !equal(body.token, token)) throw fail('Incorrect access token.', 401);
        if (token) {
          const session = randomBytes(32).toString('hex');
          if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
          sessions.set(session, now + SESSION_TTL);
          const secure = env.COOKIE_SECURE === 'true' ? '; Secure' : '';
          res.setHeader('Set-Cookie', `nexamiro_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${secure}`);
        }
        return json(200, { ok: true });
      }
      if (path.startsWith('/api/')) {
        if (token && !equal(bearer, token) && !sessionValid) throw fail('Access token required.', 401);
        if (req.method === 'DELETE' && path === '/api/session') {
          sessions.delete(cookie);
          res.setHeader('Set-Cookie', 'nexamiro_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
          return json(200, { ok: true });
        }
        if (req.method === 'GET' && path === '/api/status') return json(200, await engine.status());
        if (req.method === 'POST' && path === '/api/models/test') {
          const body = await readJson(req);
          if (Object.keys(body).length !== 0) throw fail('The model connection test accepts only an empty JSON object.');
          return json(200, await engine.testModels());
        }
        if (req.method === 'GET' && path === '/api/tasks') return json(200, { tasks: await engine.listTasks() });
        if (req.method === 'POST' && path === '/api/tasks') return json(202, { task: await engine.createTask(await readJson(req)) });
        const taskMatch = path.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)(?:\/(cancel|retry))?$/);
        if (taskMatch) {
          const [, id, action] = taskMatch;
          if (!action && req.method === 'GET') {
            const task = await engine.getTask(id);
            if (!task) throw fail('Run not found.', 404);
            return json(200, { task });
          }
          if (req.method === 'POST' && action) {
            await readJson(req);
            const task = action === 'cancel' ? await engine.cancelTask(id) : await engine.retryTask(id);
            return json(action === 'retry' ? 202 : 200, { task });
          }
        }
        if (req.method === 'GET' && path === '/api/documents') return json(200, { documents: await engine.listDocuments() });
        if (req.method === 'POST' && path === '/api/documents') return json(201, { document: await engine.addDocument(await readJson(req)) });
        const docMatch = path.match(/^\/api\/documents\/([a-zA-Z0-9_-]+)$/);
        if (req.method === 'DELETE' && docMatch) {
          await engine.deleteDocument(docMatch[1]);
          return json(200, { ok: true });
        }
        if (req.method === 'POST' && path === '/api/knowledge/search') {
          const body = await readJson(req);
          return json(200, { results: await engine.searchKnowledge(body.query, body.documentIds) });
        }
        throw fail('API route not found.', 404);
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fail('Method not allowed.', 405);
      let relative;
      try { relative = decodeURIComponent(path); } catch { throw fail('Invalid path.'); }
      let filePath = resolve(staticDir, '.' + relative);
      if (filePath !== resolve(staticDir) && !filePath.startsWith(resolve(staticDir) + sep)) throw fail('Not found.', 404);
      try { if (!(await stat(filePath)).isFile()) filePath = resolve(staticDir, 'index.html'); }
      catch { filePath = resolve(staticDir, 'index.html'); }
      let bytes;
      try { bytes = await readFile(filePath); } catch {
        return json(404, { error: 'Frontend not built. Run npm run dev, or npm run build followed by npm start.' });
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.headersSent || res.destroyed) return res.end();
      const code = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      json(code, { error: code === 500 ? 'Something went wrong. Please try again.' : error.message });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
    for (const [key, attempt] of attempts) if (now - attempt.start > 60000) attempts.delete(key);
  }, 60000).unref();
  server.on('close', () => clearInterval(timer));
  return server;
}

export async function startGateway(env = process.env) {
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const host = env.HOST || '127.0.0.1';
  if (!loopback.has(host) && (env.ACCESS_TOKEN || '').length < 24) throw new Error('Set ACCESS_TOKEN to at least 24 characters for non-loopback hosting.');
  const engine = await createEngine({ dataDir: resolve(env.NEXAMIRO_DATA_DIR || resolve(root, 'data')), env });
  const server = createGateway({ engine, env });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, host, ready); });
  console.log(`Nexamiro API and workspace: http://${host === '::1' ? '[::1]' : host}:${port}`);
  let shuttingDown = false;
  const close = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    server.closeIdleConnections();
    await engine.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return { server, engine, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startGateway().catch(error => { console.error(error.message); process.exitCode = 1; });
}
