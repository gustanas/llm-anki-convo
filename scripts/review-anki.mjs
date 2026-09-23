#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAnkiConnect } from '../lib/anki-connect.mjs';
import { rateReview, resumeReview, startReview, ratingName } from '../lib/anki-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/review-anki.mjs start --deck "Full deck name" [--output-dir /absolute/path] [--skip-identical]\n       node scripts/review-anki.mjs rate --session UUID --card ID --nonce UUID --ease 1..4\n       node scripts/review-anki.mjs resume --session UUID';

export function parseReviewArgs(args) {
  const [command, ...rest] = args;
  if (!['start', 'rate', 'resume'].includes(command)) throw new Error(USAGE);
  const options = { command };
  const allowed = command === 'start' ? ['--deck', '--output-dir', '--skip-identical'] : command === 'rate' ? ['--session', '--card', '--nonce', '--ease'] : ['--session'];
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (!allowed.includes(flag) || seen.has(flag)) throw new Error(USAGE);
    seen.add(flag);
    if (flag === '--skip-identical') { options.skipIdentical = true; continue; }
    const value = rest[++index];
    if (!value) throw new Error(USAGE);
    options[flag === '--output-dir' ? 'outputDir' : flag.slice(2)] = value;
  }
  if (command === 'start') {
    if (!options.deck?.trim()) throw new Error(USAGE);
    options.outputDir ??= path.join(ROOT, 'dist');
    if (!path.isAbsolute(options.outputDir)) throw new Error('Output directory must be absolute.');
  } else {
    if (!options.session) throw new Error(USAGE);
    if (command === 'rate') {
      if (!options.nonce || !options.card || !options.ease) throw new Error(USAGE);
      options.cardId = Number(options.card);
      options.ease = Number(options.ease);
      if (!Number.isSafeInteger(options.cardId) || options.cardId <= 0 || !Number.isInteger(options.ease) || options.ease < 1 || options.ease > 4) throw new Error(USAGE);
      delete options.card;
    }
  }
  return options;
}

export async function main(args = process.argv.slice(2), client) {
  const options = parseReviewArgs(args);
  const anki = client ?? createAnkiConnect({ reviewWrites: options.command === 'rate' });
  let result;
  if (options.command === 'start') result = await startReview({ client: anki, deck: options.deck, outputDir: options.outputDir, skipIdentical: options.skipIdentical });
  else if (options.command === 'resume') result = await resumeReview({ client: anki, sessionId: options.session });
  else result = await rateReview({ client: anki, sessionId: options.session, cardId: options.cardId, nonce: options.nonce, ease: options.ease });
  if (result.recorded) console.log(`Saved ${ratingName(result.ease)} in Anki.`);
  console.log(result.view.done ? `Session complete: ${result.view.reviewed} reviews saved.` : `Review card ready: ${result.view.reviewed} saved, ${result.view.remaining ?? 'more'} due/new available.`);
  console.log(`VISUALIZATION_PATH=${result.path}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
