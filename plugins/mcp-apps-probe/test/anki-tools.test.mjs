import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { ANKI_RESOURCE_URI, registerAnkiReviewTools } from '../anki-tools.mjs';

const SESSION = '12345678-1234-4123-8123-123456789abc';
const NONCE = '87654321-4321-4321-8321-cba987654321';
const card = { id: 'anki:42', type: 'flashcard', category: 'Languages', question: 'Front', answer: 'Back', media: { question: [], answer: [] } };
const firstView = { version: 1, sessionId: SESSION, deck: 'Languages', reviewed: 0, done: false, card, cardId: 42, nonce: NONCE, intervals: ['<1m', '<6m', '<10m', '4d'], remaining: 1, due: 1, fresh: 0 };
const doneView = { ...firstView, reviewed: 1, done: true, card: null, cardId: null, nonce: null, intervals: [], remaining: 0 };

test('Anki widget tools keep card data and simulated ratings in direct app calls', async () => {
  const calls = [];
  const server = new McpServer({ name: 'anki-widget-tools-test', version: '0.1.0' });
  registerAnkiReviewTools(server, {
    clientFactory: ({ reviewWrites }) => ({
      reviewWrites,
      deckNames: async () => ['Languages'],
    }),
    outputDir: '/private/ignored/dist',
    reviewApi: {
      startReview: async (args) => { calls.push(['start', args]); return { path: '/private/ignored/dist/card.html', view: firstView, warnings: [] }; },
      resumeReview: async (args) => { calls.push(['resume', args]); return { path: '/private/ignored/dist/card.html', view: firstView, warnings: [] }; },
      rateReview: async (args) => { calls.push(['rate', args]); return { path: '/private/ignored/dist/done.html', recorded: true, view: doneView, warnings: [] }; },
    },
  });
  const client = new Client({ name: 'anki-widget-tools-test-client', version: '0.1.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.find((tool) => tool.name === 'show_anki_review')._meta.ui.resourceUri, ANKI_RESOURCE_URI);
    for (const name of ['list_anki_decks', 'start_anki_review', 'resume_anki_review', 'rate_anki_review']) {
      assert.deepEqual(listed.tools.find((tool) => tool.name === name)._meta.ui.visibility, ['app']);
    }
    const launch = await client.callTool({ name: 'show_anki_review', arguments: {} });
    assert.deepEqual(launch.structuredContent, { status: 'ready' });
    assert.equal(calls.length, 0, 'Launching the widget does not access or grade Anki.');

    const decks = await client.callTool({ name: 'list_anki_decks', arguments: {} });
    assert.deepEqual(decks.structuredContent, { decks: ['Languages'] });

    const started = await client.callTool({ name: 'start_anki_review', arguments: { deck: 'Languages' } });
    assert.equal(started.structuredContent.view.card.answer, 'Back');
    assert.equal(started.structuredContent.view.nonce, NONCE);
    assert.equal(JSON.stringify(started.structuredContent).includes('/private/ignored'), false, 'Private output paths stay on the server.');
    assert.equal(calls[0][1].client.reviewWrites, false);

    const resumed = await client.callTool({ name: 'resume_anki_review', arguments: { sessionId: SESSION } });
    assert.equal(resumed.structuredContent.view.cardId, 42);

    const graded = await client.callTool({ name: 'rate_anki_review', arguments: { sessionId: SESSION, cardId: 42, nonce: NONCE, ease: 3 } });
    assert.equal(graded.structuredContent.recorded, true);
    assert.equal(graded.structuredContent.rating, 'Good');
    assert.equal(graded.structuredContent.view.done, true);
    assert.equal(calls[2][1].client.reviewWrites, true);
    assert.equal(calls[2][1].ease, 3);
    assert.equal(calls[2][1].nonce, NONCE);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('a failed review tool response never reports the rating as saved', async () => {
  const server = new McpServer({ name: 'anki-widget-error-test', version: '0.1.0' });
  let returnUnconfirmed = false;
  registerAnkiReviewTools(server, {
    clientFactory: () => ({}),
    reviewApi: {
      startReview: async () => { throw new Error('Unavailable'); },
      resumeReview: async () => { throw new Error('Unavailable'); },
      rateReview: async () => {
        if (returnUnconfirmed) return { recorded: false, view: firstView, warnings: [] };
        throw new Error('Anki did not confirm the new review.');
      },
    },
  });
  const client = new Client({ name: 'anki-widget-error-test-client', version: '0.1.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const failed = await client.callTool({ name: 'rate_anki_review', arguments: { sessionId: SESSION, cardId: 42, nonce: NONCE, ease: 3 } });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent, undefined);
    assert.match(failed.content[0].text, /did not confirm/);
    returnUnconfirmed = true;
    const unconfirmed = await client.callTool({ name: 'rate_anki_review', arguments: { sessionId: SESSION, cardId: 42, nonce: NONCE, ease: 3 } });
    assert.equal(unconfirmed.isError, true);
    assert.equal(unconfirmed.structuredContent, undefined);
    assert.match(unconfirmed.content[0].text, /did not confirm/);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
