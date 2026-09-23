import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnkiConnect, deckQuery, pullCards, validateAnkiUrl } from '../lib/anki-connect.mjs';
import { parseArgs } from '../scripts/anki.mjs';

async function fakeAnki(t, handler, options = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(message);
      handler(message, res);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, server, client: createAnkiConnect({ url, apiKey: '', ...options }) };
}

const reply = (res, result, error = null) => res.end(JSON.stringify({ result, error }));
const card = (cardId, deckName = 'Test') => ({ cardId, deckName, queue: 0, fields: { Front: { value: `Card ${cardId}`, order: 0 } }, question: '<b>Raw front</b>', answer: '<b>Raw back</b>' });

test('endpoints stay on loopback and never include credentials or a remote URL', () => {
  assert.equal(validateAnkiUrl('http://localhost:8765').hostname, '127.0.0.1');
  assert.equal(validateAnkiUrl('http://[::1]:8765').hostname, '[::1]');
  for (const url of ['https://127.0.0.1:8765', 'http://example.com:8765', 'http://127.0.0.1.evil:8765', 'http://user:secret@127.0.0.1:8765', 'http://127.0.0.1:8765/path', 'http://127.0.0.1:8765/?key=secret']) {
    assert.throws(() => createAnkiConnect({ url }), (error) => error.code === 'INVALID_URL' && !error.message.includes('secret'));
  }
});

test('API v6 messages authenticate locally and write actions never reach Anki', async (t) => {
  const { client, calls } = await fakeAnki(t, (message, res) => reply(res, message.action === 'version' ? 6 : false), { apiKey: 'test-only-key' });
  assert.equal(await client.version(), 6);
  assert.deepEqual(calls[0], { action: 'version', version: 6, params: {}, key: 'test-only-key' });
  await assert.rejects(client.invoke('answerCards', { answers: [] }), { code: 'READ_ONLY' });
  await assert.rejects(client.invoke('sync'), { code: 'READ_ONLY' });
  assert.equal(calls.length, 1);
  assert.equal(await client.retrieveMediaFile('missing.mp3'), false);
  await assert.rejects(client.retrieveMediaFile('../outside.mp3'), /without a directory/);
  await assert.rejects(client.cardsInfo(Array.from({ length: 101 }, (_, index) => index + 1)), /at most 100/);
  assert.equal(calls.length, 2);
});

test('API errors redact keys and invalid responses do not become fabricated results', async (t) => {
  let step = 0;
  const { client } = await fakeAnki(t, (_, res) => {
    step += 1;
    if (step === 1) reply(res, null, 'Rejected secret-value while reading');
    else if (step === 2) reply(res, null, 'valid api key must be provided');
    else if (step === 3) res.end('<html>Another service</html>');
    else res.end(JSON.stringify({ result: [] }));
  }, { apiKey: 'secret-value' });
  await assert.rejects(client.version(), (error) => error.code === 'API_ERROR' && !error.message.includes('secret-value') && error.message.includes('[redacted]'));
  await assert.rejects(client.version(), (error) => error.code === 'AUTH_ERROR' && error.message.includes('ANKI_CONNECT_KEY'));
  await assert.rejects(client.version(), { code: 'INVALID_RESPONSE' });
  await assert.rejects(client.version(), { code: 'INVALID_RESPONSE' });
});

test('blocked Anki and oversized responses fail within bounded limits', async (t) => {
  const stalled = await fakeAnki(t, () => {}, { timeoutMs: 30 });
  await assert.rejects(stalled.client.version(), (error) => error.code === 'TIMEOUT' && error.message.includes('dialog'));
  const oversized = await fakeAnki(t, (_, res) => reply(res, 'x'.repeat(256)), { maxResponseBytes: 80 });
  await assert.rejects(oversized.client.version(), { code: 'TOO_LARGE' });
});

test('a non-200 streaming response closes its socket after rejection', async (t) => {
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const { client } = await fakeAnki(t, (_, res) => {
    res.on('close', resolveClosed);
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.write('Service unavailable; this body intentionally never ends.');
  });
  await assert.rejects(client.version(), { code: 'HTTP_ERROR' });
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Rejected response kept its socket open.')), 500); }),
    ]);
  } finally { clearTimeout(timer); }
});

test('closed Anki gives a useful connection error', async (t) => {
  const { client, server } = await fakeAnki(t, (_, res) => reply(res, 6));
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(client.version(), (error) => error.code === 'CONNECTION_ERROR' && error.message.includes('Open Anki') && error.message.includes('restart Anki'));
});

test('pull prioritizes due then new cards and fetches only bounded batches', async () => {
  const queries = [];
  const batches = [];
  const client = {
    version: async () => 6,
    deckNames: async () => ['Test'],
    findCards: async (query) => {
      queries.push(query);
      return query.endsWith('is:due') ? Array.from({ length: 27 }, (_, index) => index + 1) : Array.from({ length: 30 }, (_, index) => index + 20);
    },
    cardsInfo: async (ids) => { batches.push(ids); return ids.map((id) => card(id)).reverse(); },
  };
  const snapshot = await pullCards({ client, deck: 'Test', limit: 30 });
  assert.deepEqual(snapshot.selection, { due: 27, new: 3, other: 0 });
  assert.deepEqual(snapshot.cards.map((item) => item.cardId), Array.from({ length: 30 }, (_, index) => index + 1));
  assert.deepEqual(batches.map((ids) => ids.length), [25, 5]);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query) => query.includes('-is:suspended -is:buried')));
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(snapshot.cards[0].question, '<b>Raw front</b>');
});

test('fallback is explicit, duplicate IDs are removed, and unavailable cards are excluded', async () => {
  const deck = 'Test "quoted"_*\\deck';
  const queries = [];
  const snapshot = await pullCards({ deck, limit: 4, client: {
    version: async () => 6,
    deckNames: async () => [deck],
    findCards: async (query) => {
      queries.push(query);
      return queries.length === 1 ? [1] : queries.length === 2 ? [1, 2] : [2, 3, 4, 5];
    },
    cardsInfo: async () => [card(1, deck), { ...card(2, deck), queue: -1 }, card(3, `${deck}::Child`), {}, card(999, deck), card(3, deck)],
  } });
  assert.deepEqual(snapshot.cards.map((item) => item.cardId), [1, 3]);
  assert.deepEqual(snapshot.selection, { due: 1, new: 0, other: 1 });
  assert.equal(snapshot.warnings.length, 2);
  assert.match(snapshot.warnings.join(' '), /other available card/);
  assert.ok(queries.every((query) => query.startsWith(`${deckQuery(deck)} `)));
  assert.equal(deckQuery(deck), 'deck:"Test \\"quoted\\"\\_\\*\\\\deck"');
});

test('missing decks and unavailable APIs stop before requesting cards', async () => {
  const client = { version: async () => 6, deckNames: async () => [], findCards: async () => assert.fail('Must not fetch an unknown deck') };
  await assert.rejects(pullCards({ client, deck: 'Unknown' }), { code: 'DECK_NOT_FOUND' });
  await assert.rejects(pullCards({ client: { ...client, version: async () => 5 }, deck: 'Unknown' }), { code: 'OLD_VERSION' });
  await assert.rejects(pullCards({ client, deck: 'Unknown', limit: 101 }), /between 1 and 100/);
});

test('CLI private snapshots default to ignored dist and cannot escape it', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const options = parseArgs(['pull', '--deck', 'Test']);
  assert.equal(options.output, path.join(root, 'dist', 'anki-raw.json'));
  assert.equal(options.limit, 10);
  assert.deepEqual(parseArgs(['decks']), { command: 'decks' });
  assert.throws(() => parseArgs(['pull', '--deck', 'Test', '--output', path.join(root, 'data', 'private.json')]), /ignored dist/);
  assert.throws(() => parseArgs(['pull', '--deck', 'Test', '--output', `${root}dist/../private.json`]), /ignored dist/);
  assert.throws(() => parseArgs(['pull', '--deck', 'Test', '--limit', '0']), /between 1 and 100/);
});
