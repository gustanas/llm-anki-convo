import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const template = await readFile(new URL('../inline/quiz.html', import.meta.url), 'utf8');
const source = [...template.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .find(([, attributes]) => !/type="application\/json"/i.test(attributes))[2];

// Exercise the real inline script without a browser or a runtime dependency.
// This intentionally supplies only the DOM operations used by the template.
function mount(cards, snapshot, { host = true } = {}) {
  const nodes = new Map();
  const writes = [];
  const windowListeners = new Map();
  let focused = null;

  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.listeners = new Map();
      this.hidden = false;
      this.disabled = false;
      this.text = '';
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('Card content must never be rendered as HTML.'); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    focus() { focused = this; }
    closest(selector) { return selector.split(',').some(part => part.trim() === this.tagName.toLowerCase()) ? this : null; }
    querySelector(selector) {
      if (selector.startsWith('#')) return nodes.get(selector.slice(1)) || null;
      return this.children.find(child => child.tagName.toLowerCase() === selector) || this.children.map(child => child.querySelector(selector)).find(Boolean) || null;
    }
    click() { if (!this.hidden && !this.disabled) this.listeners.get('click')?.({ target: this }); }
  }

  for (const [, tag, id, attributes] of template.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"([^>]*)>/gi)) {
    const element = new Element(tag);
    element.hidden = /\bhidden\b/.test(attributes);
    element.disabled = /\bdisabled\b/.test(attributes);
    nodes.set(id, element);
  }
  nodes.get('while-inline-cards').textContent = JSON.stringify(cards);
  const window = { addEventListener: (type, callback) => windowListeners.set(type, callback) };
  if (host) {
    window.openai = {
      widgetState: snapshot,
      setWidgetState(value) {
        const saved = JSON.parse(JSON.stringify(value));
        writes.push(saved);
        window.openai.widgetState = saved;
        windowListeners.get('openai:set_globals')?.({ detail: { globals: { widgetState: saved } } });
        return Promise.resolve();
      },
    };
  }
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Element(tag) };
  runInNewContext(source, { document, window }, { timeout: 1000 });
  return {
    node: name => nodes.get(`while-inline-${name}`),
    writes,
    focused: () => focused,
    state: () => writes.at(-1),
    restore: saved => windowListeners.get('openai:set_globals')({ detail: { globals: { widgetState: saved } } }),
    press(key, target = nodes.get('while-inline-quiz')) {
      let prevented = false;
      nodes.get('while-inline-quiz').listeners.get('keydown')({ key, target, preventDefault: () => { prevented = true; } });
      return prevented;
    },
  };
}

const flashcard = { id: 'anki:1', type: 'flashcard', category: 'Languages', question: 'Bonjour', answer: 'Hello' };
const quiz = { id: 'quiz:1', category: 'Numbers', question: 'One plus one?', choices: ['Two', 'Three'], answerIndex: 0, explanation: 'One and one make two.' };
const image = 'data:image/png;base64,YQ==';
const audio = 'data:audio/mpeg;base64,YQ==';

test('flashcards reveal their real answer, count reviews once, and support skip and restart', () => {
  const app = mount([flashcard, { ...flashcard, id: 'anki:2', question: 'Au revoir', answer: 'Goodbye' }]);
  assert.equal(app.node('question').textContent, 'Bonjour');
  assert.equal(app.node('choices').children.length, 0);
  assert.equal(app.node('feedback').textContent, '');
  assert.equal(app.node('reveal').hidden, false);
  assert.equal(app.node('next').hidden, true);
  assert.equal(app.node('note').hidden, false);
  assert.equal(app.writes.length, 0, 'Loading the quiz does not save state.');
  assert.equal(app.press('1'), false, 'Numeric quiz shortcuts do not grade flashcards.');
  app.node('reveal').click();
  assert.equal(app.node('feedback').children[1].textContent, 'Hello');
  assert.equal(app.node('score').textContent, '1 reviewed');
  assert.deepEqual(app.state().privateContent.answers, [true, null]);
  assert.equal(app.state().modelContent.correct, 0);
  assert.equal(app.focused(), app.node('next'));
  app.node('reveal').click();
  assert.equal(app.writes.length, 1, 'Repeated reveal cannot increase the review count.');
  app.node('next').click();
  assert.equal(app.node('question').textContent, 'Au revoir');
  assert.equal(app.node('feedback').textContent, '');
  assert.equal(app.focused(), app.node('reveal'));
  app.node('skip').click();
  assert.equal(app.node('question').textContent, 'Practice complete.');
  assert.equal(app.node('feedback').children[0].textContent, '1 of 2 reviewed');
  assert.equal(app.node('feedback').children[1].textContent, '1 skipped');
  app.node('next').click();
  assert.equal(app.node('question').textContent, 'Bonjour');
  assert.equal(app.node('score').textContent, '0 reviewed');
  assert.deepEqual(app.state().privateContent.answers, [null, null]);
});

test('card text remains text and only supported base64 media reaches native elements', () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const app = mount([{
    ...flashcard, question: hostile, answer: hostile,
    media: {
      question: [
        { type: 'image', src: image, alt: 'A picture' },
        { type: 'audio', src: audio, alt: 'Pronunciation' },
        { type: 'image', src: 'https://example.com/tracker.png' },
        { type: 'image', src: 'data:image/svg+xml;base64,YQ==' },
        { type: 'image', src: 'data:image/png;base64,<script>' },
        { type: 'audio', src: 'javascript:alert(1)' },
        { type: 'audio', src: image },
      ],
      answer: [{ type: 'image', src: image }, { type: 'audio', src: audio }],
    },
  }]);
  assert.equal(app.node('question').textContent, hostile);
  assert.deepEqual(app.node('question-media').children.map(node => node.tagName), ['IMG', 'AUDIO']);
  const [img, sound] = app.node('question-media').children;
  assert.equal(img.src, image);
  assert.equal(img.alt, 'A picture');
  assert.equal(sound.controls, true);
  assert.equal(sound.preload, 'none');
  assert.equal(sound.attributes['aria-label'], 'Pronunciation');
  assert.equal(sound.autoplay, undefined);
  assert.equal(app.press('1', sound), false, 'Audio keyboard controls are not intercepted.');
  app.node('reveal').click();
  assert.equal(app.node('feedback').children[1].textContent, hostile);
  assert.deepEqual(app.node('feedback').children[2].children.map(node => node.tagName), ['IMG', 'AUDIO']);
});

test('saved flashcard state is compact, restores reveals, and rejects changed decks or invalid answer types', () => {
  const largeCard = { ...flashcard, question: 'Private question '.repeat(5000), media: { question: [{ type: 'image', src: `data:image/png;base64,${'AAAA'.repeat(50000)}` }] } };
  const app = mount([largeCard]);
  app.node('reveal').click();
  const saved = app.state();
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 1024);
  assert.match(saved.privateContent.deckId, /^while-[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(saved).includes('Private question'), false);
  assert.equal(JSON.stringify(saved).includes('data:image'), false);
  const restored = mount([largeCard], saved);
  assert.equal(restored.node('feedback').children[1].textContent, 'Hello');
  assert.equal(restored.node('score').textContent, '1 reviewed');
  assert.equal(restored.writes.length, 0, 'Restoring state must not cause another save.');
  const changed = mount([{ ...largeCard, answer: 'Different answer' }], saved);
  assert.equal(changed.node('feedback').textContent, '');
  const changedMedia = mount([{ ...largeCard, media: { question: [{ type: 'image', src: 'data:image/png;base64,Yg==' }] } }], saved);
  assert.equal(changedMedia.node('feedback').textContent, '', 'Changing media invalidates a previously revealed answer even when ID and text are unchanged.');
  const invalid = mount([largeCard], { ...saved, privateContent: { ...saved.privateContent, answers: [0] } });
  assert.equal(invalid.node('feedback').textContent, '');
  app.restore({ ...saved, privateContent: { ...saved.privateContent, answers: [null], revision: 0 } });
  assert.equal(app.node('score').textContent, '1 reviewed', 'A stale snapshot cannot undo a reveal.');
});

test('mixed decks keep quiz grading separate from flashcard review and work without host storage', () => {
  const app = mount([quiz, flashcard]);
  assert.equal(app.node('choices').children.length, 2);
  assert.equal(app.press('1'), true);
  assert.equal(app.state().modelContent.correct, 1);
  assert.equal(app.state().modelContent.reviewed, 0);
  app.press('2');
  assert.equal(app.writes.length, 1);
  app.node('next').click();
  app.node('reveal').click();
  assert.deepEqual(app.state().privateContent.answers, [0, true]);
  assert.equal(app.state().modelContent.answered, 1);
  assert.equal(app.state().modelContent.reviewed, 1);
  assert.equal(app.state().modelContent.correct, 1);
  app.node('next').click();
  assert.equal(app.node('feedback').children[0].textContent, '1 flashcards reviewed · 1 of 1 quiz answers correct');
  const withoutHost = mount([flashcard], undefined, { host: false });
  withoutHost.node('reveal').click();
  assert.equal(withoutHost.node('score').textContent, '1 reviewed');
});
