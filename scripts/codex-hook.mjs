#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd']);
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

// Explicitly allow only lifecycle identifiers. Prompts, transcripts, paths, and
// all other Codex input stay out of the companion process.
export function normalizeHookPayload(input) {
  if (!input || typeof input !== 'object' || !EVENTS.has(input.hook_event_name)) return null;
  if (!identifier(input.session_id)) return null;
  if (input.hook_event_name !== 'SessionEnd' && !identifier(input.turn_id)) return null;
  const event = { hook_event_name: input.hook_event_name, session_id: input.session_id };
  if (identifier(input.turn_id)) event.turn_id = input.turn_id;
  return event;
}

export function readHookInput(stream, { maxBytes = 256 * 1024, timeoutMs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(new Error('Input timeout')), timeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.pause();
      if (error) reject(error);
      else resolve(value);
    }
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) return finish(new Error('Input too large'));
      chunks.push(buffer);
    }
    function onEnd() {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { finish(error); }
    }
    function onError(error) { finish(error); }
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.resume();
  });
}

function localRequest(port, pathname, { token, body, timeoutMs = 200 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      hostname: '127.0.0.1', port, path: pathname,
      method: encoded === undefined ? 'GET' : 'POST',
      headers: encoded === undefined ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(encoded),
        Authorization: `Bearer ${token}`,
      },
      agent: false,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024) { req.destroy(); finish(); }
        else chunks.push(chunk);
      });
      res.on('error', () => finish());
      res.on('end', () => {
        try { finish({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { finish(); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); finish(); }, Math.max(1, timeoutMs));
    req.on('error', () => finish());
    req.end(encoded);
  });
}

async function findServer(root, port, timeoutMs) {
  try {
    const content = await readFile(path.join(root, '.runtime', 'server.json'), 'utf8');
    if (content.length > 4096) return null;
    const runtime = JSON.parse(content);
    if (runtime.app !== 'codex-quiz' || runtime.port !== port ||
        !Number.isInteger(runtime.pid) || runtime.pid < 1 ||
        typeof runtime.token !== 'string' || runtime.token.length < 16 ||
        runtime.token.length > 256 || /[\r\n]/u.test(runtime.token)) return null;
    process.kill(runtime.pid, 0);
    const health = await localRequest(port, '/api/health', { timeoutMs });
    if (health?.status !== 200 || health.data?.app !== 'codex-quiz' || health.data?.version !== 1) return null;
    return runtime;
  } catch { return null; }
}

function startServer(root, port) {
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, detached: true, stdio: 'ignore',
    env: { ...process.env, QUIZ_PORT: String(port) },
  });
  child.on('error', () => {});
  child.unref();
}

export async function runHook(input, {
  root = PROJECT_ROOT,
  port = Number(process.env.QUIZ_PORT || 4319),
  maxWaitMs = 1800,
  spawnServer = startServer,
} = {}) {
  const event = normalizeHookPayload(input);
  if (!event || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const deadline = Date.now() + Math.min(2000, Math.max(0, maxWaitMs));
  let started = false;
  try {
    while (Date.now() < deadline) {
      const runtime = await findServer(root, port, Math.min(200, deadline - Date.now()));
      if (runtime && Date.now() < deadline) {
        const result = await localRequest(port, '/api/hook', {
          token: runtime.token, body: event, timeoutMs: Math.min(400, deadline - Date.now()),
        });
        return result?.status >= 200 && result.status < 300;
      }
      if (!started) {
        started = true;
        spawnServer(root, port);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(75, remaining)));
    }
  } catch { /* Hooks must never prevent Codex from continuing. */ }
  return false;
}

async function main() {
  const deadline = Date.now() + 1950;
  try {
    const input = await readHookInput(process.stdin);
    await runHook(input, { maxWaitMs: Math.max(0, deadline - Date.now()) });
  } catch { /* Invalid input and unavailable servers fail open. */ }
  process.stdout.write('{}\n');
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
