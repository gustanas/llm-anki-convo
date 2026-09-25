import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('../anki-widget.html', import.meta.url), 'utf8');
const script = (await readFile(new URL('../src/anki-widget.js', import.meta.url), 'utf8'))
  .replace("import { App } from '@modelcontextprotocol/ext-apps';", 'const App = globalThis.MockApp;');

function mount(handlers, storage = new Map(), { viewId, hostClose = false } = {}) {
  const nodes = new Map();
  const calls = [];
  const sizes = [];
  const timers = new Map();
  let nextTimer = 1;
  let teardownRequests = 0;
  let closeRequests = 0;
  let instance;
  const body = { style: {} };
  const documentElement = { style: {} };

  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.listeners = new Map();
      this.attributes = {};
      this.dataset = {};
      this.hidden = false;
      this.disabled = false;
      this._text = '';
      this._value = undefined;
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('Card content must never be rendered as HTML.'); }
    set value(value) { this._value = String(value); }
    get value() { return this._value ?? (this.tagName === 'SELECT' ? this.children[0]?.value ?? '' : ''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ''; this.children = children; this._value = undefined; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    focus() {}
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(child.tagName.toLowerCase() === selector ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    click() { if (!this.hidden && !this.disabled) this.listeners.get('click')?.(); }
    change() { if (!this.hidden && !this.disabled) this.listeners.get('change')?.(); }
  }

  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new Element(match[1]);
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    nodes.set(match[3], element);
  }

  class MockApp {
    constructor() { instance = this; }
    async connect() {
      if (viewId) this.ontoolresult?.(ok({ status: 'ready', viewId }));
    }
    getHostCapabilities() { return { serverTools: {} }; }
    callServerTool(request) {
      calls.push(request);
      const handler = handlers[request.name] ??
        (request.name === 'get_anki_autoshow' ? () => ok({ mode: 'off' }) : null);
      if (!handler) throw new Error(`Unexpected ${request.name}`);
      return handler(request.arguments);
    }
    async sendSizeChanged(size) { sizes.push(size); }
    async requestTeardown() { teardownRequests++; }
  }

  runInNewContext(script, {
    MockApp,
    document: {
      getElementById: (id) => nodes.get(id),
      createElement: (tag) => new Element(tag),
      body,
      documentElement,
    },
    window: { openai: hostClose ? { requestClose: () => { closeRequests++; } } : undefined },
    setInterval: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  }, { timeout: 1000 });

  return {
    node: (id) => nodes.get(id), calls, storage, sizes,
    teardownRequests: () => teardownRequests,
    closeRequests: () => closeRequests,
    body, documentElement,
    poll: () => { for (const timer of timers.values()) timer.callback(); },
    timerCount: () => timers.size,
    emitResult: (result) => instance.ontoolresult?.(result),
  };
}

const card = (id, question, answer) => ({
  version: 1,
  sessionId: '083b4b9a-9068-435b-8efe-2a7046589cb1',
  deck: 'Japanese',
  reviewed: id === 1 ? 0 : 1,
  done: false,
  card: { question, answer, media: { question: [], answer: [] } },
  cardId: id,
  nonce: id === 1 ? 'b7a3e102-ac96-4936-a2a3-156093a16eac' : 'a909b135-e7c5-4751-a5c8-864b57c53c0c',
  intervals: ['1m', '6m', '1d', '4d'],
  remaining: 2,
});

const ok = (structuredContent) => ({ content: [], structuredContent });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const reviewCalls = (ui) => ui.calls.filter(({ name }) =>
  name !== 'get_anki_autoshow' && name !== 'set_anki_autoshow');

test('Auto-show loads and saves without a working Anki deck connection', async () => {
  const ui = mount({
    list_anki_decks: () => ({ isError: true, content: [{ type: 'text', text: 'Anki is closed' }] }),
    get_anki_autoshow: () => ok({ mode: 'long_tasks' }),
    set_anki_autoshow: ({ mode }) => ok({ mode }),
  });
  await tick();
  assert.match(ui.node('status').textContent, /Could not load Anki decks/);
  assert.equal(ui.node('autoshow-mode').value, 'long_tasks');
  assert.equal(ui.node('autoshow-mode').disabled, false);
  assert.equal(ui.node('autoshow-panel').hidden, false);

  ui.node('autoshow-mode').value = 'every_message';
  ui.node('autoshow-mode').change();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.at(-1))), {
    name: 'set_anki_autoshow', arguments: { mode: 'every_message' },
  });
  assert.equal(ui.node('autoshow-mode').value, 'every_message');
  assert.match(ui.node('autoshow-status').textContent, /Saved/);
  assert.equal(ui.calls.some(({ name }) => name === 'rate_anki_review'), false);
});

test('Auto-show stays visible on the card panel and reverts a failed change', async () => {
  const ui = mount({
    list_anki_decks: () => ok({ decks: ['Japanese'] }),
    start_anki_review: () => ok({ view: card(1, 'Question', 'Answer') }),
    get_anki_autoshow: () => ok({ mode: 'off' }),
    set_anki_autoshow: () => ({ isError: true, content: [{ type: 'text', text: 'Cannot save' }] }),
  });
  await tick();
  ui.node('start-review').click();
  await tick();
  assert.equal(ui.node('deck-panel').hidden, true);
  assert.equal(ui.node('card-panel').hidden, false);
  assert.equal(ui.node('autoshow-panel').hidden, false);

  ui.node('autoshow-mode').value = 'long_tasks';
  ui.node('autoshow-mode').change();
  await tick();
  assert.equal(ui.node('autoshow-mode').value, 'off');
  assert.equal(ui.node('autoshow-mode').disabled, false);
  assert.match(ui.node('autoshow-status').textContent, /Could not save Auto-show: Cannot save/);
  assert.equal(ui.node('autoshow-status').dataset.error, 'true');
});

test('Auto-show load error can be retried without affecting card review', async () => {
  let attempts = 0;
  const ui = mount({
    list_anki_decks: () => ok({ decks: ['Japanese'] }),
    get_anki_autoshow: () => ++attempts === 1
      ? { isError: true, content: [{ type: 'text', text: 'Settings unavailable' }] }
      : ok({ mode: 'every_message' }),
  });
  await tick();
  assert.equal(ui.node('autoshow-mode').disabled, true);
  assert.equal(ui.node('refresh-autoshow').hidden, false);
  assert.match(ui.node('autoshow-status').textContent, /Settings unavailable/);
  ui.node('refresh-autoshow').click();
  await tick();
  assert.equal(ui.node('autoshow-mode').value, 'every_message');
  assert.equal(ui.node('autoshow-mode').disabled, false);
  assert.equal(ui.node('refresh-autoshow').hidden, true);
  assert.deepEqual(reviewCalls(ui).map(({ name }) => name), ['list_anki_decks']);
});

test('preselects the last used deck without starting a review and preserves user choice on refresh', async () => {
  const ui = mount({
    list_anki_decks: () => ok({ decks: ['French', 'Japanese'], lastUsedDeck: 'Japanese' }),
  });
  await tick();
  assert.equal(ui.node('deck-select').value, 'Japanese');
  assert.deepEqual(reviewCalls(ui).map((item) => item.name), ['list_anki_decks']);

  ui.node('deck-select').value = 'French';
  ui.node('refresh-decks').click();
  await tick();
  assert.equal(ui.node('deck-select').value, 'French');
  assert.deepEqual(reviewCalls(ui).map((item) => item.name), ['list_anki_decks', 'list_anki_decks']);
});

test('ignores a remembered deck that is no longer in the available deck list', async () => {
  const ui = mount({
    list_anki_decks: () => ok({ decks: ['French', 'Japanese'], lastUsedDeck: 'Deleted deck' }),
  });
  await tick();
  assert.equal(ui.node('deck-select').value, 'French');
  assert.equal(ui.node('start-review').disabled, false);
});

test('reveals locally and advances only after a quiet Anki rating is confirmed', async () => {
  let resolveRate;
  const rateResult = new Promise((resolve) => { resolveRate = resolve; });
  const first = card(1, '<b>Question</b>', 'Answer');
  const second = card(2, 'Next question', 'Next answer');
  first.card.media.question = [
    { type: 'image', src: 'data:image/png;base64,YQ==', alt: 'Picture' },
    { type: 'image', src: 'https://example.com/tracker.png' },
  ];
  const ui = mount({
    list_anki_decks: () => ok({ decks: ['Japanese'] }),
    start_anki_review: () => ok({ view: first }),
    rate_anki_review: () => rateResult,
  });
  await tick();
  assert.equal(ui.node('deck-select').value, 'Japanese');
  ui.node('start-review').click();
  await tick();
  assert.equal(ui.node('question').textContent, '<b>Question</b>');
  assert.deepEqual(ui.node('question-media').children.map((item) => item.tagName), ['IMG']);
  assert.equal(ui.node('answer').hidden, true);

  ui.node('reveal-answer').click();
  assert.equal(ui.node('answer').hidden, false);
  assert.equal(ui.node('answer-text').textContent, 'Answer');
  assert.deepEqual(reviewCalls(ui).map((item) => item.name), ['list_anki_decks', 'start_anki_review']);

  ui.node('rating-row').children[2].click();
  await tick();
  assert.equal(ui.node('question').textContent, '<b>Question</b>', 'An unconfirmed call cannot advance the card.');
  assert.equal(reviewCalls(ui)[2].name, 'rate_anki_review');
  assert.deepEqual(JSON.parse(JSON.stringify(reviewCalls(ui)[2].arguments)), {
    sessionId: first.sessionId, cardId: first.cardId, nonce: first.nonce, ease: 3,
  });

  resolveRate(ok({ recorded: true, view: second }));
  await tick();
  assert.equal(ui.node('question').textContent, 'Next question');
  assert.equal(ui.node('answer').hidden, true);
  assert.equal(ui.node('progress').textContent, '1 saved · 2 available');
  assert.doesNotMatch(script, /sendFollowUpMessage/);
});

test('a failed rating keeps the same card and retries the same grade', async () => {
  const first = card(1, 'First', 'Answer');
  const second = card(2, 'Second', 'Answer');
  let attempts = 0;
  const ui = mount({
    list_anki_decks: () => ok({ decks: ['Japanese'] }),
    start_anki_review: () => ok({ view: first }),
    rate_anki_review: () => {
      attempts++;
      return attempts === 1
        ? { isError: true, content: [{ type: 'text', text: 'Anki is unavailable' }] }
        : ok({ recorded: true, view: second });
    },
  });
  await tick();
  ui.node('start-review').click();
  await tick();
  ui.node('reveal-answer').click();
  ui.node('rating-row').children[0].click();
  await tick();
  assert.equal(ui.node('question').textContent, 'First');
  assert.equal(ui.node('rating-row').children[2].disabled, true);
  assert.match(ui.node('status').textContent, /Rating was not confirmed/);
  ui.node('rating-row').children[0].click();
  await tick();
  assert.deepEqual(reviewCalls(ui)[2].arguments, reviewCalls(ui)[3].arguments);
  assert.equal(ui.node('question').textContent, 'Second');
});

test('a remounted card restores only the exact unconfirmed rating for manual retry', async () => {
  const first = card(1, 'First', 'Answer');
  const second = card(2, 'Second', 'Answer');
  const storage = new Map();
  const ui = mount({
    list_anki_decks: () => ok({ decks: ['Japanese'] }),
    start_anki_review: () => ok({ view: first }),
    rate_anki_review: () => ({ isError: true, content: [{ type: 'text', text: 'Connection interrupted' }] }),
  }, storage);
  await tick();
  ui.node('start-review').click();
  await tick();
  ui.node('reveal-answer').click();
  ui.node('rating-row').children[3].click();
  await tick();
  assert.ok(storage.has('while-anki-mcp-pending-v1'));

  const restored = mount({
    rate_anki_review: () => ok({ recorded: true, view: second }),
  }, storage);
  await tick();
  assert.deepEqual(reviewCalls(restored), [], 'Remount never grades automatically.');
  assert.equal(restored.node('question').textContent, 'First');
  assert.equal(restored.node('answer').hidden, false);
  assert.deepEqual(restored.node('rating-row').children.map((item) => item.disabled), [true, true, true, false]);
  restored.node('rating-row').children[3].click();
  await tick();
  assert.equal(reviewCalls(restored)[0].name, 'rate_anki_review');
  assert.equal(reviewCalls(restored)[0].arguments.ease, 4);
  assert.equal(restored.node('question').textContent, 'Second');
  assert.equal(storage.has('while-anki-mcp-pending-v1'), false);
});

test('a hidden view clears the card, preserves its review session, and requests teardown', async () => {
  const viewId = 'cbb4ad11-2740-4c6a-b949-c2a3417e353f';
  const storage = new Map();
  let hidden = false;
  const first = card(1, 'Private question', 'Private answer');
  first.card.media.question = [{ type: 'image', src: 'data:image/png;base64,YQ==' }];
  const ui = mount({
    get_anki_view_state: ({ viewId: requested }) => ok({ viewId: requested, hidden }),
    list_anki_decks: () => ok({ decks: ['Japanese'] }),
    start_anki_review: () => ok({ view: first }),
  }, storage, { viewId, hostClose: true });
  await tick();
  ui.node('start-review').click();
  await tick();
  assert.equal(ui.node('question').textContent, 'Private question');
  assert.equal(ui.node('question-media').children.length, 1);
  assert.equal(ui.timerCount(), 1);

  hidden = true;
  ui.poll();
  await tick();
  assert.equal(ui.node('review-root').hidden, true);
  assert.equal(ui.node('question').textContent, '');
  assert.equal(ui.node('answer-text').textContent, '');
  assert.equal(ui.node('question-media').children.length, 0);
  assert.equal(ui.node('rating-row').children.length, 0);
  assert.equal(ui.timerCount(), 0);
  assert.equal(ui.closeRequests(), 1);
  assert.equal(ui.teardownRequests(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.sizes)), [{ height: 1 }]);
  assert.equal(ui.body.style.height, '1px');
  assert.equal(ui.documentElement.style.height, '1px');
  assert.equal(storage.get('while-anki-mcp-session-id'), first.sessionId);
  assert.equal(ui.calls.filter((call) => call.name === 'rate_anki_review').length, 0, 'Hiding never grades a card.');
});

test('hiding during an unconfirmed rating keeps the exact retry receipt', async () => {
  const viewId = 'b647ed6d-9929-4d5e-8337-00ccbdac0269';
  const storage = new Map();
  let hidden = false;
  const ui = mount({
    get_anki_view_state: ({ viewId: requested }) => ok({ viewId: requested, hidden }),
    list_anki_decks: () => ok({ decks: ['Japanese'] }),
    start_anki_review: () => ok({ view: card(1, 'Question', 'Answer') }),
    rate_anki_review: () => new Promise(() => {}),
  }, storage, { viewId });
  await tick();
  ui.node('start-review').click();
  await tick();
  ui.node('reveal-answer').click();
  ui.node('rating-row').children[1].click();
  await tick();
  const pending = storage.get('while-anki-mcp-pending-v1');
  assert.ok(pending);

  hidden = true;
  ui.poll();
  await tick();
  assert.equal(ui.node('review-root').hidden, true);
  assert.equal(storage.get('while-anki-mcp-pending-v1'), pending);
  assert.equal(storage.get('while-anki-mcp-session-id'), card(1, '', '').sessionId);
  assert.equal(ui.calls.filter((call) => call.name === 'rate_anki_review').length, 1, 'Hide sends no additional grade.');
});
