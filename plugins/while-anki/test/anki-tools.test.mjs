import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { ANKI_RESOURCE_URI, registerAnkiReviewTools } from '../anki-tools.mjs';

const SESSION = '12345678-1234-4123-8123-123456789abc';
const NONCE = '87654321-4321-4321-8321-cba987654321';
const card = { id: 'anki:42', type: 'flashcard', category: 'Languages', question: 'Front', answer: 'Back', media: { question: [], answer: [] } };
const firstView = { version: 1, sessionId: SESSION, deck: 'Languages', reviewed: 0, done: false, card, cardId: 42, nonce: NONCE, intervals: ['<1m', '<6m', '<10m', '4d'], remaining: 1, due: 1, fresh: 0 };
const doneView = { ...firstView, reviewed: 1, done: true, card: null, cardId: null, nonce: null, intervals: [], remaining: 0 };

test('Anki widget tools keep card data and simulated ratings in direct app calls', async () => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), 'anki-deck-test-'));
  const preferencesPath = path.join(temporaryDir, 'last-deck.json');
  const calls = [];
  const server = new McpServer({ name: 'anki-widget-tools-test', version: '0.1.0' });
  registerAnkiReviewTools(server, {
    clientFactory: ({ reviewWrites }) => ({
      reviewWrites,
      deckNames: async () => ['Languages'],
    }),
    dataDir: temporaryDir,
    preferencesPath,
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
    assert.equal(launch.structuredContent.status, 'ready');
    assert.match(launch.structuredContent.viewId, /^[0-9a-f-]{36}$/i);
    assert.equal(calls.length, 0, 'Launching the widget does not access or grade Anki.');

    const decks = await client.callTool({ name: 'list_anki_decks', arguments: {} });
    assert.deepEqual(decks.structuredContent, { decks: ['Languages'], lastUsedDeck: null });

    const started = await client.callTool({ name: 'start_anki_review', arguments: { deck: 'Languages' } });
    assert.equal(started.structuredContent.view.card.answer, 'Back');
    assert.equal(started.structuredContent.view.nonce, NONCE);
    assert.equal(JSON.stringify(started.structuredContent).includes('/private/ignored'), false, 'Private output paths stay on the server.');
    assert.equal(calls[0][1].client.reviewWrites, false);
    assert.equal(calls[0][1].sessionDir, path.join(temporaryDir, 'review-sessions'));
    assert.deepEqual((await client.callTool({ name: 'list_anki_decks', arguments: {} })).structuredContent, {
      decks: ['Languages'], lastUsedDeck: 'Languages',
    });

    const resumed = await client.callTool({ name: 'resume_anki_review', arguments: { sessionId: SESSION } });
    assert.equal(resumed.structuredContent.view.cardId, 42);

    const graded = await client.callTool({ name: 'rate_anki_review', arguments: { sessionId: SESSION, cardId: 42, nonce: NONCE, ease: 3 } });
    assert.equal(graded.structuredContent.recorded, true);
    assert.equal(graded.structuredContent.rating, 'Good');
    assert.equal(graded.structuredContent.view.done, true);
    assert.equal(calls[2][1].client.reviewWrites, true);
    assert.equal(calls[2][1].ease, 3);
    assert.equal(calls[2][1].nonce, NONCE);
    assert.equal(calls[2][1].sessionDir, path.join(temporaryDir, 'review-sessions'));
  } finally {
    await Promise.all([client.close(), server.close()]);
    await rm(temporaryDir, { recursive: true, force: true });
  }
});

test('last used deck survives server restart and changes only after successful review actions', async () => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), 'anki-deck-test-'));
  const preferencesPath = path.join(temporaryDir, 'private', 'last-deck.json');
  const decks = ['Languages', 'Science', 'Music'];
  let failStart = false;
  let failResume = false;
  let confirmRating = false;
  const server = new McpServer({ name: 'anki-deck-preference-test', version: '0.1.0' });
  registerAnkiReviewTools(server, {
    preferencesPath,
    clientFactory: () => ({ deckNames: async () => decks }),
    reviewApi: {
      startReview: async ({ deck }) => {
        if (failStart) throw new Error('Could not start.');
        return { view: { ...firstView, deck }, warnings: [] };
      },
      resumeReview: async () => {
        if (failResume) throw new Error('Could not resume.');
        return { view: { ...firstView, deck: 'Science' }, warnings: [] };
      },
      rateReview: async () => ({ recorded: confirmRating, view: { ...firstView, deck: 'Music' }, warnings: [] }),
    },
  });
  const client = new Client({ name: 'anki-deck-preference-client', version: '0.1.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const list = async () => (await client.callTool({ name: 'list_anki_decks', arguments: {} })).structuredContent.lastUsedDeck;
  try {
    assert.equal(await list(), null);
    await client.callTool({ name: 'start_anki_review', arguments: { deck: 'Languages' } });
    assert.equal(await list(), 'Languages');
    assert.deepEqual(JSON.parse(await readFile(preferencesPath, 'utf8')), { version: 1, deck: 'Languages' });
    assert.equal((await stat(preferencesPath)).mode & 0o777, 0o600);

    failStart = true;
    assert.equal((await client.callTool({ name: 'start_anki_review', arguments: { deck: 'Music' } })).isError, true);
    assert.equal(await list(), 'Languages');

    await client.callTool({ name: 'resume_anki_review', arguments: { sessionId: SESSION } });
    assert.equal(await list(), 'Science');
    failResume = true;
    assert.equal((await client.callTool({ name: 'resume_anki_review', arguments: { sessionId: SESSION } })).isError, true);
    assert.equal(await list(), 'Science');

    const ratingArgs = { sessionId: SESSION, cardId: 42, nonce: NONCE, ease: 3 };
    assert.equal((await client.callTool({ name: 'rate_anki_review', arguments: ratingArgs })).isError, true);
    assert.equal(await list(), 'Science');
    confirmRating = true;
    assert.equal((await client.callTool({ name: 'rate_anki_review', arguments: ratingArgs })).structuredContent.recorded, true);
    assert.equal(await list(), 'Music');
  } finally {
    await Promise.all([client.close(), server.close()]);
  }

  const restartedServer = new McpServer({ name: 'anki-deck-restart-test', version: '0.1.0' });
  registerAnkiReviewTools(restartedServer, { preferencesPath, clientFactory: () => ({ deckNames: async () => decks }) });
  const restartedClient = new Client({ name: 'anki-deck-restart-client', version: '0.1.0' });
  const [restartedServerTransport, restartedClientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([restartedServer.connect(restartedServerTransport), restartedClient.connect(restartedClientTransport)]);
  try {
    const listRestarted = async () => (await restartedClient.callTool({ name: 'list_anki_decks', arguments: {} })).structuredContent.lastUsedDeck;
    assert.equal(await listRestarted(), 'Music');
    await writeFile(preferencesPath, '{broken json', 'utf8');
    assert.equal(await listRestarted(), null, 'Malformed preferences are ignored.');
    await writeFile(preferencesPath, JSON.stringify({ version: 1, deck: 'Deleted deck' }), 'utf8');
    assert.equal(await listRestarted(), null, 'A deleted deck is not offered as the default.');
  } finally {
    await Promise.all([restartedClient.close(), restartedServer.close()]);
    await rm(temporaryDir, { recursive: true, force: true });
  }
});

test('a preference write failure does not hide an Anki-confirmed rating', async () => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), 'anki-deck-test-'));
  const server = new McpServer({ name: 'anki-deck-write-failure-test', version: '0.1.0' });
  registerAnkiReviewTools(server, {
    preferencesPath: temporaryDir, // An existing directory cannot be replaced by the preference file.
    clientFactory: () => ({}),
    reviewApi: {
      rateReview: async () => ({ recorded: true, view: firstView, warnings: [] }),
    },
  });
  const client = new Client({ name: 'anki-deck-write-failure-client', version: '0.1.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const graded = await client.callTool({
      name: 'rate_anki_review',
      arguments: { sessionId: SESSION, cardId: 42, nonce: NONCE, ease: 3 },
    });
    assert.equal(graded.isError, undefined);
    assert.equal(graded.structuredContent.recorded, true);
    assert.match(graded.structuredContent.warnings.join(' '), /Could not remember the last used deck/);
  } finally {
    await Promise.all([client.close(), server.close()]);
    await rm(temporaryDir, { recursive: true, force: true });
  }
});

test('hiding one view is idempotent and leaves other views and Anki untouched', async () => {
  let ankiCalls = 0;
  const server = new McpServer({ name: 'anki-view-state-test', version: '0.1.0' });
  registerAnkiReviewTools(server, {
    clientFactory: () => { ankiCalls++; throw new Error('Anki should not be accessed.'); },
    reviewApi: {
      startReview: async () => { ankiCalls++; throw new Error('Review should not start.'); },
      resumeReview: async () => { ankiCalls++; throw new Error('Review should not resume.'); },
      rateReview: async () => { ankiCalls++; throw new Error('Review should not be graded.'); },
    },
  });
  const client = new Client({ name: 'anki-view-state-test-client', version: '0.1.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.find((tool) => tool.name === 'get_anki_view_state')._meta.ui.visibility, ['app']);
    assert.equal(tools.tools.find((tool) => tool.name === 'hide_anki_review')._meta?.ui?.visibility, undefined);

    const first = (await client.callTool({ name: 'show_anki_review', arguments: {} })).structuredContent.viewId;
    const second = (await client.callTool({ name: 'show_anki_review', arguments: {} })).structuredContent.viewId;
    assert.notEqual(first, second);
    assert.deepEqual((await client.callTool({ name: 'get_anki_view_state', arguments: { viewId: first } })).structuredContent, { viewId: first, hidden: false });
    assert.deepEqual((await client.callTool({ name: 'get_anki_view_state', arguments: { viewId: second } })).structuredContent, { viewId: second, hidden: false });

    const hide = await client.callTool({ name: 'hide_anki_review', arguments: { viewId: first } });
    assert.deepEqual(hide.structuredContent, { viewId: first, hidden: true });
    const repeat = await client.callTool({ name: 'hide_anki_review', arguments: { viewId: first } });
    assert.deepEqual(repeat.structuredContent, hide.structuredContent);
    assert.equal((await client.callTool({ name: 'get_anki_view_state', arguments: { viewId: first } })).structuredContent.hidden, true);
    assert.equal((await client.callTool({ name: 'get_anki_view_state', arguments: { viewId: second } })).structuredContent.hidden, false);

    const unknown = await client.callTool({ name: 'hide_anki_review', arguments: { viewId: SESSION } });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent, undefined);
    const malformed = await client.callTool({ name: 'get_anki_view_state', arguments: { viewId: 'not-a-uuid' } });
    assert.equal(malformed.isError, true);
    assert.equal(ankiCalls, 0);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('auto-show setting is saved through app-only tools without contacting Anki', async () => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), 'anki-autoshow-test-'));
  const autoShowSettingsPath = path.join(temporaryDir, 'private', 'auto-show.json');
  let ankiCalls = 0;
  const createServer = () => {
    const server = new McpServer({ name: 'anki-autoshow-test', version: '0.1.0' });
    registerAnkiReviewTools(server, {
      autoShowSettingsPath,
      clientFactory: () => { ankiCalls++; throw new Error('Anki should not be accessed.'); },
    });
    return server;
  };
  const connect = async (server) => {
    const client = new Client({ name: 'anki-autoshow-test-client', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };

  const firstServer = createServer();
  const firstClient = await connect(firstServer);
  try {
    const listed = await firstClient.listTools();
    for (const name of ['get_anki_autoshow', 'set_anki_autoshow']) {
      assert.deepEqual(listed.tools.find((tool) => tool.name === name)._meta.ui.visibility, ['app']);
    }
    assert.deepEqual((await firstClient.callTool({ name: 'get_anki_autoshow', arguments: {} })).structuredContent, { mode: 'off' });
    for (const mode of ['long_tasks', 'every_message', 'off']) {
      const saved = await firstClient.callTool({ name: 'set_anki_autoshow', arguments: { mode } });
      assert.deepEqual(saved.structuredContent, { mode });
      assert.deepEqual((await firstClient.callTool({ name: 'get_anki_autoshow', arguments: {} })).structuredContent, { mode });
    }
    const invalid = await firstClient.callTool({ name: 'set_anki_autoshow', arguments: { mode: 'always' } });
    assert.equal(invalid.isError, true);
    assert.deepEqual((await firstClient.callTool({ name: 'get_anki_autoshow', arguments: {} })).structuredContent, { mode: 'off' });
    await firstClient.callTool({ name: 'set_anki_autoshow', arguments: { mode: 'every_message' } });
  } finally {
    await Promise.all([firstClient.close(), firstServer.close()]);
  }

  const secondServer = createServer();
  const secondClient = await connect(secondServer);
  try {
    assert.deepEqual((await secondClient.callTool({ name: 'get_anki_autoshow', arguments: {} })).structuredContent, { mode: 'every_message' });
    assert.equal(ankiCalls, 0);
  } finally {
    await Promise.all([secondClient.close(), secondServer.close()]);
    await rm(temporaryDir, { recursive: true, force: true });
  }
});

test('the view registry stays bounded without evicting a visible view', async () => {
  let time = 0;
  const server = new McpServer({ name: 'anki-view-pruning-test', version: '0.1.0' });
  registerAnkiReviewTools(server, { now: () => time, maxViews: 2 });
  const client = new Client({ name: 'anki-view-pruning-test-client', version: '0.1.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const show = () => client.callTool({ name: 'show_anki_review', arguments: {} });
  const get = (viewId) => client.callTool({ name: 'get_anki_view_state', arguments: { viewId } });
  try {
    const first = (await show()).structuredContent.viewId;
    const second = (await show()).structuredContent.viewId;
    assert.equal((await show()).isError, true, 'A third view cannot evict either visible view.');
    assert.equal((await get(first)).structuredContent.hidden, false);
    assert.equal((await get(second)).structuredContent.hidden, false);

    await client.callTool({ name: 'hide_anki_review', arguments: { viewId: first } });
    const third = (await show()).structuredContent.viewId;
    assert.equal((await get(first)).isError, true, 'A hidden view can be pruned to make room.');
    assert.equal((await get(second)).structuredContent.hidden, false);
    assert.equal((await get(third)).structuredContent.hidden, false);

    await client.callTool({ name: 'hide_anki_review', arguments: { viewId: second } });
    time += 60 * 60 * 1000 + 1;
    assert.equal((await get(second)).isError, true, 'Hidden entries expire after one hour.');
    assert.equal((await get(third)).structuredContent.hidden, false);
    const fourth = (await show()).structuredContent.viewId;
    assert.notEqual(fourth, third);

    time += 23 * 60 * 60 * 1000;
    assert.equal((await get(third)).structuredContent.hidden, false, 'Polling keeps a visible view alive.');
    time += 2 * 60 * 60 * 1000;
    assert.equal((await get(third)).structuredContent.hidden, false);
    assert.equal((await get(fourth)).isError, true, 'An unpolled visible view expires after one idle day.');
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
