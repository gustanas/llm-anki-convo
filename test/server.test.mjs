import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createActivityStore } from '../lib/state.mjs';
import { createQuizServer } from '../server.mjs';

const event = (name, session = 'one', turn = 'turn-1') => ({ hook_event_name: name, session_id: session, turn_id: turn });

test('overlapping tasks and stale stops do not hide active work', () => {
  const store = createActivityStore();
  store.applyHook(event('UserPromptSubmit'));
  store.applyHook(event('UserPromptSubmit', 'two'));
  assert.equal(store.snapshot().activeCount, 2);
  store.applyHook(event('Stop'));
  assert.equal(store.snapshot().status, 'working');
  store.applyHook(event('UserPromptSubmit', 'one', 'turn-2'));
  store.applyHook(event('Interrupt', 'one', 'turn-1'));
  assert.equal(store.snapshot().activeCount, 2);
  store.applyHook(event('SessionEnd', 'one'));
  assert.equal(store.snapshot().activeCount, 1);
  store.applyHook(event('Stop', 'two'));
  assert.equal(store.snapshot().status, 'complete');
});

test('out-of-order async starts cannot revive terminal turns', () => {
  const store = createActivityStore();
  store.applyHook(event('Stop'));
  store.applyHook(event('UserPromptSubmit'));
  assert.equal(store.snapshot().status, 'complete');
  assert.equal(store.snapshot().activeCount, 0);
  store.applyHook(event('UserPromptSubmit', 'two'));
  store.applyHook(event('SessionEnd', 'two'));
  store.applyHook(event('UserPromptSubmit', 'two'));
  assert.equal(store.snapshot().activeCount, 0);
});

test('a resumed session can start a new turn after SessionEnd', () => {
  const store = createActivityStore();
  store.applyHook(event('UserPromptSubmit'));
  store.applyHook(event('Stop'));
  store.applyHook(event('SessionEnd'));
  store.applyHook(event('UserPromptSubmit', 'one', 'turn-2'));
  assert.equal(store.snapshot().status, 'working');
  assert.equal(store.snapshot().activeCount, 1);
});

test('demo is labelled, isolated, and cannot replace live activity', () => {
  const store = createActivityStore();
  assert.equal(store.applyDemo('start').source, 'demo');
  store.applyHook(event('UserPromptSubmit'));
  assert.equal(store.snapshot().source, 'live');
  assert.throws(() => store.applyDemo('finish'), /Codex is working/);
  store.applyDemo('reset');
  assert.equal(store.snapshot().status, 'working');
  store.applyHook(event('Interrupt'));
  assert.equal(store.snapshot().status, 'interrupted');
  assert.throws(() => store.applyHook(event('Stop', '', '')), /Invalid/);
});

test('HTTP cards, authenticated hooks, event stream, and local access boundaries', async t => {
  const app = await createQuizServer({ token: 'test-secret' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const cards = await (await fetch(`${base}/api/cards`)).json();
  assert.equal(cards.cards.length, 8);
  for (const card of cards.cards) assert.ok(card.choices[card.answerIndex]);
  assert.equal((await post('/api/hook', event('UserPromptSubmit'))).status, 401);
  assert.equal((await post('/api/demo', { action: 'start' }, { Origin: 'https://example.com' })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/state`, { headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"status":"idle"/);
  const accepted = await post('/api/hook', event('UserPromptSubmit'), { Authorization: 'Bearer test-secret' });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status, 'working');
  assert.match(new TextDecoder().decode((await reader.read()).value), /"status":"working"/);
  controller.abort();
  await reader.cancel().catch(() => {});
  assert.equal((await post('/api/demo', { action: 'start' })).status, 409);
  assert.equal((await post('/api/hook', event('Stop'), { Authorization: 'Bearer test-secret' })).status, 200);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).status, 'complete');
  assert.equal((await fetch(`${base}/.runtime/server.json`)).status, 404);
});
