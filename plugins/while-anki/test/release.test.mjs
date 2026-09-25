import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('release runs from an isolated plugin folder without source, node_modules, or the repository', async () => {
  const isolated = await mkdtemp(path.join(os.tmpdir(), 'while-anki-release-'));
  const assets = path.join(isolated, 'assets');
  await mkdir(assets);
  await Promise.all([
    copyFile(path.join(ROOT, 'server.bundle.mjs'), path.join(isolated, 'server.bundle.mjs')),
    copyFile(path.join(ROOT, 'anki-widget.html'), path.join(isolated, 'anki-widget.html')),
    copyFile(path.join(ROOT, 'assets', 'anki-widget.js'), path.join(assets, 'anki-widget.js')),
  ]);

  const client = new Client({ name: 'while-anki-release-test', version: '0.4.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(isolated, 'server.bundle.mjs')],
    cwd: isolated,
    env: { ...process.env, WHILE_ANKI_DATA_DIR: isolated },
    stderr: 'pipe',
  });
  const stderr = [];
  transport.stderr.on('data', (chunk) => stderr.push(chunk));
  try {
    await client.connect(transport).catch((error) => {
      throw new Error(`Isolated release failed: ${Buffer.concat(stderr).toString('utf8')}`, { cause: error });
    });
    const tools = await client.listTools();
    const show = tools.tools.find(({ name }) => name === 'show_anki_review');
    assert.ok(show, 'release exposes the Anki launcher');
    assert.deepEqual(tools.tools.find(({ name }) => name === 'get_anki_autoshow')._meta.ui.visibility, ['app']);
    assert.deepEqual(tools.tools.find(({ name }) => name === 'set_anki_autoshow')._meta.ui.visibility, ['app']);
    assert.equal(tools.tools.some(({ name }) => name === 'show_probe' || name === 'increment_probe'), false);
    const resource = await client.readResource({ uri: show._meta.ui.resourceUri });
    assert.match(resource.contents[0].text, /Show answer/);
    assert.doesNotMatch(resource.contents[0].text, /__ANKI_BUNDLE__/);

    const setting = await client.callTool({ name: 'get_anki_autoshow', arguments: {} });
    assert.deepEqual(setting.structuredContent, { mode: 'off' });

    const opened = await client.callTool({ name: 'show_anki_review', arguments: {} });
    assert.equal(opened.structuredContent.status, 'ready');
    const closed = await client.callTool({
      name: 'hide_anki_review',
      arguments: { viewId: opened.structuredContent.viewId },
    });
    assert.equal(closed.structuredContent.hidden, true);
  } finally {
    await client.close().catch(() => {});
    await rm(isolated, { recursive: true, force: true });
  }
});
