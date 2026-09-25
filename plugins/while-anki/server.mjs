import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { ANKI_RESOURCE_URI, registerAnkiReviewTools } from './anki-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createWhileAnkiServer() {
  const server = new McpServer({ name: 'While Anki', version: '0.4.1' });

  registerAnkiReviewTools(server);

  registerAppResource(server, 'Inline Anki review UI', ANKI_RESOURCE_URI, {}, async () => {
    const [template, bundle] = await Promise.all([
      readFile(path.join(HERE, 'anki-widget.html'), 'utf8'),
      readFile(path.join(HERE, 'assets', 'anki-widget.js'), 'utf8'),
    ]);
    const html = template.replace('__ANKI_BUNDLE__', () => bundle.replaceAll('</script', '<\\/script'));
    return {
      contents: [{
        uri: ANKI_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
        _meta: {
          'openai/widgetMinFrameHeight': 1,
          ui: { csp: { resourceDomains: ['blob:', 'data:'] } },
        },
      }],
    };
  });

  return server;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await createWhileAnkiServer().connect(new StdioServerTransport());
}
