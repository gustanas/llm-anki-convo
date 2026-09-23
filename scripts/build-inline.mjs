#!/usr/bin/env node
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = path.join(ROOT, 'inline', 'quiz.html');
const PLACEHOLDER = '__WHILE_CARDS_JSON__';
const nonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;

export function buildInlineHtml(template, cards) {
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('Cards must be a nonempty array.');
  const ids = new Set();
  for (const [index, card] of cards.entries()) {
    if (!card || typeof card !== 'object' ||
        !['id', 'category', 'question', 'explanation'].every((key) => nonemptyString(card[key])) ||
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
  return template.replace(PLACEHOLDER, () => json);
}

export async function buildInline(outputPath) {
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
  const [template, data] = await Promise.all([
    readFile(TEMPLATE_PATH, 'utf8'),
    readFile(path.join(ROOT, 'data', 'cards.json'), 'utf8'),
  ]);
  const html = buildInlineHtml(template, JSON.parse(data));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  return outputPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/build-inline.mjs /absolute/path/while-quiz.html');
    console.log(`Built inline quiz: ${await buildInline(process.argv[2])}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
