import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { buildInline, buildInlineHtml } from '../scripts/build-inline.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILDER = path.join(ROOT, 'scripts', 'build-inline.mjs');
const TEMPLATE = '<script type="application/json" id="while-inline-cards">__WHILE_CARDS_JSON__</script>';
const CARD = {
  id: 'sample', category: 'Sample', question: 'Which choice?',
  choices: ['First', 'Second'], answerIndex: 1, explanation: 'The second choice.',
};
const FLASHCARD = { id: 'anki:1', type: 'flashcard', category: 'Languages', question: 'Bonjour', answer: 'Hello' };
const IMAGE = 'data:image/png;base64,YQ==';
const AUDIO = 'data:audio/mpeg;base64,YQ==';

function embeddedCards(html) {
  const block = html.match(/<script\b[^>]*\bid="while-inline-cards"[^>]*>([\s\S]*?)<\/script\s*>/i);
  assert.ok(block, 'The generated HTML contains the card data block.');
  return { text: block[1], cards: JSON.parse(block[1]) };
}

async function temporaryDirectory(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'while-inline-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runBuilder(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.error, undefined, 'The builder completes within its timeout.');
  return result;
}

async function isolatedProject(t) {
  const root = await temporaryDirectory(t);
  await Promise.all(['scripts', 'inline', 'data'].map((directory) => mkdir(path.join(root, directory))));
  const script = path.join(root, 'scripts', 'build-inline.mjs');
  const template = path.join(root, 'inline', 'quiz.html');
  await Promise.all([
    copyFile(BUILDER, script),
    writeFile(template, TEMPLATE),
    writeFile(path.join(root, 'data', 'cards.json'), JSON.stringify([CARD])),
  ]);
  return { root, script, template };
}

test('hostile card text stays inside the inert JSON block and round-trips exactly', () => {
  const cards = [{
    ...CARD,
    question: '</ScRiPt><script>alert("injected")</script><!-- $& $` $\' \\ Unicode: 🌙',
    choices: ['<img src=x onerror=alert(1)>', 'A < B & C > D'],
    explanation: '</script><div id="outside">not markup</div>',
  }];
  const html = buildInlineHtml(TEMPLATE, cards);
  const embedded = embeddedCards(html);
  assert.deepEqual(embedded.cards, cards);
  assert.equal(embedded.text.includes('<'), false);
  assert.equal((html.match(/<script\b/gi) || []).length, 1);
  assert.equal((html.match(/<\/script\s*>/gi) || []).length, 1);
});

test('invalid decks cannot produce unanswerable cards or ambiguous saved IDs', () => {
  const invalidDecks = [
    [],
    [{ ...CARD, answerIndex: -1 }],
    [{ ...CARD, answerIndex: CARD.choices.length }],
    [{ ...CARD, answerIndex: 0.5 }],
    [{ ...CARD, choices: ['Only one'] }],
    [{ ...CARD, choices: ['First', '   '] }],
    [{ ...CARD, question: '' }],
    [CARD, { ...CARD, question: 'Another question with the same ID' }],
  ];
  for (const deck of invalidDecks) {
    assert.throws(() => buildInlineHtml(TEMPLATE, deck), /nonempty array|invalid quiz card shape|duplicate id/);
  }
  assert.deepEqual(embeddedCards(buildInlineHtml(TEMPLATE, [{ ...CARD, answerIndex: 0 }])).cards, [{ ...CARD, answerIndex: 0 }]);
});

test('flashcards, mixed decks, and media-only sides round-trip without exposing markup', () => {
  const cards = [
    { ...FLASHCARD, answer: '</script><img src=x onerror=alert(1)>', media: { question: [{ type: 'image', src: IMAGE, alt: '<script>picture</script>' }], answer: [{ type: 'audio', src: AUDIO }] } },
    { ...FLASHCARD, id: 'anki:2', question: '', answer: '', media: { question: [{ type: 'image', src: IMAGE }], answer: [{ type: 'audio', src: AUDIO, alt: 'Pronunciation' }] } },
    CARD,
    { ...CARD, id: 'explicit-quiz', type: 'quiz' },
  ];
  const html = buildInlineHtml(TEMPLATE, cards);
  const embedded = embeddedCards(html);
  assert.deepEqual(embedded.cards, cards);
  assert.equal(embedded.text.includes('<'), false);
  assert.equal((html.match(/<script\b/gi) || []).length, 1);
});

test('unknown card types, incomplete flashcards, and unsafe media are rejected', () => {
  for (const card of [
    { ...FLASHCARD, type: 'unknown' },
    { ...CARD, type: null },
    { ...FLASHCARD, answer: undefined },
    { ...FLASHCARD, answer: '  ' },
    { ...FLASHCARD, question: '' },
    { ...FLASHCARD, answer: [] },
    { ...FLASHCARD, media: null },
    { ...FLASHCARD, media: [] },
    { ...FLASHCARD, media: { question: 'https://example.com/image.png' } },
    { ...FLASHCARD, media: { unknown: [] } },
  ]) assert.throws(() => buildInlineHtml(TEMPLATE, [card]), /unsupported card type|invalid flashcard shape|invalid or unsafe media/);

  const unsafeItems = [
    null,
    { type: 'image', src: 'https://example.com/tracker.png' },
    { type: 'image', src: 'javascript:alert(1)' },
    { type: 'image', src: 'data:image/svg+xml;base64,YQ==' },
    { type: 'image', src: 'data:text/html;base64,YQ==' },
    { type: 'image', src: 'data:image/png;base64,' },
    { type: 'image', src: 'data:image/png;base64,YQ=' },
    { type: 'image', src: 'data:image/png;base64,YQ==\n' },
    { type: 'image', src: IMAGE, alt: 3 },
    { type: 'image', src: IMAGE, onload: 'alert(1)' },
    { type: 'audio', src: IMAGE },
    { type: 'audio', src: 'data:audio/unsupported;base64,YQ==' },
    { type: 'video', src: 'data:video/mp4;base64,YQ==' },
  ];
  for (const item of unsafeItems) {
    assert.throws(() => buildInlineHtml(TEMPLATE, [{ ...FLASHCARD, media: { question: [item] } }]), /invalid or unsafe media/);
    assert.throws(() => buildInlineHtml(TEMPLATE, [{ ...CARD, media: { answer: [item] } }]), /invalid or unsafe media/);
  }
});

test('inline limits count final UTF-8 bytes and permit at most 100 cards', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => ({ ...FLASHCARD, id: `anki:${index}` }));
  assert.equal(embeddedCards(buildInlineHtml(TEMPLATE, hundred)).cards.length, 100);
  assert.throws(() => buildInlineHtml(TEMPLATE, [...hundred, { ...FLASHCARD, id: 'anki:100' }]), /at most 100 cards/);

  const base = { ...FLASHCARD, answer: 'A' };
  const answerLength = 1_000_000 - Buffer.byteLength(buildInlineHtml(TEMPLATE, [base])) + 1;
  assert.equal(Buffer.byteLength(buildInlineHtml(TEMPLATE, [{ ...base, answer: 'A'.repeat(answerLength) }])), 1_000_000);
  assert.throws(() => buildInlineHtml(TEMPLATE, [{ ...base, answer: 'A'.repeat(answerLength + 1) }]), /1,000,000 bytes/);
  assert.throws(() => buildInlineHtml(TEMPLATE, [{ ...base, answer: '🌙'.repeat(250_000) }]), /1,000,000 bytes/);
  assert.throws(() => buildInlineHtml(TEMPLATE, [{ ...base, answer: '<'.repeat(200_000) }]), /1,000,000 bytes/);
  assert.throws(() => buildInlineHtml(TEMPLATE, [{ ...FLASHCARD, media: { question: [{ type: 'image', src: `data:image/png;base64,${'AAAA'.repeat(250_000)}` }] } }]), /1,000,000 bytes/);
});

test('buildInline accepts an explicit deck or cardsPath and validates before replacing an output', async (t) => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, 'custom.html');
  const cardsPath = path.join(directory, 'custom.json');
  const cards = [{ ...FLASHCARD, media: { answer: [{ type: 'audio', src: AUDIO }] } }];
  await writeFile(cardsPath, JSON.stringify(cards));
  assert.equal(await buildInline(output, { cards }), output);
  assert.deepEqual(embeddedCards(await readFile(output, 'utf8')).cards, cards);
  await buildInline(output, { cardsPath });
  assert.deepEqual(embeddedCards(await readFile(output, 'utf8')).cards, cards);
  const existing = await readFile(output, 'utf8');
  await assert.rejects(buildInline(output, { cards, cardsPath }), /not both/);
  await assert.rejects(buildInline(output, { cardsPath: 'relative.json' }), /absolute cards path/);
  await assert.rejects(buildInline(output, { cards: [{ ...FLASHCARD, answer: 'A'.repeat(1_000_000) }] }), /1,000,000 bytes/);
  assert.equal(await readFile(output, 'utf8'), existing, 'Rejected builds leave the previous output intact.');
});

test('the CLI builds the bundled quiz from an unrelated working directory', async (t) => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, 'new', 'nested', 'quiz.html');
  const result = runBuilder(BUILDER, [output], directory);
  assert.equal(result.status, 0, result.stderr);
  const html = await readFile(output, 'utf8');
  const cards = JSON.parse(await readFile(path.join(ROOT, 'data', 'cards.json'), 'utf8'));
  assert.deepEqual(embeddedCards(html).cards, cards);
  assert.equal(html.includes('__WHILE_CARDS_JSON__'), false);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert.ok(scripts.some(([_, attributes]) => !/type="application\/json"/i.test(attributes)), 'The widget contains its interaction script.');
  for (const [, attributes, source] of scripts) {
    if (!/type="application\/json"/i.test(attributes)) assert.doesNotThrow(() => new Script(source));
  }
});

test('the standalone CLI imports a custom flashcard JSON file with --cards', async (t) => {
  const fixture = await isolatedProject(t);
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, 'imported.html');
  const cardsPath = path.join(directory, 'imported.json');
  const cards = [{ ...FLASHCARD, media: { question: [{ type: 'image', src: IMAGE }], answer: [{ type: 'audio', src: AUDIO }] } }];
  await writeFile(cardsPath, JSON.stringify(cards));
  const result = runBuilder(fixture.script, [output, '--cards', cardsPath], directory);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(embeddedCards(await readFile(output, 'utf8')).cards, cards);
  for (const args of [[output, '--cards'], [output, '--unknown', cardsPath], [output, '--cards', cardsPath, '--cards', cardsPath], [output, '--cards', 'relative.json']]) {
    const invalid = runBuilder(fixture.script, args, directory);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage:|absolute cards path/);
  }
  assert.deepEqual(embeddedCards(await readFile(output, 'utf8')).cards, cards, 'Invalid CLI arguments do not replace existing output.');
});

test('the CLI rejects invalid output arguments and direct template replacement', async (t) => {
  const fixture = await isolatedProject(t);
  const cases = [
    [],
    ['relative.html'],
    [path.join(fixture.root, 'quiz.json')],
    [fixture.template],
    [`${fixture.root}/inline/../inline/quiz.html`],
    [path.join(fixture.root, 'quiz.html'), 'unexpected-extra-argument'],
  ];
  for (const args of cases) {
    const result = runBuilder(fixture.script, args, fixture.root);
    assert.equal(result.status, 1, `Expected rejection for ${JSON.stringify(args)}`);
    assert.match(result.stderr, /Usage:|absolute output path|must not replace/);
    assert.equal(await readFile(fixture.template, 'utf8'), TEMPLATE);
  }
});

test('an output symlink cannot overwrite the source template', async (t) => {
  const fixture = await isolatedProject(t);
  const output = path.join(fixture.root, 'alias.html');
  await symlink(fixture.template, output);
  const result = runBuilder(fixture.script, [output], fixture.root);
  assert.equal(result.status, 1, 'An output symlink to the source template must be rejected.');
  assert.equal(await readFile(fixture.template, 'utf8'), TEMPLATE);
});
