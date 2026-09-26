import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAnkiConnect, deckQuery, validateAnkiUrl } from '../lib/anki-connect.mjs';

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

test('review writes require an explicit client and contain one validated Anki grade', async (t) => {
  const { client, calls } = await fakeAnki(t, (message, res) => reply(res,
    message.action === 'answerCards' ? [true] : { 42: [{ id: 1234, ease: 3 }] }), { reviewWrites: true });
  await assert.rejects(client.invoke('sync'), { code: 'READ_ONLY' });
  await assert.rejects(client.answerCard(42, 5), /rating from 1 to 4/);
  assert.equal(await client.answerCard(42, 3), true);
  assert.deepEqual(calls[0], { action: 'answerCards', version: 6, params: { answers: [{ cardId: 42, ease: 3 }] } });
  assert.deepEqual(await client.reviewHistory(42), [{ id: 1234, ease: 3 }]);
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

test('deck searches escape special characters and reject invalid names', () => {
  assert.equal(deckQuery('Parent::Child'), 'deck:"Parent::Child"');
  for (const character of ['"', '*', '_', String.fromCharCode(92)]) {
    assert.equal(deckQuery(character), 'deck:"' + String.fromCharCode(92) + character + '"');
  }
  for (const value of ['', ' ', null, 'x'.repeat(1001), 'deck\nname']) {
    assert.throws(() => deckQuery(value), /valid Anki deck name/);
  }
});
