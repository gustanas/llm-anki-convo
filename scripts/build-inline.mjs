#!/usr/bin/env node
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = path.join(ROOT, 'inline', 'quiz.html');
const PLACEHOLDER = '__WHILE_CARDS_JSON__';
const MAX_CARDS = 100;
const MAX_OUTPUT_BYTES = 1_000_000;
const nonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const mediaSources = {
  image: /^data:image\/(?:png|jpeg|gif|webp);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  audio: /^data:audio\/(?:mpeg|mp3|ogg|wav|mp4|aac|flac);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
};

function validateMedia(media, cardNumber) {
  if (media === undefined) return;
  const invalid = () => new Error(`Card ${cardNumber} has invalid or unsafe media.`);
  if (!media || typeof media !== 'object' || Array.isArray(media) || Object.keys(media).some(key => !['question', 'answer'].includes(key))) throw invalid();
  for (const side of ['question', 'answer']) {
    if (media[side] === undefined) continue;
    if (!Array.isArray(media[side])) throw invalid();
    for (const item of media[side]) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          !['image', 'audio'].includes(item.type) || typeof item.src !== 'string' ||
          (item.alt !== undefined && typeof item.alt !== 'string') ||
          Object.keys(item).some(key => !['type', 'src', 'alt'].includes(key))) throw invalid();
      if (Buffer.byteLength(item.src, 'utf8') > MAX_OUTPUT_BYTES) throw new Error(`The inline output must not exceed ${MAX_OUTPUT_BYTES.toLocaleString('en-US')} bytes.`);
      if (!mediaSources[item.type].test(item.src)) throw invalid();
    }
  }
}

export function buildInlineHtml(template, cards) {
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('Cards must be a nonempty array.');
  if (cards.length > MAX_CARDS) throw new Error(`A practice deck must contain at most ${MAX_CARDS} cards.`);
  const ids = new Set();
  for (const [index, card] of cards.entries()) {
    if (!card || typeof card !== 'object' || Array.isArray(card) || !['id', 'category'].every(key => nonemptyString(card[key]))) {
      throw new Error(`Card ${index + 1} has an invalid quiz card shape.`);
    }
    if (card.type !== undefined && !['quiz', 'flashcard'].includes(card.type)) throw new Error(`Card ${index + 1} has an unsupported card type.`);
    validateMedia(card.media, index + 1);
    if (card.type === 'flashcard') {
      if (!['question', 'answer'].every(side => typeof card[side] === 'string' && (nonemptyString(card[side]) || card.media?.[side]?.length > 0))) {
        throw new Error(`Card ${index + 1} has an invalid flashcard shape.`);
      }
    } else if (!['question', 'explanation'].every(key => nonemptyString(card[key])) ||
        !Array.isArray(card.choices) || card.choices.length < 2 || !card.choices.every(nonemptyString) ||
        !Number.isInteger(card.answerIndex) || card.answerIndex < 0 || card.answerIndex >= card.choices.length) {
      throw new Error(`Card ${index + 1} has an invalid quiz card shape.`);
    }
    if (ids.has(card.id)) throw new Error(`Card ${index + 1} has a duplicate id.`);
    ids.add(card.id);
  }
  if (typeof template !== 'string' || template.split(PLACEHOLDER).length !== 2) {
    throw new Error(`The inline template must contain exactly one ${PLACEHOLDER} placeholder.`);
  }
  // JSON sits inside a script data block. Escape every opening angle bracket so
  // card text cannot close that block, while JSON.parse restores the exact text.
  const json = JSON.stringify(cards).replaceAll('<', '\\u003c');
  const html = template.replace(PLACEHOLDER, () => json);
  if (Buffer.byteLength(html, 'utf8') > MAX_OUTPUT_BYTES) throw new Error(`The inline output must not exceed ${MAX_OUTPUT_BYTES.toLocaleString('en-US')} bytes.`);
  return html;
}

export async function buildInline(outputPath, { cards, cardsPath } = {}) {
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.html') {
    throw new Error('Provide one absolute output path ending in .html.');
  }
  if (path.resolve(outputPath) === TEMPLATE_PATH) throw new Error('The output must not replace the inline template.');
  try {
    if (await realpath(outputPath) === await realpath(TEMPLATE_PATH)) {
      throw new Error('The output must not replace the inline template.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (cards !== undefined && cardsPath !== undefined) throw new Error('Provide cards or cardsPath, not both.');
  if (cardsPath !== undefined && (typeof cardsPath !== 'string' || !path.isAbsolute(cardsPath) || path.extname(cardsPath).toLowerCase() !== '.json')) {
    throw new Error('Provide an absolute cards path ending in .json.');
  }
  const [template, deck] = await Promise.all([
    readFile(TEMPLATE_PATH, 'utf8'),
    cards !== undefined ? cards : readFile(cardsPath ?? path.join(ROOT, 'data', 'cards.json'), 'utf8').then(JSON.parse),
  ]);
  const html = buildInlineHtml(template, deck);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  return outputPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 && !(process.argv.length === 5 && process.argv[3] === '--cards')) throw new Error('Usage: node scripts/build-inline.mjs /absolute/path/while-quiz.html [--cards /absolute/path/cards.json]');
    console.log(`Built inline quiz: ${await buildInline(process.argv[2], { cardsPath: process.argv[4] })}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
