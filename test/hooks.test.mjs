import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { normalizeHookPayload, readHookInput, runHook } from '../scripts/codex-hook.mjs';
import { buildHooksConfig, installHooks, shellQuote } from '../scripts/install-hooks.mjs';

const TOKEN = 'test-local-token-123456789';
const INPUT = { hook_event_name: 'UserPromptSubmit', session_id: 'session-a', turn_id: 'turn-a' };

async function fixture(t, handler) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-quiz-hook-'));
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await mkdir(path.join(root, '.runtime'));
  await writeFile(path.join(root, '.runtime', 'server.json'), JSON.stringify({ app: 'codex-quiz', pid: process.pid, port, token: TOKEN }));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, port };
}

test('only lifecycle identifiers cross the hook boundary', () => {
  assert.deepEqual(normalizeHookPayload({ ...INPUT, prompt: 'private', transcript_path: '/private', cwd: '/secret' }), INPUT);
  assert.equal(normalizeHookPayload({ ...INPUT, hook_event_name: 'PreToolUse' }), null);
  assert.equal(normalizeHookPayload({ ...INPUT, turn_id: undefined }), null);
  assert.equal(normalizeHookPayload({ ...INPUT, session_id: 'a'.repeat(257) }), null);
  assert.deepEqual(normalizeHookPayload({ hook_event_name: 'SessionEnd', session_id: 'a' }), { hook_event_name: 'SessionEnd', session_id: 'a' });
});

test('stdin handles chunked JSON and rejects malformed or oversized input', async () => {
  assert.deepEqual(await readHookInput(Readable.from(['{"ok":', 'true}'])), { ok: true });
  await assert.rejects(readHookInput(Readable.from(['not json'])));
  await assert.rejects(readHookInput(Readable.from(['123456']), { maxBytes: 5 }), /too large/);
});

test('client verifies identity before sending the token and strips private input', async (t) => {
  const calls = [];
  const local = await fixture(t, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      calls.push({ path: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/api/health' ? JSON.stringify({ app: 'codex-quiz', version: 1 }) : '{}');
    });
  });
  let spawned = false;
  assert.equal(await runHook({ ...INPUT, prompt: 'do not send', transcript_path: '/hidden' }, { ...local, spawnServer: () => { spawned = true; } }), true);
  assert.equal(spawned, false);
  assert.deepEqual(calls.map((call) => call.path), ['/api/health', '/api/hook']);
  assert.equal(calls[0].authorization, undefined);
  assert.equal(calls[1].authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[1].body), INPUT);
});

test('unknown listener receives neither a token nor hook data', async (t) => {
  const calls = [];
  const local = await fixture(t, (req, res) => {
    calls.push({ path: req.url, auth: req.headers.authorization });
    res.end(JSON.stringify({ app: 'another-app', version: 1 }));
  });
  let starts = 0;
  assert.equal(await runHook(INPUT, { ...local, maxWaitMs: 100, spawnServer: () => { starts += 1; } }), false);
  assert.equal(starts, 1);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.path === '/api/health' && call.auth === undefined));
});

test('invalid events never launch a companion', async () => {
  let starts = 0;
  assert.equal(await runHook({ ...INPUT, hook_event_name: 'Unexpected' }, { spawnServer: () => { starts += 1; } }), false);
  assert.equal(starts, 0);
});

test('the actual hook command fails open with valid empty JSON output', () => {
  const hookPath = fileURLToPath(new URL('../scripts/codex-hook.mjs', import.meta.url));
  for (const input of ['malformed JSON', JSON.stringify({ ...INPUT, hook_event_name: 'Unexpected' })]) {
    const child = spawnSync(process.execPath, [hookPath], { cwd: os.tmpdir(), input, encoding: 'utf8', timeout: 3000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.equal(child.stdout, '{}\n');
    assert.equal(child.stderr, '');
  }
});

test('client retries when the runtime record appears during startup', async (t) => {
  const local = await fixture(t, (req, res) => {
    res.end(req.url === '/api/health' ? JSON.stringify({ app: 'codex-quiz', version: 1 }) : '{}');
  });
  const runtimePath = path.join(local.root, '.runtime', 'server.json');
  const runtime = await readFile(runtimePath);
  await rm(runtimePath);
  let starts = 0;
  assert.equal(await runHook(INPUT, { ...local, maxWaitMs: 500, spawnServer: () => {
    starts += 1;
    void writeFile(runtimePath, runtime);
  } }), true);
  assert.equal(starts, 1);
});

test('installer preserves unrelated settings and hooks and is idempotent', () => {
  const opts = { hookPath: "/tmp/a project's/scripts/codex-hook.mjs", nodePath: '/tmp/node binary' };
  const existing = { otherSetting: true, hooks: {
    Stop: [{ matcher: 'keep-me', hooks: [{ type: 'command', command: 'echo existing', timeout: 12 }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'another-hook' }] }],
  } };
  const config = buildHooksConfig(existing, opts);
  assert.deepEqual(config.hooks.Stop[0], existing.hooks.Stop[0]);
  assert.deepEqual(config.hooks.PreToolUse, existing.hooks.PreToolUse);
  assert.equal(config.otherSetting, true);
  assert.deepEqual(buildHooksConfig(config, opts), config);
  assert.equal(config.hooks.Stop[1].hooks[0].async, true);
  assert.equal(config.hooks.SessionEnd[0].hooks[0].async, false);
  assert.equal(config.hooks.Stop[1].hooks[0].timeout, 3);
  assert.equal(config.hooks.Stop[1].hooks[0].command, `${shellQuote(opts.nodePath)} ${shellQuote(opts.hookPath)}`);
  assert.equal(existing.hooks.UserPromptSubmit, undefined);
});

test('installer dry run does not write; malformed config is never replaced', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-quiz-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'hooks.json');
  await installHooks({ targetPath, dryRun: true });
  await assert.rejects(readFile(targetPath), { code: 'ENOENT' });
  const installed = await installHooks({ targetPath });
  assert.equal(installed.changed, true);
  assert.equal((await installHooks({ targetPath })).changed, false);
  await writeFile(targetPath, '{invalid');
  await assert.rejects(installHooks({ targetPath }), /Cannot safely read/);
  assert.equal(await readFile(targetPath, 'utf8'), '{invalid');
});
