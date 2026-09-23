import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createActivityStore } from './lib/state.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function json(response, code, payload) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8192) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (bytes > 8192) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Expected a JSON body.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function authorized(request, token) {
  const provided = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function createQuizServer({ token = randomBytes(32).toString('hex'), store = createActivityStore() } = {}) {
  // A future Anki adapter only needs to produce this same card shape.
  const cards = JSON.parse(await readFile(path.join(ROOT, 'data/cards.json'), 'utf8'));
  const clients = new Set();
  const broadcast = () => {
    const payload = `event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`;
    for (const client of clients) client.write(payload);
  };
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': keepalive\n\n'); }, 15000);
  heartbeat.unref();

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', CSP);
    try {
      const port = server.address()?.port;
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!allowedHosts.has(request.headers.host)) return json(response, 403, { error: 'Local access only.' });
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        return json(response, 403, { error: 'Cross-origin requests are not allowed.' });
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { app: 'codex-quiz', version: 1 });
      if (request.method === 'GET' && url.pathname === '/api/cards') return json(response, 200, { cards });
      if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, store.snapshot());
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
        clients.add(response);
        response.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'POST' && ['/api/hook', '/api/demo'].includes(url.pathname)) {
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: 'Use application/json.' });
        if (url.pathname === '/api/hook' && !authorized(request, token)) return json(response, 401, { error: 'Invalid hook token.' });
        const body = await readJson(request);
        let state;
        try { state = url.pathname === '/api/hook' ? store.applyHook(body) : store.applyDemo(body?.action); }
        catch (error) { return json(response, url.pathname === '/api/demo' ? 409 : 400, { error: error.message }); }
        broadcast();
        return json(response, 200, state);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed.' });
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'Not found.' });
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      // Only flat public assets are served; no filesystem paths from hooks are exposed.
      if (!/^[a-zA-Z0-9_-]+\.(html|css|js|svg|ico)$/.test(filename)) return json(response, 404, { error: 'Not found.' });
      let contents;
      try { contents = await readFile(path.join(PUBLIC, filename)); }
      catch (error) { if (error.code === 'ENOENT') return json(response, 404, { error: 'Not found.' }); throw error; }
      response.writeHead(200, { 'Content-Type': MIME[path.extname(filename)], 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : 'Something went wrong.' });
      else response.end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('close', () => clearInterval(heartbeat));
  const close = () => new Promise(resolve => {
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    server.close(resolve);
    server.closeIdleConnections();
  });
  return { server, store, token, close };
}

export async function startServer() {
  const port = Number(process.env.QUIZ_PORT || 4319);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('QUIZ_PORT must be an integer between 1024 and 65535.');
  const app = await createQuizServer();
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolve);
  });
  const runtimeDir = path.join(ROOT, '.runtime');
  const runtimePath = path.join(runtimeDir, 'server.json');
  try {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(runtimePath, JSON.stringify({ app: 'codex-quiz', pid: process.pid, port, token: app.token }), { mode: 0o600 });
  } catch (error) { await app.close(); throw error; }
  console.log(`While is ready at http://127.0.0.1:${port}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    try {
      const current = JSON.parse(await readFile(runtimePath, 'utf8'));
      if (current.pid === process.pid) await unlink(runtimePath);
    } catch { /* A stale runtime file is safe: clients also verify the server. */ }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch(error => {
    console.error(error.code === 'EADDRINUSE' ? 'The quiz port is already in use. Open the running panel or set QUIZ_PORT.' : error.message);
    process.exitCode = 1;
  });
}
