import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
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
    findCards: async (query) => query.endsWith('is:new')
      ? [...cards.values()].filter((card) => card.queue === 0).map((card) => card.cardId) : [],
    cardsInfo: async (ids) => ids.map((id) => cards.get(id)).filter(Boolean),
    retrieveMediaFile: async () => false,
    answerCard: async (id, ease) => {
      answers.push([id, ease]);
      const card = cards.get(id);
      card.reps++;
      card.queue = 2;
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

test('portable review verifies an interrupted rating before retrying', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anki-plugin-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'review-sessions');
  const client = fakeClient();
  const first = await startReview({ client, deck: 'Languages', sessionDir });
  client.interruptAfterSave();
  const args = { client, sessionDir, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 1 };
  await assert.rejects(rateReview(args), /Connection interrupted/);
  const resumed = await rateReview(args);
  assert.equal(resumed.view.cardId, 2);
  assert.deepEqual(client.answers, [[1, 1]]);
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
