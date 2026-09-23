import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { buildInlineHtml } from '../scripts/build-inline.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILDER = path.join(ROOT, 'scripts', 'build-inline.mjs');
const TEMPLATE = '<script type="application/json" id="while-inline-cards">__WHILE_CARDS_JSON__</script>';
const CARD = {
  id: 'sample', category: 'Sample', question: 'Which choice?',
  choices: ['First', 'Second'], answerIndex: 1, explanation: 'The second choice.',
};

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
