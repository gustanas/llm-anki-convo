import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const template = await readFile(new URL('../inline/review.html', import.meta.url), 'utf8');
const source = [...template.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .find(([, attributes]) => !/type="application\/json"/i.test(attributes))[2];

function mount(data, { followUp = async () => {}, saved } = {}) {
  const nodes = new Map();
  const prompts = [];
  const writes = [];
  class Element {
    constructor(tagName = 'div') { this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.text = ''; this.attributes = {}; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(_) { throw new Error('Card data must never become HTML.'); }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    querySelector(selector) {
      if (selector.startsWith('#')) return nodes.get(selector.slice(1)) ?? null;
      return this.children.find((child) => child.tagName.toLowerCase() === selector) ?? null;
    }
    querySelectorAll(selector) { return this.children.filter((child) => child.tagName.toLowerCase() === selector); }
    focus() {}
    async click() { if (!this.disabled && !this.hidden) await this.listeners.get('click')?.(); }
  }
  for (const [, tag, id, attributes] of template.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"([^>]*)>/gi)) {
    const node = new Element(tag);
    node.hidden = /\bhidden\b/.test(attributes);
    nodes.set(id, node);
  }
  nodes.get('while-review-data').textContent = JSON.stringify(data);
  const window = {
    addEventListener() {},
    openai: {
      widgetState: saved,
      setWidgetState(value) { writes.push(value); return Promise.resolve(); },
      async sendFollowUpMessage(value) { prompts.push(value); await followUp(value); },
    },
  };
  runInNewContext(source, { document: { getElementById: (id) => nodes.get(id), createElement: (tag) => new Element(tag) }, window }, { timeout: 1000 });
  return { node: (id) => nodes.get(`while-review-${id}`), prompts, writes };
}

const view = {
  version: 1, sessionId: 'e5784ea8-6592-47a8-9a2e-9bbf0886b0e4', cardId: 42,
  nonce: '87aa734a-baf6-4e89-8205-3491bfa53b66', deck: 'Languages', reviewed: 2,
  remaining: 17, done: false, intervals: ['1m', '5m', '10m', '4d'],
  card: { id: 'anki:42', type: 'flashcard', category: 'Languages', question: '<script>hi()</script>', answer: 'Answer', media: { question: [{ type: 'audio', src: 'data:audio/mpeg;base64,YQ==' }, { type: 'image', src: 'https://example.com/a.png' }] } },
};

test('reveal shows the actual answer, then one rating requests one Anki save', async () => {
  const app = mount(view);
  assert.equal(app.node('question').textContent, '<script>hi()</script>');
  assert.equal(app.node('question-media').children.length, 1);
  assert.equal(app.node('answer').hidden, true);
  assert.equal(app.node('ratings').hidden, true);
  assert.equal(app.node('ratings').children.length, 4);
  await app.node('ratings').children[2].click();
  assert.equal(app.prompts.length, 0, 'No rating can be sent before reveal.');
  await app.node('reveal').click();
  assert.equal(app.node('answer').hidden, false);
  assert.equal(app.node('answer-text').textContent, 'Answer');
  assert.equal(app.node('ratings').hidden, false);
  assert.equal(app.node('ratings').children[2].textContent, 'Good · 10m');
  await app.node('ratings').children[2].click();
  assert.equal(app.prompts.length, 1);
  assert.match(app.prompts[0].prompt, /session=e5784ea8-6592-47a8-9a2e-9bbf0886b0e4 card=42 nonce=87aa734a-baf6-4e89-8205-3491bfa53b66 ease=3/);
  assert.equal(app.prompts[0].scrollToBottom, true);
  await app.node('ratings').children[2].click();
  assert.equal(app.prompts.length, 1, 'Repeat clicks cannot send another grade.');
  assert.equal(app.node('ratings').children[2].disabled, true);
  assert.equal(JSON.stringify(app.writes).includes('Answer'), false, 'Card text stays out of widget state.');
});

test('an unavailable follow-up action never claims the grade was saved', async () => {
  const app = mount(view, { followUp: async () => { throw new Error('Host unavailable'); } });
  await app.node('reveal').click();
  await app.node('ratings').children[0].click();
  assert.equal(app.node('ratings').children[0].disabled, false);
  assert.match(app.node('status').textContent, /nothing was saved/);
});

test('completed session renders no rating buttons', () => {
  const app = mount({ ...view, card: null, cardId: null, nonce: null, done: true, remaining: 0 });
  assert.equal(app.node('question').textContent, 'No due or new cards remain.');
  assert.equal(app.node('reveal-row').hidden, true);
  assert.equal(app.node('ratings').children.length, 0);
});
