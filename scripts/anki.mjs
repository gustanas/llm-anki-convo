#!/usr/bin/env node
import { mkdir, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAnkiConnect, pullCards } from '../lib/anki-connect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const USAGE = 'Usage: node scripts/anki.mjs decks\n       node scripts/anki.mjs pull --deck "Full deck name" [--limit 10] [--output /absolute/project/dist/anki-raw.json]';

export function parseArgs(args) {
  const [command, ...rest] = args;
  if (command === 'decks' && rest.length === 0) return { command };
  if (command !== 'pull') throw new Error(USAGE);
  const options = { command, limit: 10, output: path.join(DIST, 'anki-raw.json') };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!['--deck', '--limit', '--output'].includes(flag) || seen.has(flag) || !rest[index + 1]) throw new Error(USAGE);
    seen.add(flag);
    options[flag.slice(2)] = flag === '--limit' ? Number(rest[index + 1]) : rest[index + 1];
  }
  if (typeof options.deck !== 'string' || !options.deck.trim()) throw new Error(`A deck name is required.\n${USAGE}`);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('Card limit must be between 1 and 100.');
  if (!path.isAbsolute(options.output) || path.extname(options.output).toLowerCase() !== '.json' || !path.resolve(options.output).startsWith(`${DIST}${path.sep}`)) {
    throw new Error('Save private Anki snapshots to an absolute .json path inside this project’s ignored dist/ directory.');
  }
  return options;
}

export async function saveSnapshot(output, snapshot) {
  // Resolve directories before writing private data and reject aliases escaping dist/.
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const [root, dist, parent] = await Promise.all([realpath(ROOT), realpath(DIST), realpath(path.dirname(output))]);
  if (dist !== path.join(root, 'dist') || (parent !== dist && !parent.startsWith(`${dist}${path.sep}`))) throw new Error('Private snapshot output must stay inside this project’s dist/ directory.');
  const temporary = path.join(parent, `.anki-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const client = createAnkiConnect();
  if (options.command === 'decks') {
    const names = await client.deckNames();
    console.log(names.length ? names.join('\n') : 'No Anki decks were found.');
    return;
  }
  const snapshot = await pullCards({ client, deck: options.deck, limit: options.limit });
  await saveSnapshot(options.output, snapshot);
  console.log(`Saved ${snapshot.cards.length} card(s): ${snapshot.selection.due} due, ${snapshot.selection.new} new, ${snapshot.selection.other} other.`);
  console.log(options.output);
  for (const warning of snapshot.warnings) console.warn(warning);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
