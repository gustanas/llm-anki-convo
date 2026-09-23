import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { assertPrivateOutput, parseBuildArgs } from '../scripts/build-anki.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = path.join(ROOT, 'dist');

async function temporaryDirectory(t, parent = os.tmpdir()) {
  await mkdir(parent, { recursive: true });
  const directory = await realpath(await mkdtemp(path.join(parent, 'while-build-anki-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function isolatedProject(t) {
  const root = await temporaryDirectory(t);
  const files = [
    'scripts/build-anki.mjs', 'scripts/build-inline.mjs', 'scripts/anki.mjs',
    'lib/anki-connect.mjs', 'lib/anki-cards.mjs', 'inline/quiz.html',
    'data/cards.json', '.gitignore',
  ];
  await Promise.all(['scripts', 'lib', 'inline', 'data'].map(directory => mkdir(path.join(root, directory))));
  await Promise.all(files.map(file => copyFile(path.join(ROOT, file), path.join(root, file))));
  const build = await import(pathToFileURL(path.join(root, 'scripts/build-anki.mjs')).href);
  return { root, ...build };
}

test('Anki build arguments have useful defaults and accept explicit bounded options', () => {
  assert.deepEqual(parseBuildArgs(['--deck', 'Languages::French']), {
    deck: 'Languages::French', limit: 5, output: path.join(DIST, 'while-anki.html'), skipIdentical: false,
  });
  const output = path.join(os.tmpdir(), 'while-anki-argument-test.html');
  assert.deepEqual(parseBuildArgs(['--skip-identical', '--output', output, '--limit', '100', '--deck', 'French']), {
    deck: 'French', limit: 100, output, skipIdentical: true,
  });
  assert.equal(parseBuildArgs(['--deck', 'French', '--limit', '1']).limit, 1);
  for (const args of [
    [], ['--deck'], ['--deck', '   '], ['--deck', 'French', '--unknown', 'value'],
    ['--deck', 'French', '--limit'], ['--deck', 'French', '--deck', 'Other'],
    ['--deck', 'French', '--skip-identical', '--skip-identical'],
    ['--deck', 'French', '--limit', '0'], ['--deck', 'French', '--limit', '101'],
    ['--deck', 'French', '--limit', '1.5'], ['--deck', 'French', '--limit', 'NaN'],
    ['--deck', 'French', '--output', 'relative.html'],
    ['--deck', 'French', '--output', path.join(os.tmpdir(), 'private.json')],
  ]) assert.throws(() => parseBuildArgs(args), /Usage:|between 1 and 100|absolute output path/);
});

test('lexical output protection allows ignored dist or external HTML, never source-tree lookalikes', () => {
  for (const output of [
    path.join(ROOT, 'inline', 'quiz.html'), path.join(ROOT, 'data', 'private.html'),
    path.join(ROOT, 'private.html'), path.join(ROOT, 'dist-not-private', 'private.html'),
    path.join(ROOT, 'dist', '..', 'private.html'),
    `${DIST}/nested/../../inline/private.html`,
  ]) assert.throws(() => parseBuildArgs(['--deck', 'French', '--output', output]), /ignored dist/);

  const nested = path.join(DIST, 'sessions', 'practice.html');
  assert.equal(parseBuildArgs(['--deck', 'French', '--output', nested]).output, nested);
  const sibling = path.join(path.dirname(path.resolve(ROOT)), `${path.basename(path.resolve(ROOT))}-outside`, 'practice.html');
  assert.equal(parseBuildArgs(['--deck', 'French', '--output', sibling]).output, sibling);
});

test('canonical output protection resolves parent aliases and rejects all final-component symlinks', async (t) => {
  const privateFixture = await temporaryDirectory(t, DIST);
  const externalFixture = await temporaryDirectory(t);
  const sourceAlias = path.join(privateFixture, 'source-alias');
  const externalAlias = path.join(externalFixture, 'source-alias');
  await Promise.all([
    symlink(path.join(ROOT, 'inline'), sourceAlias, 'dir'),
    symlink(path.join(ROOT, 'inline'), externalAlias, 'dir'),
  ]);
  for (const candidate of [
    path.join(sourceAlias, 'private.html'),
    path.join(sourceAlias, 'not-created', 'nested', 'private.html'),
    path.join(externalAlias, 'not-created', 'private.html'),
  ]) await assert.rejects(assertPrivateOutput(candidate), /resolve into the project’s source/);

  const outsideFile = path.join(externalFixture, 'existing.html');
  await writeFile(outsideFile, 'unchanged');
  const finalLink = path.join(privateFixture, 'final-link.html');
  const danglingLink = path.join(privateFixture, 'dangling-link.html');
  await Promise.all([
    symlink(outsideFile, finalLink),
    symlink(path.join(externalFixture, 'does-not-exist.html'), danglingLink),
  ]);
  await assert.rejects(assertPrivateOutput(finalLink), /must not be a symbolic link/);
  await assert.rejects(assertPrivateOutput(danglingLink), /must not be a symbolic link/);
  assert.equal(await readFile(outsideFile, 'utf8'), 'unchanged');

  const safeAlias = path.join(privateFixture, 'external-alias');
  await symlink(externalFixture, safeAlias, 'dir');
  for (const candidate of [
    path.join(privateFixture, 'not-created', 'practice.html'),
    path.join(externalFixture, 'not-created', 'nested', 'practice.html'),
    path.join(safeAlias, 'not-created', 'practice.html'),
    outsideFile,
  ]) await assert.doesNotReject(assertPrivateOutput(candidate));
});

test('buildAnki uses a read-only mock client, normalizes unsafe HTML, and stores ignored private snapshots', async (t) => {
  // Importing a temporary copy gives its private snapshots a different ROOT.
  // The real dist/anki-cards.json and dist/anki-session.json are never written.
  const fixture = await isolatedProject(t);
  const external = await temporaryDirectory(t);
  const output = path.join(external, 'while-anki.html');
  const calls = [];
  const media = { 'question.png': Buffer.from('picture').toString('base64'), 'answer.mp3': Buffer.from('audio').toString('base64') };
  const raw = {
    cardId: 101, deckName: 'French', queue: 0,
    fields: { Front: { value: 'Bonjour', order: 0 }, Back: { value: 'Hello', order: 1 } },
    question: '<b>Bonjour</b><img src="question.png" onerror="alert(1)"><script>window.untrustedCode = true</script><img src="https://example.com/tracker.png">',
    answer: '<b>Bonjour</b><hr id="answer"><div>Hello &amp; welcome</div>[sound:answer.mp3]<iframe src="https://example.com">Untrusted frame</iframe>',
  };
  const client = {
    version: async () => { calls.push(['version']); return 6; },
    deckNames: async () => { calls.push(['deckNames']); return ['French']; },
    findCards: async query => { calls.push(['findCards', query]); return [101]; },
    cardsInfo: async ids => { calls.push(['cardsInfo', ids]); return [raw]; },
    retrieveMediaFile: async filename => { calls.push(['retrieveMediaFile', filename]); assert.ok(Object.hasOwn(media, filename)); return media[filename]; },
  };
  const result = await fixture.buildAnki({ deck: 'French', limit: 1, output }, client);
  assert.equal(result.output, output);
  assert.equal(result.count, 1);
  assert.equal(result.mediaBytes, 12);
  assert.match(result.warnings.join(' '), /remote or unsupported media/);
  assert.deepEqual(calls.map(([action]) => action), ['version', 'deckNames', 'findCards', 'cardsInfo', 'retrieveMediaFile', 'retrieveMediaFile']);
  assert.deepEqual(calls.filter(([action]) => action === 'retrieveMediaFile').map(([, filename]) => filename), ['question.png', 'answer.mp3']);
  assert.match(calls.find(([action]) => action === 'findCards')[1], /-is:suspended -is:buried is:due$/);

  const html = await readFile(output, 'utf8');
  assert.ok(Buffer.byteLength(html) <= 1_000_000);
  assert.doesNotMatch(html, /onerror=|window\.untrustedCode|<iframe|example\.com/);
  const block = html.match(/<script\b[^>]*\bid="while-inline-cards"[^>]*>([\s\S]*?)<\/script\s*>/i);
  assert.ok(block, 'The inline output contains its embedded practice deck.');
  const cards = JSON.parse(block[1]);
  assert.equal(cards[0].type, 'flashcard');
  assert.equal(cards[0].question, 'Bonjour');
  assert.equal(cards[0].answer, 'Hello & welcome');
  assert.equal(cards[0].media.question[0].src, `data:image/png;base64,${media['question.png']}`);
  assert.equal(cards[0].media.answer[0].src, `data:audio/mpeg;base64,${media['answer.mp3']}`);

  const snapshotPaths = ['dist/anki-cards.json', 'dist/anki-session.json'];
  const contents = await Promise.all(snapshotPaths.map(file => readFile(path.join(fixture.root, file), 'utf8')));
  assert.deepEqual(JSON.parse(contents[0]), cards);
  const session = JSON.parse(contents[1]);
  assert.equal(session.deck, 'French');
  assert.equal(session.limit, 1);
  assert.equal(session.skipIdentical, false);
  assert.deepEqual(session.cardIds, ['anki:101']);
  assert.ok(Number.isFinite(Date.parse(session.fetchedAt)));
  for (const file of snapshotPaths) assert.equal((await stat(path.join(fixture.root, file))).mode & 0o777, 0o600);

  const init = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', fixture.root], { encoding: 'utf8', timeout: 3000 });
  assert.equal(init.status, 0, init.stderr || init.error?.message);
  const ignored = spawnSync('git', ['check-ignore', '--no-index', ...snapshotPaths], { cwd: fixture.root, encoding: 'utf8', timeout: 3000 });
  assert.equal(ignored.status, 0, ignored.stderr || ignored.error?.message);
  assert.deepEqual(ignored.stdout.trim().split('\n'), snapshotPaths);

  await assert.rejects(fixture.buildAnki({ deck: 'French', output: path.join(external, 'empty.html') }, { ...client, findCards: async () => [] }), /No supported cards were found/);
  assert.deepEqual(await Promise.all(snapshotPaths.map(file => readFile(path.join(fixture.root, file), 'utf8'))), contents, 'An empty import preserves the last successful private snapshot.');
});
