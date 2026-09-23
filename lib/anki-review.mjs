import { randomUUID } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deckQuery } from './anki-connect.mjs';
import { normalizeAnkiCards } from './anki-cards.mjs';
import { buildInlineHtml } from '../scripts/build-inline.mjs';
import { assertPrivateOutput } from '../scripts/build-anki.mjs';
import { saveSnapshot } from '../scripts/anki.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_DIR = path.join(ROOT, 'dist', 'review-sessions');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABELS = ['Again', 'Hard', 'Good', 'Easy'];
const TEMPLATE = path.join(ROOT, 'inline', 'review.html');

const validateId = (value, label) => {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
};
const sessionPath = (id) => path.join(SESSION_DIR, `${validateId(id, 'review session')}.json`);
const outputPath = (session) => path.join(session.outputDir, `while-review-${session.id}-${session.reviewed}.html`);

export async function findNextReview(client, deck, { skipIdentical = false } = {}) {
  const base = `${deckQuery(deck)} -is:suspended -is:buried`;
  const [due, fresh] = await Promise.all([
    client.findCards(`${base} is:due`),
    client.findCards(`${base} is:new`),
  ]);
  const seen = new Set();
  const ids = [...due, ...fresh].filter((id) => !seen.has(id) && seen.add(id));
  let skipped = 0;
  for (let offset = 0; offset < ids.length; offset += 25) {
    const batch = await client.cardsInfo(ids.slice(offset, offset + 25));
    const byId = new Map(batch.filter(Boolean).map((card) => [card.cardId, card]));
    for (const id of ids.slice(offset, offset + 25)) {
      const raw = byId.get(id);
      if (!raw || raw.queue < 0 || (raw.deckName !== deck && !raw.deckName?.startsWith(`${deck}::`))) continue;
      const result = await normalizeAnkiCards([raw], { limit: 1, skipIdentical, retrieveMediaFile: client.retrieveMediaFile });
      if (!result.cards.length) { skipped++; continue; }
      return { raw, card: result.cards[0], remaining: ids.length, due: due.length, fresh: fresh.length, skipped, warnings: result.warnings };
    }
  }
  return { raw: null, card: null, remaining: 0, due: due.length, fresh: fresh.length, skipped, warnings: [] };
}

export function renderReviewHtml(template, view) {
  if (view.card) buildInlineHtml('__WHILE_CARDS_JSON__', [view.card]);
  if (typeof template !== 'string' || template.split('__WHILE_REVIEW_JSON__').length !== 2) throw new Error('Invalid Anki review template.');
  const html = template.replace('__WHILE_REVIEW_JSON__', () => JSON.stringify(view).replaceAll('<', '\\u003c'));
  if (Buffer.byteLength(html, 'utf8') > 1_000_000) throw new Error('Anki review card exceeds the inline size limit.');
  return html;
}

async function writeView(session, client) {
  let next = null;
  if (!session.current) {
    next = await findNextReview(client, session.deck, { skipIdentical: session.skipIdentical });
    if (next.raw) {
      session.current = {
        cardId: next.raw.cardId,
        reps: next.raw.reps,
        nonce: randomUUID(),
      };
    }
  }
  if (session.current && !next) {
    const raw = (await client.cardsInfo([session.current.cardId]))[0];
    if (!raw || raw.reps !== session.current.reps) throw new Error('The active card changed in Anki. Resume the session to refresh it.');
    const normalized = await normalizeAnkiCards([raw], { limit: 1, retrieveMediaFile: client.retrieveMediaFile });
    if (!normalized.cards.length) throw new Error('The active card has no supported front or back. No review was saved.');
    next = { raw, card: normalized.cards[0], remaining: null, due: null, fresh: null, warnings: normalized.warnings };
  }
  const view = {
    version: 1,
    sessionId: session.id,
    deck: session.deck,
    reviewed: session.reviewed,
    done: !session.current,
    card: next?.card ?? null,
    cardId: session.current?.cardId ?? null,
    nonce: session.current?.nonce ?? null,
    intervals: next?.raw?.nextReviews?.slice(0, 4) ?? [],
    remaining: next?.remaining ?? null,
    due: next?.due ?? null,
    fresh: next?.fresh ?? null,
  };
  const file = outputPath(session);
  await assertPrivateOutput(file);
  const template = await readFile(TEMPLATE, 'utf8');
  const html = renderReviewHtml(template, view);
  await saveSnapshot(sessionPath(session.id), session);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, html, { mode: 0o600 });
  return { path: file, view, warnings: next?.warnings ?? [] };
}

export async function startReview({ client, deck, outputDir, skipIdentical = false }) {
  if (!client || typeof client.findCards !== 'function' || typeof deck !== 'string' || !deck.trim()) throw new Error('Provide an Anki client and deck name.');
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw new Error('Provide an absolute output directory.');
  if (!(await client.deckNames()).includes(deck)) throw new Error('Deck not found in Anki.');
  const session = { version: 1, id: randomUUID(), deck, outputDir, skipIdentical: !!skipIdentical, reviewed: 0, current: null, pending: null, lastReceipt: null };
  return { sessionId: session.id, ...(await writeView(session, client)) };
}

export async function resumeReview({ client, sessionId }) {
  const session = JSON.parse(await readFile(sessionPath(sessionId), 'utf8'));
  if (session.version !== 1 || session.id !== sessionId || session.pending) throw new Error('Review is incomplete or still saving. Retry its last rating.');
  return { sessionId, ...(await writeView(session, client)) };
}

export async function rateReview({ client, sessionId, cardId, nonce, ease }) {
  validateId(nonce, 'review nonce');
  if (!Number.isSafeInteger(cardId) || cardId <= 0 || !Number.isInteger(ease) || ease < 1 || ease > 4) throw new Error('Invalid card or Anki rating.');
  const file = sessionPath(sessionId);
  const lock = `${file}.lock`;
  const handle = await open(lock, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('This review is already being saved. Wait for it to finish.');
    throw error;
  });
  try {
    const session = JSON.parse(await readFile(file, 'utf8'));
    if (session.version !== 1 || session.id !== sessionId) throw new Error('Invalid review session.');
    if (session.lastReceipt?.nonce === nonce) {
      if (session.lastReceipt.cardId !== cardId || session.lastReceipt.ease !== ease) throw new Error('This rating does not match the saved review. No new grade was sent.');
      return { sessionId, recorded: true, ease: session.lastReceipt.ease, ...(await writeView(session, client)) };
    }
    if (!session.current || session.current.cardId !== cardId || session.current.nonce !== nonce) throw new Error('This card is no longer the active review. No grade was saved.');
    if (session.pending && (session.pending.nonce !== nonce || session.pending.ease !== ease)) throw new Error('A different rating is already pending for this card.');
    if (!session.pending) {
      session.pending = { cardId, nonce, ease, startedAt: Date.now() };
      await saveSnapshot(file, session);
    }
    const current = (await client.cardsInfo([cardId]))[0];
    if (!current) throw new Error('The card is missing in Anki; no grade was saved.');
    const beforeReps = current.reps;
    if (beforeReps !== session.current.reps) {
      const history = await client.reviewHistory(cardId);
      const matched = history.some((entry) => entry.ease === ease && entry.id >= session.pending.startedAt - 3000);
      if (!matched) throw new Error('The card changed in Anki, and this rating could not be verified. No second grade was sent.');
    } else {
      if (current.queue < 0 || (current.deckName !== session.deck && !current.deckName?.startsWith(`${session.deck}::`))) {
        throw new Error('The card is suspended or moved in Anki; no grade was saved.');
      }
      await client.answerCard(cardId, ease);
      const updated = (await client.cardsInfo([cardId]))[0];
      if (!updated || updated.reps <= beforeReps) throw new Error('Anki did not confirm the new review. Check Anki before retrying.');
    }
    session.lastReceipt = { nonce, cardId, ease, recordedAt: new Date().toISOString() };
    session.reviewed += 1;
    session.current = null;
    session.pending = null;
    await saveSnapshot(file, session);
    return { sessionId, recorded: true, ease, ...(await writeView(session, client)) };
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

export const ratingName = (ease) => LABELS[ease - 1] ?? 'Unknown';
