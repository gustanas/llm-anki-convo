import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { RESOURCE_URI } from '../server.mjs';
import { ANKI_RESOURCE_URI } from '../anki-tools.mjs';

test('counter tool returns updated state and an MCP Apps resource without touching Anki', async () => {
  const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const client = new Client({ name: 'mcp-apps-probe-test', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pluginDir, 'server.mjs')] });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.find((tool) => tool.name === 'show_probe')._meta.ui.resourceUri, RESOURCE_URI);
    assert.equal(tools.tools.find((tool) => tool.name === 'show_anki_review')._meta.ui.resourceUri, ANKI_RESOURCE_URI);
    const first = await client.callTool({ name: 'show_probe', arguments: {} });
    assert.equal(first.structuredContent.count, 0);
    const incremented = await client.callTool({ name: 'increment_probe', arguments: {} });
    assert.equal(incremented.structuredContent.count, 1);
    const second = await client.callTool({ name: 'show_probe', arguments: {} });
    assert.equal(second.structuredContent.count, 1);
    const resource = await client.readResource({ uri: RESOURCE_URI });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.contents[0].text, /MCP Apps quiet-action probe/);
    assert.doesNotMatch(resource.contents[0].text, /sendFollowUpMessage|AnkiConnect|answerCards/);
    const ankiResource = await client.readResource({ uri: ANKI_RESOURCE_URI });
    assert.equal(ankiResource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.doesNotMatch(ankiResource.contents[0].text, /__ANKI_BUNDLE__/);
    assert.match(ankiResource.contents[0].text, /Show answer/);
  } finally {
    await client.close();
  }
});
