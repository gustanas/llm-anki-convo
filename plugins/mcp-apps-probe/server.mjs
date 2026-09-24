import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { ANKI_RESOURCE_URI, registerAnkiReviewTools } from './anki-tools.mjs';

export const RESOURCE_URI = 'ui://mcp-apps-probe/counter.html';
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createProbeServer() {
  const server = new McpServer({ name: 'While Anki', version: '0.1.0' });
  let count = 0;

  registerAnkiReviewTools(server);

  registerAppTool(server, 'show_probe', {
    title: 'Show MCP Apps probe',
    description: 'Display a harmless counter to test whether this Codex client renders MCP Apps UI.',
    inputSchema: z.object({}),
    outputSchema: z.object({ count: z.number().int().nonnegative() }),
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, async () => ({
    content: [{ type: 'text', text: `Probe counter: ${count}` }],
    structuredContent: { count },
  }));

  registerAppTool(server, 'increment_probe', {
    title: 'Increment MCP Apps probe',
    description: 'Increment the in-memory test counter by one. This does not access Anki or files.',
    inputSchema: z.object({}),
    outputSchema: z.object({ count: z.number().int().nonnegative() }),
    _meta: { ui: { visibility: ['app'] } },
  }, async () => {
    count += 1;
    return {
      content: [{ type: 'text', text: `Probe counter: ${count}` }],
      structuredContent: { count },
    };
  });

  registerAppResource(server, 'MCP Apps probe UI', RESOURCE_URI, {}, async () => {
    const [template, bundle] = await Promise.all([
      readFile(path.join(HERE, 'widget.html'), 'utf8'),
      readFile(path.join(HERE, 'dist', 'widget.js'), 'utf8'),
    ]);
    const html = template.replace('__PROBE_BUNDLE__', () => bundle.replaceAll('</script', '<\\/script'));
    return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }] };
  });

  registerAppResource(server, 'Inline Anki review UI', ANKI_RESOURCE_URI, {}, async () => {
    const [template, bundle] = await Promise.all([
      readFile(path.join(HERE, 'anki-widget.html'), 'utf8'),
      readFile(path.join(HERE, 'dist', 'anki-widget.js'), 'utf8'),
    ]);
    const html = template.replace('__ANKI_BUNDLE__', () => bundle.replaceAll('</script', '<\\/script'));
    return {
      contents: [{
        uri: ANKI_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
        _meta: { 'openai/widgetMinFrameHeight': 1 },
      }],
    };
  });

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createProbeServer().connect(new StdioServerTransport());
}
