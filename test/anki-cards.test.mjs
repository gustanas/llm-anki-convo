import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, htmlToText, normalizeAnkiCards } from '../lib/anki-cards.mjs';
import { buildInlineHtml } from '../scripts/build-inline.mjs';

// All fields, media bytes, deck names and IDs in this file are synthetic.
const rawCard = (overrides = {}) => ({
  cardId: 1, deckName: 'Synthetic', ord: 0, fields: {},
  question: '<div>Front</div>',
  answer: '<div>Front</div><hr id="answer"><div>Back</div>',
  ...overrides,
});
const field = (value) => ({ value, order: 0 });
const base64 = (text) => Buffer.from(text).toString('base64');

test('HTML extraction decodes text once and removes executable or hidden markup', () => {
  assert.equal(decodeEntities('&constructor; &toString; &unknown;'), '&constructor; &toString; &unknown;');
  assert.equal(decodeEntities('&amp; &lt; &gt; &quot; &apos; &#65; &#x65E5; &#xD800; &#0;'), '& < > " \' A 日 � �');
  assert.equal(htmlToText('<style>.card {display:none}</style><script>danger()</script><!-- secret --><iframe>hidden</iframe><object>hidden</object><template>hidden</template><div>A&nbsp;&amp; B<br>C</div><ruby>日<rt>にち</rt></ruby>'), 'A & B\nC\n日 (にち)');
  assert.equal(htmlToText('&lt;script&gt;literal text&lt;/script&gt; &amp;lt;'), '<script>literal text</script> &lt;');
  assert.equal(htmlToText('Visible<script>unterminated'), 'Visible');
});

test('rendered basic and cloze sides keep actual answers and satisfy the inline builder', async () => {
  const result = await normalizeAnkiCards([
    rawCard(),
    rawCard({ cardId: 2, question: 'The capital is <span class="cloze">[city]</span>.', answer: 'The capital is <span class="cloze">Paris</span>.' }),
  ]);
  assert.deepEqual(result.cards.map(({ question, answer }) => [question, answer]), [['Front', 'Back'], ['The capital is [city].', 'The capital is Paris.']]);
  assert.equal(result.cards[0].type, 'flashcard');
  assert.deepEqual(result.warnings, []);
  assert.doesNotThrow(() => buildInlineHtml('<script type="application/json">__WHILE_CARDS_JSON__</script>', result.cards));
});

test('only a real answer-divider id and actual media src attributes are used', async () => {
  const requested = [];
  const result = await normalizeAnkiCards([rawCard({
    question: '<img title=\'src="wrong.png"\' data-src="also-wrong.png" src="right.png" alt="A &amp; B">Front',
    answer: 'Keep this<hr data-id="answer" title=\'id="answer"\'>And this',
  })], { retrieveMediaFile: async (name) => { requested.push(name); return base64('image'); } });
  assert.deepEqual(requested, ['right.png']);
  assert.equal(result.cards[0].answer, 'Keep this\nAnd this');
  assert.equal(result.cards[0].media.question[0].alt, 'A & B');
});

test('Jlab listening cards use named content fields without addon template UI', async () => {
  const requested = [];
  const result = await normalizeAnkiCards([rawCard({
    question: '<div>Addon controls</div>', answer: '<div>More addon controls</div>',
    fields: {
      'Jlab-ListeningFront': field('日本語'), 'Other-Front': field('Reading'),
      Audio: field('[sound:voice.mp3]'), Image: field('<img src="picture.png">'),
      RemarksFront: field('A hint'), RemarksBack: field('Meaning'),
      'Jlab-Translation': field('Translation'), 'Other-Back': field('More notes'),
      References: field('Reference'), Source: field('Synthetic source'),
    },
  })], { retrieveMediaFile: async (name) => { requested.push(name); return base64('media'); } });
  assert.equal(result.cards[0].question, '日本語\nReading\nA hint');
  assert.equal(result.cards[0].answer, 'Meaning\n\nTranslation\n\nMore notes\n\nReference\n\nSource: Synthetic source');
  assert.deepEqual(requested, ['voice.mp3', 'picture.png']);
  assert.deepEqual(result.cards[0].media.question.map((item) => item.type), ['audio', 'image']);
  assert.equal(result.cards[0].question.includes('Addon'), false);
});

test('media is local, decoded once, deduplicated per side, and cached across sides', async () => {
  const requested = [];
  const result = await normalizeAnkiCards([rawCard({
    question: '[sound:some%20sound.mp3]<audio src="some%20sound.mp3"></audio><img src="https://example.test/private.png"><img src="../outside.png"><img src="vector.svg">Front',
    answer: '[sound:some%20sound.mp3]Back',
  })], { retrieveMediaFile: async (name) => { requested.push(name); return base64('a'); } });
  assert.deepEqual(requested, ['some sound.mp3']);
  assert.equal(result.cards[0].media.question.length, 1);
  assert.equal(result.cards[0].media.answer.length, 1);
  assert.equal(result.mediaBytes, 2, 'Repeated embedded data counts toward actual output size.');
  assert.match(result.warnings.join(' '), /remote or unsupported/);
});

test('missing, invalid and unavailable media produce warnings without fabricating answers', async () => {
  const result = await normalizeAnkiCards([rawCard({ question: '[sound:missing.mp3]<img src="invalid.png"><img src="failure.jpg">Front' })], {
    retrieveMediaFile: async (name) => {
      if (name === 'missing.mp3') return false;
      if (name === 'failure.jpg') throw new Error('Synthetic retrieval failure');
      return 'not base64!';
    },
  });
  assert.equal(result.cards.length, 1);
  assert.deepEqual(result.cards[0].media.question, []);
  assert.match(result.warnings.join(' '), /missing or invalid/);
  assert.match(result.warnings.join(' '), /Could not load/);
  const noLoader = await normalizeAnkiCards([rawCard({ question: '<img src="image.png">Front' })]);
  assert.match(noLoader.warnings.join(' '), /Media was not loaded/);
});

test('per-file and total budgets prefer audio over same-side illustrations', async () => {
  const result = await normalizeAnkiCards([rawCard({ question: '<img src="large.png">[sound:voice.mp3]Front', answer: '[sound:extra.mp3]Back' })], {
    retrieveMediaFile: async (name) => base64(name === 'large.png' ? 'large' : 'ab'),
    maxFileBytes: 3, maxMediaBytes: 3,
  });
  assert.equal(result.mediaBytes, 2);
  assert.deepEqual(result.cards[0].media.question.map((item) => item.type), ['audio']);
  assert.deepEqual(result.cards[0].media.answer, []);
  assert.match(result.warnings.join(' '), /size budget/);
});

test('discarded cards do not spend the output media budget', async () => {
  const result = await normalizeAnkiCards([
    rawCard({ question: '', answer: '<img src="picture.png">' }),
    rawCard({ cardId: 2, question: 'Identify the picture', answer: '<img src="picture.png">' }),
  ], { retrieveMediaFile: async () => base64('photo'), maxMediaBytes: 5, maxFileBytes: 5 });
  assert.deepEqual(result.cards.map((card) => card.id), ['anki:2']);
  assert.equal(result.mediaBytes, 5);
  assert.equal(result.cards[0].answer, '');
  assert.doesNotThrow(() => buildInlineHtml('__WHILE_CARDS_JSON__', result.cards));
});

test('skip-identical and unsupported empty cards still allow later useful cards', async () => {
  const result = await normalizeAnkiCards([
    rawCard({ question: 'Same', answer: 'Same' }),
    rawCard({ cardId: 2, question: '<script>empty()</script>', answer: 'Back' }),
    rawCard({ cardId: 3 }),
    rawCard({ cardId: 4 }),
  ], { skipIdentical: true, limit: 1 });
  assert.deepEqual(result.cards.map((card) => card.id), ['anki:3']);
  assert.match(result.warnings.join(' '), /identical fronts and backs/);
  assert.match(result.warnings.join(' '), /no supported text or media/);
  assert.equal((await normalizeAnkiCards([rawCard({ question: 'Same', answer: 'Same' })])).cards.length, 1);
});

test('single rendered audio players resolve conventional fields and ambiguous players warn', async () => {
  const requested = [];
  const result = await normalizeAnkiCards([
    rawCard({ question: '[anki:play:q:0]', fields: { Sound: field('[sound:voice.ogg]') } }),
    rawCard({ cardId: 2, question: '[anki:play:q:0][anki:play:q:1]Front', fields: { Audio: field('[sound:first.mp3][sound:second.mp3]') } }),
    rawCard({ cardId: 3, question: '[anki:play:q:0]' }),
  ], { retrieveMediaFile: async (name) => { requested.push(name); return base64('audio'); } });
  assert.deepEqual(requested, ['voice.ogg']);
  assert.deepEqual(result.cards.map((card) => card.id), ['anki:1', 'anki:2']);
  assert.equal(result.cards[0].question, '');
  assert.equal(result.cards[0].media.question[0].type, 'audio');
  assert.equal(result.cards[1].question, 'Front');
  assert.match(result.warnings.join(' '), /could not be resolved/);
});

test('Basic card player tokens recover local sound from their sole original field', async () => {
  const requested = [];
  const result = await normalizeAnkiCards([
    rawCard({
      question: 'Listen [anki:play:q:0]',
      answer: 'Listen [anki:play:q:0]<hr id="answer">Translation',
      fields: { Front: field('Listen [sound:front.wav]'), Back: field('Translation') },
    }),
    rawCard({
      cardId: 2,
      question: 'Prompt',
      answer: 'Prompt<hr id="answer">Pronunciation [anki:play:a:0]',
      fields: { Front: field('Prompt'), Back: field('Pronunciation [sound:back.mp3]') },
    }),
  ], { retrieveMediaFile: async (name) => { requested.push(name); return base64('audio'); } });
  assert.deepEqual(requested, ['front.wav', 'back.mp3']);
  assert.deepEqual(result.cards[0].media.question.map((item) => item.type), ['audio']);
  assert.deepEqual(result.cards[0].media.answer, []);
  assert.deepEqual(result.cards[1].media.question, []);
  assert.deepEqual(result.cards[1].media.answer.map((item) => item.type), ['audio']);
  assert.deepEqual(result.warnings, []);
});

test('stock Basic cards map separate Front and Back sounds to their rendered sides', async () => {
  const requested = [];
  const result = await normalizeAnkiCards([
    rawCard({
      modelName: 'Basic',
      question: 'Listen [anki:play:q:0]',
      answer: 'Listen [anki:play:q:0]<hr id="answer">Meaning [anki:play:a:0]',
      fields: { Front: field('Listen [sound:front.wav]'), Back: field('Meaning [sound:back.mp3]') },
    }),
    rawCard({
      cardId: 2,
      modelName: 'Custom',
      question: 'Listen [anki:play:q:0]',
      fields: { Front: field('[sound:custom-front.wav]'), Back: field('[sound:custom-back.mp3]') },
    }),
  ], { retrieveMediaFile: async (name) => { requested.push(name); return base64('audio'); } });
  assert.deepEqual(requested, ['front.wav', 'back.mp3']);
  assert.equal(result.cards[0].media.question.length, 1);
  assert.equal(result.cards[0].media.answer.length, 1);
  assert.deepEqual(result.cards[1].media.question, [], 'Unknown templates with two possible files are not guessed.');
  assert.match(result.warnings.join(' '), /could not be resolved/);
});

test('rendered and raw references cannot create duplicate players or load remote files', async () => {
  const requested = [];
  const result = await normalizeAnkiCards([
    rawCard({
      question: '[anki:play:q:0]<audio src="voice%2Ewav"></audio><audio src="voice.wav"></audio>Listen',
      fields: { Front: field('[sound:voice.wav]Listen') },
    }),
    rawCard({
      cardId: 2,
      question: '[anki:play:q:0]Listen',
      fields: { Front: field('[sound:https://example.test/remote.wav]Listen') },
    }),
  ], { retrieveMediaFile: async (name) => { requested.push(name); return base64('audio'); } });
  assert.deepEqual(requested, ['voice.wav']);
  assert.equal(result.cards[0].media.question.length, 1);
  assert.equal(result.cards[1].media.question.length, 0);
  assert.match(result.warnings.join(' '), /remote or unsupported media/);
});

test('normalizer validates options and skips malformed raw cards', async () => {
  await assert.rejects(normalizeAnkiCards(null), /cardsInfo array/);
  await assert.rejects(normalizeAnkiCards([], { limit: 101 }), /between 1 and 100/);
  await assert.rejects(normalizeAnkiCards([], { maxMediaBytes: -1 }), /nonnegative integers/);
  const result = await normalizeAnkiCards([null, {}, rawCard({ cardId: -1 }), rawCard()]);
  assert.equal(result.cards.length, 1);
  assert.match(result.warnings.join(' '), /incomplete Anki content/);
});
