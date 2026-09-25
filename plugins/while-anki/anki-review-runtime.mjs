import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deckQuery } from '../../lib/anki-connect.mjs';
import { normalizeAnkiCards } from '../../lib/anki-cards.mjs';

// This is the MCP App's review engine. Unlike the legacy inline review CLI, it
// returns card data directly to the widget and writes only private session
// receipts. In particular, it has no dependency on repository-local dist/ or
// on CLI modules that would execute when bundled into the plugin server.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABELS = ['Again', 'Hard', 'Good', 'Easy'];
const DEAD_LOCK_GRACE_MS = 35 * 1000;
const OLD_LOCK_GRACE_MS = 5 * 60 * 1000;
const activeLockTokens = globalThis[Symbol.for('while-anki.active-review-locks')] ??= new Set();
const savingMessage = 'This review is already being saved. Wait for it to finish.';
const recoveringMessage = 'Review recovery is in progress or was interrupted. No grade was sent; check Anki before retrying.';

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function lockOwnerIsGone(owner) {
  if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return null;
  if (owner.pid === process.pid) return !activeLockTokens.has(owner.token);
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

async function fileExists(file) {
  try { await stat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeAbandonedLockUnderGuard(lock) {
  let observed;
  let content;
  try {
    observed = await stat(lock);
    content = await readFile(lock, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  let owner;
  try { owner = JSON.parse(content); } catch { owner = null; }
  const gone = lockOwnerIsGone(owner);
  const age = Date.now() - observed.mtimeMs;
  // AnkiConnect requests can outlive a crashed caller. Keep a short grace from
  // the last answer attempt. A valid live owner is never reclaimed by age:
  // a slow media fetch can keep the lock held long after the grade was saved.
  if (!(gone === true && age > DEAD_LOCK_GRACE_MS || gone === null && age > OLD_LOCK_GRACE_MS)) {
    throw new Error(savingMessage);
  }
  let current;
  try { current = await stat(lock); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!sameFile(observed, current) || observed.mtimeMs !== current.mtimeMs || observed.size !== current.size) throw new Error(savingMessage);
  let latestContent;
  try { latestContent = await readFile(lock, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (latestContent !== content) throw new Error(savingMessage);
  await rm(lock, { force: true });
}

async function createOwnedLock(file) {
  const handle = await open(file, 'wx', 0o600);
  const token = randomUUID();
  const held = { handle, token };
  activeLockTokens.add(token);
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, token })}\n`, 'utf8');
    return held;
  } catch (error) {
    await releaseReviewLock(file, held);
    throw error;
  }
}

async function releaseReviewLock(lock, { handle, token }) {
  try {
    const held = await handle.stat().catch(() => null);
    if (!held) return;
    const current = await stat(lock).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current && sameFile(held, current)) await rm(lock, { force: true });
  } finally {
    // Keep the fd open through unlink so its inode cannot be recycled between
    // the identity check and removal of the pathname.
    try { await handle.close(); } finally { activeLockTokens.delete(token); }
  }
}

async function heldLockIsCurrent(lock, held) {
  const owner = await held.handle.stat();
  const current = await stat(lock).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return current !== null && sameFile(owner, current);
}

async function verifyHeldLock(lock, held, recovery = null) {
  try {
    if (recovery && await fileExists(recovery) || !(await heldLockIsCurrent(lock, held))) {
      throw new Error(recoveringMessage);
    }
  } catch (error) {
    await releaseReviewLock(lock, held);
    throw error;
  }
}

async function acquireReviewLock(lock) {
  const recovery = `${lock}.recovery`;
  // Every acquirer observes the recovery guard both before and after opening
  // the main lock. A contender that raced a reaper must not use a removed lock.
  if (await fileExists(recovery)) throw new Error(recoveringMessage);
  let held;
  try {
    held = await createOwnedLock(lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (held) {
    await verifyHeldLock(lock, held, recovery);
    return held;
  }

  let guard;
  try { guard = await createOwnedLock(recovery); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(recoveringMessage);
    throw error;
  }
  let acquired = null;
  try {
    await removeAbandonedLockUnderGuard(lock);
    // Keep the guard until the fresh lock has been acquired. A process that
    // checked before the guard existed may briefly open the main path, but its
    // post-open guard/inode check forces it to release without grading.
    try { held = await createOwnedLock(lock); } catch (error) {
      if (error.code === 'EEXIST') throw new Error(savingMessage);
      throw error;
    }
    await verifyHeldLock(lock, held);
    acquired = held;
  } finally {
    try { await releaseReviewLock(recovery, guard); } catch (error) {
      if (acquired) await releaseReviewLock(lock, acquired);
      throw error;
    }
  }
  return acquired;
}

function cardStillInDeck(raw, deck) {
  return raw && raw.queue >= 0 && (raw.deckName === deck || raw.deckName?.startsWith(`${deck}::`));
}

async function cardStillDueOrNew(client, deck, cardId) {
  if (!Number.isSafeInteger(cardId) || cardId <= 0) return false;
  const query = `${deckQuery(deck)} -is:suspended -is:buried cid:${cardId}`;
  const [due, fresh] = await Promise.all([
    client.findCards(`${query} is:due`),
    client.findCards(`${query} is:new`),
  ]);
  return due.includes(cardId) || fresh.includes(cardId);
}

function validateId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function sessionPath(sessionDir, id) {
  if (typeof sessionDir !== 'string' || !path.isAbsolute(sessionDir)) throw new Error('Provide an absolute private session directory.');
  return path.join(sessionDir, `${validateId(id, 'review session')}.json`);
}

async function saveSession(sessionDir, session) {
  const file = sessionPath(sessionDir, session.id);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(sessionDir, `.anki-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

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

async function currentView(session, client, sessionDir) {
  let next = null;
  const notices = [];
  if (!session.current) {
    next = await findNextReview(client, session.deck, { skipIdentical: session.skipIdentical });
    if (next.raw) {
      session.current = { cardId: next.raw.cardId, reps: next.raw.reps, nonce: randomUUID() };
    }
  }
  if (session.current && !next) {
    const raw = (await client.cardsInfo([session.current.cardId]))[0];
    if (!cardStillInDeck(raw, session.deck) || raw.reps !== session.current.reps ||
        !(await cardStillDueOrNew(client, session.deck, session.current.cardId))) {
      session.current = null;
      next = await findNextReview(client, session.deck, { skipIdentical: session.skipIdentical });
      if (next.raw) session.current = { cardId: next.raw.cardId, reps: next.raw.reps, nonce: randomUUID() };
      notices.push('The active card changed in Anki. Review refreshed; no rating was saved here.');
    } else {
      const normalized = await normalizeAnkiCards([raw], { limit: 1, retrieveMediaFile: client.retrieveMediaFile });
      if (!normalized.cards.length) throw new Error('The active card has no supported front or back. No review was saved.');
      next = { raw, card: normalized.cards[0], remaining: null, due: null, fresh: null, warnings: normalized.warnings };
    }
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
  if (Buffer.byteLength(JSON.stringify(view), 'utf8') > 1_000_000) {
    throw new Error('Anki review card exceeds the inline size limit.');
  }
  await saveSession(sessionDir, session);
  return { view, warnings: [...notices, ...(next?.warnings ?? [])] };
}

export async function startReview({ client, deck, sessionDir, skipIdentical = false }) {
  if (!client || typeof client.findCards !== 'function' || typeof deck !== 'string' || !deck.trim()) throw new Error('Provide an Anki client and deck name.');
  if (!(await client.deckNames()).includes(deck)) throw new Error('Deck not found in Anki.');
  const session = { version: 1, id: randomUUID(), deck, skipIdentical: !!skipIdentical, reviewed: 0, current: null, pending: null, lastReceipt: null };
  return { sessionId: session.id, ...(await currentView(session, client, sessionDir)) };
}

export async function resumeReview({ client, sessionId, sessionDir }) {
  const file = sessionPath(sessionDir, sessionId);
  const lock = `${file}.lock`;
  const heldLock = await acquireReviewLock(lock);
  try {
    const session = JSON.parse(await readFile(file, 'utf8'));
    if (session.version !== 1 || session.id !== sessionId || session.pending) throw new Error('Review is incomplete or still saving. Retry its last rating.');
    return { sessionId, ...(await currentView(session, client, sessionDir)) };
  } finally {
    await releaseReviewLock(lock, heldLock);
  }
}

export async function rateReview({ client, sessionId, cardId, nonce, ease, sessionDir }) {
  validateId(nonce, 'review nonce');
  if (!Number.isSafeInteger(cardId) || cardId <= 0 || !Number.isInteger(ease) || ease < 1 || ease > 4) throw new Error('Invalid card or Anki rating.');
  const file = sessionPath(sessionDir, sessionId);
  const lock = `${file}.lock`;
  const heldLock = await acquireReviewLock(lock);
  try {
    const session = JSON.parse(await readFile(file, 'utf8'));
    if (session.version !== 1 || session.id !== sessionId) throw new Error('Invalid review session.');
    if (session.lastReceipt?.nonce === nonce) {
      if (session.lastReceipt.cardId !== cardId || session.lastReceipt.ease !== ease) throw new Error('This rating does not match the saved review. No new grade was sent.');
      return { sessionId, recorded: true, ease: session.lastReceipt.ease, ...(await currentView(session, client, sessionDir)) };
    }
    if (!session.current || session.current.cardId !== cardId || session.current.nonce !== nonce) throw new Error('This card is no longer the active review. No grade was saved.');
    if (session.pending && (session.pending.nonce !== nonce || session.pending.ease !== ease)) throw new Error('A different rating is already pending for this card.');
    const refreshWithoutGrade = async (notice) => {
      session.pending = null;
      session.current = null;
      const result = await currentView(session, client, sessionDir);
      return { sessionId, recorded: false, ease, ...result, warnings: [notice, ...result.warnings] };
    };
    if (!session.pending) {
      // Check before writing a pending receipt. A review made directly in Anki
      // before this button was pressed must never be attributed to this click.
      const before = (await client.cardsInfo([cardId]))[0];
      if (!cardStillInDeck(before, session.deck) || before.reps !== session.current.reps ||
          !(await cardStillDueOrNew(client, session.deck, cardId))) {
        return refreshWithoutGrade('The card changed in Anki before this rating. No rating was sent here; review refreshed.');
      }
      session.pending = { cardId, nonce, ease, startedAt: Date.now(), attemptedAt: null, answerReturned: false };
      await saveSession(sessionDir, session);
    }
    const current = (await client.cardsInfo([cardId]))[0];
    if (!current) {
      if (session.pending.attemptedAt === null) return refreshWithoutGrade('The card is missing in Anki. No rating was sent here; review refreshed.');
      throw new Error('The card is missing in Anki, and the pending rating cannot be verified. No second grade was sent.');
    }
    const beforeReps = current.reps;
    if (beforeReps !== session.current.reps) {
      if (session.pending.attemptedAt === null) {
        return refreshWithoutGrade('The card changed in Anki before this rating was sent. Review refreshed without another grade.');
      }
      if (session.pending.answerReturned !== true) {
        return refreshWithoutGrade('Anki changed after the rating was attempted, but its response was lost. The result cannot be attributed to this review; no second grade was sent.');
      }
    } else {
      if (session.pending.answerReturned === true) {
        throw new Error('Anki reported a saved review, but the card state has not changed. No second grade was sent.');
      }
      if (session.pending.attemptedAt !== null) {
        throw new Error('The previous rating may still finish in Anki. No second grade was sent. Check this card in Anki; if it stays unchanged, restart Anki and review it there.');
      }
      if (!cardStillInDeck(current, session.deck)) {
        return refreshWithoutGrade('The card was suspended or moved in Anki. No rating was sent here; review refreshed.');
      }
      if (!(await cardStillDueOrNew(client, session.deck, cardId))) {
        return refreshWithoutGrade('The card is no longer due or new in Anki. No rating was sent here; review refreshed.');
      }
      session.pending.attemptedAt = Date.now();
      await saveSession(sessionDir, session);
      await utimes(lock, new Date(), new Date());
      await client.answerCard(cardId, ease);
      session.pending.answerReturned = true;
      await saveSession(sessionDir, session);
      const updated = (await client.cardsInfo([cardId]))[0];
      if (!updated || updated.reps <= beforeReps) throw new Error('Anki did not confirm the new review. Check Anki before retrying.');
    }
    session.lastReceipt = { nonce, cardId, ease, recordedAt: new Date().toISOString() };
    session.reviewed += 1;
    session.current = null;
    session.pending = null;
    await saveSession(sessionDir, session);
    return { sessionId, recorded: true, ease, ...(await currentView(session, client, sessionDir)) };
  } finally {
    await releaseReviewLock(lock, heldLock);
  }
}

export const ratingName = (ease) => LABELS[ease - 1] ?? 'Unknown';
