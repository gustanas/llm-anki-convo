#!/usr/bin/env node
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAnkiConnect, pullCards } from '../lib/anki-connect.mjs';
import { normalizeAnkiCards } from '../lib/anki-cards.mjs';
import { buildInline } from './build-inline.mjs';
import { saveSnapshot } from './anki.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/build-anki.mjs --deck "Full deck name" [--limit 5] [--skip-identical] [--output /absolute/path/while-anki.html]';

export function parseBuildArgs(args) {
  const options = { limit: 5, output: path.join(ROOT, 'dist', 'while-anki.html'), skipIdentical: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(USAGE);
    seen.add(flag);
    if (flag === '--skip-identical') { options.skipIdentical = true; continue; }
    if (!['--deck', '--limit', '--output'].includes(flag) || !args[index + 1]) throw new Error(USAGE);
    const value = args[++index];
    options[flag.slice(2)] = flag === '--limit' ? Number(value) : value;
  }
  if (!options.deck?.trim()) throw new Error(USAGE);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('Card limit must be between 1 and 100.');
  if (!path.isAbsolute(options.output) || path.extname(options.output).toLowerCase() !== '.html') throw new Error('Provide an absolute output path ending in .html.');
  // Generated Anki content belongs in ignored dist/ or outside the source tree.
  const relative = path.relative(ROOT, path.resolve(options.output));
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && !relative.startsWith(`dist${path.sep}`)) {
    throw new Error('Save private Anki widgets in this project’s ignored dist/ directory or outside the project.');
  }
  return options;
}

export async function assertPrivateOutput(output) {
  // Resolve existing directory aliases before any private content is written.
  // Reject final-component links even when their targets do not yet exist.
  try {
    if ((await lstat(output)).isSymbolicLink()) throw new Error('Anki output must not be a symbolic link.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function resolveParent(directory) {
    try { return await realpath(directory); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(directory) === directory) throw error;
      return path.join(await resolveParent(path.dirname(directory)), path.basename(directory));
    }
  }
  const root = await realpath(ROOT);
  const target = path.join(await resolveParent(path.dirname(output)), path.basename(output));
  const relative = path.relative(root, target);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && !relative.startsWith(`dist${path.sep}`)) {
    throw new Error('Private Anki output must not resolve into the project’s source files.');
  }
}

export async function buildAnki(options, client = createAnkiConnect()) {
  options = parseBuildArgs(['--deck', options.deck, '--limit', String(options.limit ?? 5), '--output', options.output ?? path.join(ROOT, 'dist', 'while-anki.html'), ...(options.skipIdentical ? ['--skip-identical'] : [])]);
  await assertPrivateOutput(options.output);
  const snapshot = await pullCards({ client, deck: options.deck, limit: options.skipIdentical ? Math.min(100, Math.max(25, options.limit * 3)) : options.limit });
  const normalized = await normalizeAnkiCards(snapshot.cards, { limit: options.limit, skipIdentical: options.skipIdentical, retrieveMediaFile: client.retrieveMediaFile });
  if (!normalized.cards.length) throw new Error('No supported cards were found. Try another deck or omit --skip-identical.');
  await buildInline(options.output, { cards: normalized.cards });
  await saveSnapshot(path.join(ROOT, 'dist', 'anki-cards.json'), normalized.cards);
  await saveSnapshot(path.join(ROOT, 'dist', 'anki-session.json'), {
    deck: options.deck, fetchedAt: snapshot.fetchedAt, limit: options.limit,
    skipIdentical: options.skipIdentical, cardIds: normalized.cards.map((card) => card.id),
  });
  return { output: options.output, count: normalized.cards.length, mediaBytes: normalized.mediaBytes, warnings: [...snapshot.warnings, ...normalized.warnings] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await buildAnki(parseBuildArgs(process.argv.slice(2)));
    console.log(`Built ${result.count} Anki practice cards (${result.mediaBytes} media bytes): ${result.output}`);
    console.log('Practice copy only: Anki scheduling is unchanged.');
    for (const warning of result.warnings) console.warn(warning);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
