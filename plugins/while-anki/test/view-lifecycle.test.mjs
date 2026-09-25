import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { registerAnkiReviewTools } from '../anki-tools.mjs';
import {
  isViewMarkedHidden, markTurnViewsHidden, recordShownView,
  resolveViewLifecycleDir,
} from '../view-lifecycle.mjs';

const hookScript = fileURLToPath(new URL('../hooks/view-lifecycle.mjs', import.meta.url));
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'while-anki-lifecycle-'));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function runHook(directory, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], {
      env: { ...process.env, WHILE_ANKI_DATA_DIR: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Hook exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

test('Stop and Interrupt hide only a view opened in the same Codex turn', async () => {
  await withTempDir(async (directory) => {
    const lifecycleDir = resolveViewLifecycleDir(path.join(directory, 'auto-show.json'));
    const show = (session_id, turn_id, viewId) => runHook(directory, {
      hook_event_name: 'PostToolUse', session_id, turn_id,
      tool_name: 'mcp__while_anki__show_anki_review',
      tool_response: { structuredContent: { status: 'ready', viewId } },
    });
    assert.equal(await show('session-a', 'turn-1', FIRST), '');
    assert.equal(await show('session-a', 'turn-2', SECOND), '');
    assert.equal(await runHook(directory, {
      hook_event_name: 'Stop', session_id: 'session-b', turn_id: 'turn-1',
    }), '{}');
    assert.equal(await isViewMarkedHidden(lifecycleDir, FIRST), false);
    assert.equal(await runHook(directory, {
      hook_event_name: 'Stop', session_id: 'session-a', turn_id: 'turn-1',
    }), '{}');
    assert.equal(await isViewMarkedHidden(lifecycleDir, FIRST), true);
    assert.equal(await isViewMarkedHidden(lifecycleDir, SECOND), false);
    assert.equal(await runHook(directory, {
      hook_event_name: 'Interrupt', session_id: 'session-a', turn_id: 'turn-2',
    }), '');
    assert.equal(await isViewMarkedHidden(lifecycleDir, SECOND), true);
  });
});

test('a show result arriving after Interrupt is closed without hiding another turn', async () => {
  await withTempDir(async (directory) => {
    const lifecycleDir = resolveViewLifecycleDir(path.join(directory, 'auto-show.json'));
    assert.equal(await runHook(directory, {
      hook_event_name: 'Interrupt', session_id: 'session-a', turn_id: 'interrupted',
    }), '');
    const show = async (turn_id, viewId) => runHook(directory, {
      hook_event_name: 'PostToolUse', session_id: 'session-a', turn_id,
      tool_name: 'mcp__while_anki__show_anki_review',
      tool_response: { structuredContent: { status: 'ready', viewId } },
    });
    await show('interrupted', FIRST);
    await show('later', SECOND);
    assert.equal(await isViewMarkedHidden(lifecycleDir, FIRST), true);
    assert.equal(await isViewMarkedHidden(lifecycleDir, SECOND), false);
  });
});

test('a show result arriving after Stop is closed without hiding another session', async () => {
  await withTempDir(async (directory) => {
    const lifecycleDir = resolveViewLifecycleDir(path.join(directory, 'auto-show.json'));
    assert.equal(await runHook(directory, {
      hook_event_name: 'Stop', session_id: 'session-a', turn_id: 'completed',
    }), '{}');
    const show = async (session_id, viewId) => runHook(directory, {
      hook_event_name: 'PostToolUse', session_id, turn_id: 'completed',
      tool_name: 'mcp__while_anki__show_anki_review',
      tool_response: { structuredContent: { status: 'ready', viewId } },
    });
    await show('session-a', FIRST);
    await show('session-b', SECOND);
    assert.equal(await isViewMarkedHidden(lifecycleDir, FIRST), true);
    assert.equal(await isViewMarkedHidden(lifecycleDir, SECOND), false);
  });
});

test('malformed and unsuccessful tool responses never create hide markers', async () => {
  await withTempDir(async (directory) => {
    const lifecycleDir = resolveViewLifecycleDir(path.join(directory, 'auto-show.json'));
    for (const tool_response of [
      { isError: true, structuredContent: { status: 'ready', viewId: FIRST } },
      { structuredContent: { status: 'ready', viewId: 'not-a-uuid' } },
      { structuredContent: { status: 'not-ready', viewId: FIRST } },
      { content: [{ type: 'text', text: FIRST }] },
    ]) {
      await runHook(directory, {
        hook_event_name: 'PostToolUse', session_id: 'session-a', turn_id: 'turn-1',
        tool_name: 'mcp__while_anki__show_anki_review', tool_response,
      });
    }
    await runHook(directory, {
      hook_event_name: 'PostToolUse', session_id: 'session-a', turn_id: 'turn-1',
      tool_name: 'mcp__while_anki__rate_anki_review',
      tool_response: { structuredContent: { viewId: FIRST } },
    });
    assert.equal(await runHook(directory, {
      hook_event_name: 'Stop', session_id: 'session-a', turn_id: 'turn-1',
    }), '{}');
    assert.equal(await isViewMarkedHidden(lifecycleDir, FIRST), false);
    assert.equal(await recordShownView(lifecycleDir, {
      sessionId: 'session-a', turnId: 'turn-1', viewId: 'bad',
    }), false);
    assert.equal(await markTurnViewsHidden(lifecycleDir, { sessionId: 'session-a', turnId: 'turn-1' }), 0);
  });
});

test('Stop emits valid hook JSON when marker storage is unavailable', async () => {
  await withTempDir(async (directory) => {
    const inaccessibleDataDir = path.join(directory, 'a-file');
    await writeFile(inaccessibleDataDir, 'not a directory');
    assert.equal(await runHook(inaccessibleDataDir, {
      hook_event_name: 'Stop', session_id: 'session-a', turn_id: 'turn-1',
    }), '{}');
  });
});

test('widget state observes turn cleanup, even after the MCP server restarts', async () => {
  await withTempDir(async (directory) => {
    const lifecycleDir = path.join(directory, 'view-lifecycle');
    let ankiCalls = 0;
    const connect = async () => {
      const server = new McpServer({ name: 'anki-view-lifecycle-test', version: '0.1.0' });
      registerAnkiReviewTools(server, {
        autoShowSettingsPath: path.join(directory, 'auto-show.json'),
        viewLifecycleDir: lifecycleDir,
        clientFactory: () => { ankiCalls++; throw new Error('Anki must not be touched.'); },
      });
      const client = new Client({ name: 'anki-view-lifecycle-client', version: '0.1.0' });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return { server, client };
    };
    const first = await connect();
    let firstId;
    let secondId;
    let manuallyHiddenId;
    try {
      firstId = (await first.client.callTool({ name: 'show_anki_review', arguments: {} })).structuredContent.viewId;
      secondId = (await first.client.callTool({ name: 'show_anki_review', arguments: {} })).structuredContent.viewId;
      manuallyHiddenId = (await first.client.callTool({ name: 'show_anki_review', arguments: {} })).structuredContent.viewId;
      await recordShownView(lifecycleDir, { sessionId: 'session-a', turnId: 'turn-1', viewId: firstId });
      await recordShownView(lifecycleDir, { sessionId: 'session-a', turnId: 'turn-2', viewId: secondId });
      await markTurnViewsHidden(lifecycleDir, { sessionId: 'session-a', turnId: 'turn-1' });
      await first.client.callTool({ name: 'hide_anki_review', arguments: { viewId: manuallyHiddenId } });
      const get = (viewId) => first.client.callTool({ name: 'get_anki_view_state', arguments: { viewId } });
      assert.deepEqual((await get(firstId)).structuredContent, { viewId: firstId, hidden: true });
      assert.deepEqual((await get(secondId)).structuredContent, { viewId: secondId, hidden: false });
    } finally {
      await Promise.all([first.client.close(), first.server.close()]);
    }
    const restarted = await connect();
    try {
      const closed = await restarted.client.callTool({ name: 'get_anki_view_state', arguments: { viewId: firstId } });
      assert.deepEqual(closed.structuredContent, { viewId: firstId, hidden: true });
      const manuallyClosed = await restarted.client.callTool({ name: 'get_anki_view_state', arguments: { viewId: manuallyHiddenId } });
      assert.deepEqual(manuallyClosed.structuredContent, { viewId: manuallyHiddenId, hidden: true });
      const unrelated = await restarted.client.callTool({ name: 'get_anki_view_state', arguments: { viewId: secondId } });
      assert.equal(unrelated.isError, true);
      assert.equal(ankiCalls, 0);
    } finally {
      await Promise.all([restarted.client.close(), restarted.server.close()]);
    }
  });
});

test('a stopped view frees registry capacity even when its iframe never polls again', async () => {
  await withTempDir(async (directory) => {
    const lifecycleDir = path.join(directory, 'view-lifecycle');
    const server = new McpServer({ name: 'anki-view-capacity-test', version: '0.1.0' });
    registerAnkiReviewTools(server, {
      maxViews: 2,
      viewLifecycleDir: lifecycleDir,
      clientFactory: () => { throw new Error('Anki must not be accessed.'); },
    });
    const client = new Client({ name: 'anki-view-capacity-client', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const show = () => client.callTool({ name: 'show_anki_review', arguments: {} });
    try {
      const first = (await show()).structuredContent.viewId;
      const second = (await show()).structuredContent.viewId;
      await recordShownView(lifecycleDir, { sessionId: 'session-a', turnId: 'turn-1', viewId: first });
      await markTurnViewsHidden(lifecycleDir, { sessionId: 'session-a', turnId: 'turn-1' });
      // No get_anki_view_state call occurs for first: the iframe is gone.
      const third = await show();
      assert.equal(third.isError, undefined);
      assert.notEqual(third.structuredContent.viewId, first);
      assert.equal((await client.callTool({ name: 'get_anki_view_state', arguments: { viewId: second } })).structuredContent.hidden, false);
      assert.equal((await show()).isError, true, 'An unmarked visible view is never evicted to make room.');
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
