import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseReviewArgs } from '../scripts/review-anki.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('review CLI preserves the explicit output directory and validates rating arguments', () => {
  const directory = path.join(os.tmpdir(), 'while-review-output');
  assert.deepEqual(parseReviewArgs(['start', '--deck', 'Languages', '--output-dir', directory]), {
    command: 'start', deck: 'Languages', outputDir: directory,
  });
  assert.equal(parseReviewArgs(['rate', '--session', 'abc', '--card', '42', '--nonce', 'xyz', '--ease', '3']).cardId, 42);
  assert.throws(() => parseReviewArgs(['rate', '--session', 'abc', '--card', '42', '--nonce', 'xyz', '--ease', '5']), /Usage/);
});

async function isolatedReview(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'while-review-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['lib', 'scripts', 'inline', 'dist']) await mkdir(path.join(root, directory));
  for (const file of [
    'lib/anki-review.mjs', 'lib/anki-connect.mjs', 'lib/anki-cards.mjs',
    'scripts/anki.mjs', 'scripts/build-anki.mjs', 'scripts/build-inline.mjs',
    'inline/review.html', 'inline/quiz.html',
  ]) await copyFile(path.join(ROOT, file), path.join(root, file));
  return { root, api: await import(pathToFileURL(path.join(root, 'lib', 'anki-review.mjs')).href) };
}

function fakeClient(count = 150) {
  const states = new Map(Array.from({ length: count }, (_, index) => [index + 1, {
    cardId: index + 1, deckName: 'Languages', queue: 0, reps: 0,
    fields: {}, question: `<b>Front ${index + 1}</b>`, answer: `<b>Back ${index + 1}</b>`,
    nextReviews: ['<1m', '<6m', '<10m', '4d'],
  }]));
  const history = new Map();
  const calls = [];
  let uncertain = false;
  return {
    states, calls,
    setUncertain: () => { uncertain = true; },
    deckNames: async () => ['Languages'],
    findCards: async (query) => {
      calls.push(['findCards', query]);
      if (query.endsWith('is:due')) return [];
      return [...states.values()].filter((item) => item.queue === 0).map((item) => item.cardId);
    },
    cardsInfo: async (ids) => { calls.push(['cardsInfo', ids]); return ids.map((id) => states.get(id)).filter(Boolean); },
    retrieveMediaFile: async () => false,
    answerCard: async (id, ease) => {
      calls.push(['answerCard', id, ease]);
      const item = states.get(id);
      item.reps += 1;
      item.queue = 2;
      history.set(id, [...(history.get(id) ?? []), { id: Date.now(), ease }]);
      if (uncertain) { uncertain = false; throw new Error('Connection interrupted after Anki saved it.'); }
      return true;
    },
    reviewHistory: async (id) => history.get(id) ?? [],
  };
}

test('unlimited review loads one card, saves exactly one rating, and advances', async (t) => {
  const { root, api } = await isolatedReview(t);
  const client = fakeClient(150);
  const first = await api.startReview({ client, deck: 'Languages', outputDir: path.join(root, 'dist') });
  assert.equal(first.view.remaining, 150, 'The session has no 100-card selection cap.');
  assert.equal(first.view.cardId, 1);
  assert.equal(first.view.card.question, 'Front 1');
  assert.equal(first.view.card.answer, 'Back 1');
  assert.equal(first.view.intervals[2], '<10m');
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  const file = await readFile(first.path, 'utf8');
  assert.ok(file.includes('Show answer'));
  assert.equal(file.includes('<b>Front 1</b>'), false, 'Raw Anki HTML is not rendered.');
  assert.ok(Buffer.byteLength(file) < 1_000_000);
  const graded = await api.rateReview({ client, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 });
  assert.equal(graded.recorded, true);
  assert.equal(graded.view.cardId, 2);
  assert.equal(graded.view.reviewed, 1);
  assert.notEqual(graded.path, first.path);
  assert.deepEqual(client.calls.filter((call) => call[0] === 'answerCard'), [['answerCard', 1, 3]]);
  const duplicate = await api.rateReview({ client, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 3 });
  assert.equal(duplicate.view.cardId, 2);
  assert.equal(client.calls.filter((call) => call[0] === 'answerCard').length, 1);
  await assert.rejects(api.rateReview({ client, sessionId: first.sessionId, cardId: 2, nonce: first.view.nonce, ease: 4 }), /does not match the saved review/);
  assert.equal(client.calls.filter((call) => call[0] === 'answerCard').length, 1);
});

test('a reply lost after Anki saves the grade is verified from review history before advancing', async (t) => {
  const { root, api } = await isolatedReview(t);
  const client = fakeClient(2);
  const first = await api.startReview({ client, deck: 'Languages', outputDir: path.join(root, 'dist') });
  client.setUncertain();
  const input = { client, sessionId: first.sessionId, cardId: 1, nonce: first.view.nonce, ease: 1 };
  await assert.rejects(api.rateReview(input), /Connection interrupted/);
  assert.equal(client.states.get(1).reps, 1);
  const recovered = await api.rateReview(input);
  assert.equal(recovered.view.cardId, 2);
  assert.equal(client.calls.filter((call) => call[0] === 'answerCard').length, 1, 'The retry does not send a duplicate grade.');
});

test('review continues until every eligible card is graded, then shows completion', async (t) => {
  const { root, api } = await isolatedReview(t);
  const client = fakeClient(3);
  let result = await api.startReview({ client, deck: 'Languages', outputDir: path.join(root, 'dist') });
  for (let id = 1; id <= 3; id++) {
    assert.equal(result.view.cardId, id);
    result = await api.rateReview({ client, sessionId: result.sessionId, cardId: id, nonce: result.view.nonce, ease: id });
  }
  assert.equal(result.view.done, true);
  assert.equal(result.view.reviewed, 3);
  assert.equal(result.view.card, null);
  assert.equal(client.calls.filter((call) => call[0] === 'answerCard').length, 3);
});

test('moving or suspending the active card prevents a stale review write', async (t) => {
  const { root, api } = await isolatedReview(t);
  const client = fakeClient(1);
  const result = await api.startReview({ client, deck: 'Languages', outputDir: path.join(root, 'dist') });
  client.states.get(1).queue = -1;
  await assert.rejects(api.rateReview({ client, sessionId: result.sessionId, cardId: 1, nonce: result.view.nonce, ease: 3 }), /suspended or moved/);
  assert.equal(client.calls.filter((call) => call[0] === 'answerCard').length, 0);
});

test('review template validates private content and escapes script end tags', async (t) => {
  const { api } = await isolatedReview(t);
  const template = '<script type="application/json">__WHILE_REVIEW_JSON__</script>';
  const html = api.renderReviewHtml(template, {
    card: { id: 'anki:1', type: 'flashcard', category: 'Test', question: '</script><script>bad()</script>', answer: 'Safe' },
    deck: 'Test',
  });
  assert.equal(html.match(/<script/g).length, 1);
  assert.equal(html.includes('</script><script>bad()'), false);
  assert.equal(JSON.parse(html.match(/<script type="application\/json">(.*)<\/script>/)[1]).card.question, '</script><script>bad()</script>');
});
