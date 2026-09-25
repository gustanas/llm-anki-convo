import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startReview, resumeReview, rateReview } from '../anki-review-runtime.mjs';
import { resolveAnkiDataDir } from '../anki-tools.mjs';

function fakeClient() {
  const cards = new Map([1, 2].map((cardId) => [cardId, {
    cardId, deckName: 'Languages', queue: 0, reps: 0, fields: {},
    question: `<b>Front ${cardId}</b>`, answer: `<b>Back ${cardId}</b>`,
    nextReviews: ['<1m', '<6m', '<10m', '4d'],
  }]));
  const history = new Map();
  const answers = [];
  let uncertain = false;
  return {
    cards, answers,
    interruptAfterSave() { uncertain = true; },
    deckNames: async () => ['Languages'],
    findCards: async (query) => {
      const id = query.match(/(?:^|\s)cid:(\d+)(?:\s|$)/)?.[1];
      return [...cards.values()].filter((card) =>
        (card.deckName === 'Languages' || card.deckName.startsWith('Languages::')) &&
        card.queue >= 0 && (!id || card.cardId === Number(id)) &&
        (query.endsWith('is:new') ? card.queue === 0
          : query.endsWith('is:due') ? (card.queue === 1 || card.queue === 2) && card.dueNow === true
            : false)).map((card) => card.cardId);
    },
    cardsInfo: async (ids) => ids.map((id) => cards.get(id)).filter(Boolean),
    retrieveMediaFile: async () => false,
    answerCard: async (id, ease) => {
      answers.push([id, ease]);
      const card = cards.get(id);
      card.reps++;
      card.queue = 2;
      card.dueNow = false;
      history.set(id, [{ id: Date.now(), ease }]);
      if (uncertain) { uncertain = false; throw new Error('Connection interrupted after Anki saved it.'); }
      return true;
    },
    reviewHistory: async (id) => history.get(id) ?? [],
  };
}

test('portable review persists private sessions and records each rating once', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  assert.equal(first.view.cardId, 1);
  assert.equal(first.view.card.question, 'Front 1');
  assert.equal(first.view.card.answer, 'Back 1');
  assert.equal(first.path, undefined, 'The MCP App does not write a private HTML copy of every card.');
  assert.deepEqual(await readdir(sessionDir), [`${first.sessionId}.json`]);
  assert.equal((await stat(sessionDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(sessionDir, `${first.sessionId}.json`))).mode & 0o777, 0o600);
  assert.equal((await readFile(path.join(sessionDir, `${first.sessionId}.json`), 'utf8')).includes('Front 1'), false);

  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 };
  const second = await rateReview(args);
  assert.equal(second.recorded, true);
  assert.equal(second.view.cardId, 2);
  assert.deepEqual(client.answers, [[1, 3]]);
  assert.equal((await rateReview(args)).view.cardId, 2);
  assert.deepEqual(client.answers, [[1, 3]], 'A duplicate button action does not grade twice.');
  assert.equal((await resumeReview({ client, sessionDir, sessionId: first.sessionId })).view.cardId, 2);
});

test('portable review never writes a second grade when Anki saved a rating but its response was lost', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  client.interruptAfterSave();
  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 1 };
  await assert.rejects(rateReview(args), /Connection interrupted/);
  const resumed = await rateReview(args);
  assert.equal(resumed.recorded, false, 'Anki changed, but a lost answerCards response cannot prove whose grade it was.');
  assert.equal(resumed.view.cardId, 2);
  assert.equal(resumed.view.reviewed, 0);
  assert.match(resumed.warnings.join(' '), /cannot be attributed/);
  assert.deepEqual(client.answers, [[1, 1]]);
});

test('an unacknowledged request cannot be resent while Anki may still apply it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  let attempts = 0;
  let applyLateReview;
  client.answerCard = async (id, ease) => {
    attempts++;
    applyLateReview = () => {
      client.cards.get(id).reps++;
      client.cards.get(id).queue = 2;
      client.answers.push([id, ease]);
    };
    throw new Error('AnkiConnect timed out before the response arrived.');
  };
  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 };
  await assert.rejects(rateReview(args), /timed out/);
  const sessionFile = path.join(sessionDir, `${first.sessionId}.json`);
  const pending = JSON.parse(await readFile(sessionFile, 'utf8')).pending;
  assert.ok(Number.isSafeInteger(pending.attemptedAt));
  assert.equal(pending.answerReturned, false);

  await assert.rejects(rateReview(args), /may still finish in Anki.*No second grade was sent/);
  assert.equal(attempts, 1, 'An unchanged reps count does not prove the timed-out request was cancelled.');
  assert.deepEqual(client.answers, []);
  assert.deepEqual(JSON.parse(await readFile(sessionFile, 'utf8')).pending, pending, 'The uncertain receipt remains for later reconciliation.');

  applyLateReview();
  const refreshed = await rateReview(args);
  assert.equal(refreshed.recorded, false);
  assert.equal(refreshed.view.cardId, 2);
  assert.equal(attempts, 1);
  assert.deepEqual(client.answers, [[1, 3]]);
});

test('an externally graded card refreshes on resume without repeating a stale-card error', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  client.cards.get(1).reps++;
  client.cards.get(1).queue = 2;

  const resumed = await resumeReview({ client, sessionId: first.sessionId, sessionDir });
  assert.equal(resumed.view.cardId, 2);
  assert.equal(resumed.view.reviewed, 0, 'The externally saved review is not counted as this session’s grade.');
  assert.notEqual(resumed.view.nonce, first.view.nonce);
  assert.match(resumed.warnings.join(' '), /changed in Anki.*no rating was saved here/i);
  assert.deepEqual(client.answers, []);
  assert.equal((await resumeReview({ client, sessionId: first.sessionId, sessionDir })).view.cardId, 2);
});

test('rating after an external grade returns a refreshed view and never writes another grade', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  client.cards.get(1).reps++;
  client.cards.get(1).queue = 2;

  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 };
  const refreshed = await rateReview(args);
  assert.equal(refreshed.recorded, false);
  assert.equal(refreshed.view.cardId, 2);
  assert.match(refreshed.warnings.join(' '), /No rating was sent here/);
  assert.deepEqual(client.answers, []);
  const saved = JSON.parse(await readFile(path.join(sessionDir, `${first.sessionId}.json`), 'utf8'));
  assert.equal(saved.pending, null);
  assert.equal(saved.lastReceipt, null);
  await assert.rejects(rateReview(args), /no longer the active review/);
});

test('a changed card that is still due gets a fresh nonce and its current Anki state', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  client.cards.get(1).reps++;
  client.cards.get(1).question = 'Updated in Anki';

  const resumed = await resumeReview({ client, sessionId: first.sessionId, sessionDir });
  assert.equal(resumed.view.cardId, 1);
  assert.equal(resumed.view.card.question, 'Updated in Anki');
  assert.notEqual(resumed.view.nonce, first.view.nonce);
  assert.deepEqual(client.answers, []);
});

test('rescheduling an active card to the future refreshes resume and rating without grading it', async (t) => {
  for (const action of ['resume', 'rate']) {
    const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sessionDir = path.join(root, 'review-sessions');
    const client = fakeClient();
    client.cards.get(1).queue = 2;
    client.cards.get(1).dueNow = true;
    const first = await startReview({ client, deck: 'Languages', sessionDir });
    assert.equal(first.view.cardId, 1, 'A due review remains eligible before rescheduling.');
    client.cards.get(1).dueNow = false;
    const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 };
    const result = action === 'resume'
      ? await resumeReview({ client, sessionDir, sessionId: first.sessionId }) : await rateReview(args);
    if (action === 'rate') assert.equal(result.recorded, false);
    assert.equal(result.view.cardId, 2);
    assert.equal(result.view.reviewed, 0);
    assert.deepEqual(client.answers, []);
  }
});

test('a card rescheduled between rating preflight and send is not graded', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  const originalInfo = client.cardsInfo;
  let cardReads = 0;
  client.cardsInfo = async (ids) => {
    if (ids.length === 1 && ids[0] === 1 && ++cardReads === 2) {
      client.cards.get(1).queue = 2;
      client.cards.get(1).dueNow = false;
    }
    return originalInfo(ids);
  };
  const result = await rateReview({ client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 });
  assert.equal(result.recorded, false);
  assert.equal(result.view.cardId, 2);
  assert.match(result.warnings.join(' '), /no longer due or new/);
  assert.deepEqual(client.answers, []);
});

test('an eligibility-search error prevents a rating write', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  const originalFind = client.findCards;
  client.findCards = async (query) => {
    if (query.includes('cid:1')) throw new Error('Eligibility search interrupted.');
    return originalFind(query);
  };
  await assert.rejects(rateReview({ client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 }), /Eligibility search interrupted/);
  assert.deepEqual(client.answers, []);
});

test('moved and suspended cards are skipped before a rating is sent', async (t) => {
  for (const change of [
    (card) => { card.deckName = 'Different deck'; },
    (card) => { card.queue = -1; },
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sessionDir = path.join(root, 'review-sessions');
    const client = fakeClient();
    const first = await startReview({ client, deck: 'Languages', sessionDir });
    change(client.cards.get(1));
    const refreshed = await rateReview({ client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 });
    assert.equal(refreshed.recorded, false);
    assert.equal(refreshed.view.cardId, 2);
    assert.deepEqual(client.answers, []);
  }
});

test('a successful Anki response is retained if reading the updated card is interrupted', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  const originalAnswer = client.answerCard;
  const originalInfo = client.cardsInfo;
  let failNextInfo = false;
  client.answerCard = async (...args) => {
    const result = await originalAnswer(...args);
    failNextInfo = true;
    return result;
  };
  client.cardsInfo = async (...args) => {
    if (failNextInfo) { failNextInfo = false; throw new Error('Card fetch interrupted.'); }
    return originalInfo(...args);
  };
  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 2 };
  await assert.rejects(rateReview(args), /Card fetch interrupted/);
  const retried = await rateReview(args);
  assert.equal(retried.recorded, true);
  assert.equal(retried.view.cardId, 2);
  assert.deepEqual(client.answers, [[1, 2]], 'The confirmed response is finalized without writing a second grade.');
});

test('a dead process lock is reclaimed while a live concurrent rating remains protected', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  const lock = path.join(sessionDir, `${first.sessionId}.json.lock`);
  await writeFile(lock, JSON.stringify({ version: 1, pid: 2147483647, token: 'abandoned' }));
  const olderThanInFlightRequest = new Date(Date.now() - 60 * 1000);
  await utimes(lock, olderThanInFlightRequest, olderThanInFlightRequest);

  let entered;
  let release;
  const atAnswer = new Promise((resolve) => { entered = resolve; });
  const unblock = new Promise((resolve) => { release = resolve; });
  const originalAnswer = client.answerCard;
  client.answerCard = async (...args) => {
    entered();
    await unblock;
    return originalAnswer(...args);
  };
  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 };
  const saving = rateReview(args);
  await atAnswer;
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
  const olderThanFallback = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lock, olderThanFallback, olderThanFallback);
  await assert.rejects(rateReview(args), /already being saved/);
  assert.deepEqual(client.answers, []);
  release();
  assert.equal((await saving).recorded, true);
  assert.deepEqual(client.answers, [[1, 3]]);
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});

test('a fresh dead-process lock waits for an in-flight Anki request to settle', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  const lock = path.join(sessionDir, `${first.sessionId}.json.lock`);
  await writeFile(lock, JSON.stringify({ version: 1, pid: 2147483647, token: 'abandoned' }));
  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 };
  await assert.rejects(rateReview(args), /already being saved/);
  assert.deepEqual(client.answers, []);
  const olderThanInFlightRequest = new Date(Date.now() - 60 * 1000);
  await utimes(lock, olderThanInFlightRequest, olderThanInFlightRequest);
  assert.equal((await rateReview(args)).recorded, true);
  assert.deepEqual(client.answers, [[1, 3]]);
});

test('a recovery guard blocks acquirers, and concurrent stale-lock recovery writes only one grade', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  const lock = path.join(sessionDir, `${first.sessionId}.json.lock`);
  const guard = `${lock}.recovery`;
  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 };

  await writeFile(guard, JSON.stringify({ version: 1, pid: 2147483647, token: 'interrupted-reaper' }));
  await assert.rejects(rateReview(args), /recovery is in progress or was interrupted/);
  assert.deepEqual(client.answers, []);
  await rm(guard);
  await writeFile(lock, JSON.stringify({ version: 1, pid: 2147483647, token: 'abandoned' }));
  const old = new Date(Date.now() - 60 * 1000);
  await utimes(lock, old, old);

  const results = await Promise.allSettled([rateReview(args), rateReview(args)]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  assert.deepEqual(client.answers, [[1, 3]], 'A reaper and an ordinary contender never both grade.');
  await assert.rejects(stat(lock), { code: 'ENOENT' });
  await assert.rejects(stat(guard), { code: 'ENOENT' });
});

test('resume and rate share a lock so a slow resume cannot overwrite a saved grade', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  const originalInfo = client.cardsInfo;
  let entered;
  let release;
  const atRead = new Promise((resolve) => { entered = resolve; });
  const unblock = new Promise((resolve) => { release = resolve; });
  client.cardsInfo = async (...args) => {
    entered();
    await unblock;
    return originalInfo(...args);
  };

  const resuming = resumeReview({ client, sessionId: first.sessionId, sessionDir });
  await atRead;
  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 };
  await assert.rejects(rateReview(args), /already being saved/);
  release();
  assert.equal((await resuming).view.cardId, 1);
  const rated = await rateReview(args);
  assert.equal(rated.recorded, true);
  const saved = JSON.parse(await readFile(path.join(sessionDir, `${first.sessionId}.json`), 'utf8'));
  assert.equal(saved.reviewed, 1);
  assert.equal(saved.lastReceipt.nonce, first.view.nonce);
  assert.deepEqual(client.answers, [[1, 3]]);
});

test('an old empty lock from a previous release is recoverable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  const lock = path.join(sessionDir, `${first.sessionId}.json.lock`);
  await writeFile(lock, '');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lock, old, old);
  assert.equal((await rateReview({ client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 4 })).recorded, true);
  assert.deepEqual(client.answers, [[1, 4]]);
});

test('portable review rejects a card too large for the inline widget before persisting it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = fakeClient();
  client.cards.get(1).question = 'Q'.repeat(1_000_001);
  await assert.rejects(startReview({ client, deck: 'Languages', sessionDir: path.join(root, 'review-sessions') }), /inline size limit/);
  await assert.rejects(readdir(path.join(root, 'review-sessions')), { code: 'ENOENT' });
});

test('portable data defaults stay outside the plugin and allow an absolute override', () => {
  assert.equal(resolveAnkiDataDir({ env: {}, platform: 'darwin', home: '/Users/alice' }),
    '/Users/alice/Library/Application Support/While Anki');
  assert.equal(resolveAnkiDataDir({ env: {}, platform: 'linux', home: '/home/alice' }),
    '/home/alice/.local/share/while-anki');
  assert.equal(resolveAnkiDataDir({ env: { XDG_DATA_HOME: '/var/private/alice' }, platform: 'linux', home: '/home/alice' }),
    '/var/private/alice/while-anki');
  assert.equal(resolveAnkiDataDir({ env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\alice' }),
    'C:\\Users\\alice\\AppData\\Roaming\\While Anki');
  assert.equal(resolveAnkiDataDir({ env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\alice' }),
    'C:\\Users\\alice\\AppData\\Local\\While Anki');
  assert.equal(resolveAnkiDataDir({ env: { PLUGIN_DATA: '/private/plugin-state' }, platform: 'darwin', home: '/Users/alice' }),
    '/private/plugin-state');
  assert.equal(resolveAnkiDataDir({ env: { PLUGIN_DATA: '/private/plugin-state', WHILE_ANKI_DATA_DIR: '/private/custom' }, platform: 'darwin', home: '/Users/alice' }),
    '/private/custom');
  assert.equal(resolveAnkiDataDir({ env: { WHILE_ANKI_DATA_DIR: '/private/custom' }, platform: 'darwin', home: '/Users/alice' }),
    '/private/custom');
  assert.throws(() => resolveAnkiDataDir({ env: { WHILE_ANKI_DATA_DIR: './relative' }, platform: 'darwin', home: '/Users/alice' }),
    /absolute path/);
});
