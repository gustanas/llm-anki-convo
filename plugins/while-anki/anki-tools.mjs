import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { createAnkiConnect } from '../../lib/anki-connect.mjs';
import { rateReview, resumeReview, startReview, ratingName } from './anki-review-runtime.mjs';

export const ANKI_RESOURCE_URI = 'ui://while-anki/anki-review-v3.html';
const HIDDEN_VIEW_TTL_MS = 60 * 60 * 1000;
const IDLE_VIEW_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VIEWS = 256;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_V4);

export function resolveAnkiDataDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const override = env.WHILE_ANKI_DATA_DIR;
  if (override !== undefined) {
    if (typeof override !== 'string' || !paths.isAbsolute(override)) {
      throw new Error('WHILE_ANKI_DATA_DIR must be an absolute path.');
    }
    return paths.resolve(override);
  }
  // Codex documents PLUGIN_DATA for hooks. Some hosts also forward it to
  // bundled MCP servers; use it when present without depending on it.
  if (env.PLUGIN_DATA && paths.isAbsolute(env.PLUGIN_DATA)) return paths.resolve(env.PLUGIN_DATA);
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support', 'While Anki');
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && paths.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : env.APPDATA && paths.isAbsolute(env.APPDATA) ? env.APPDATA : paths.join(home, 'AppData', 'Local');
    return paths.join(base, 'While Anki');
  }
  const base = env.XDG_DATA_HOME && paths.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : paths.join(home, '.local', 'share');
  return paths.join(base, 'while-anki');
}

async function readLastUsedDeck(preferencesPath) {
  try {
    const saved = JSON.parse(await readFile(preferencesPath, 'utf8'));
    return saved?.version === 1 && typeof saved.deck === 'string' && saved.deck.trim() && saved.deck.length <= 1000
      ? saved.deck
      : null;
  } catch {
    // A missing or corrupt preference must never prevent reviewing cards.
    return null;
  }
}

async function saveLastUsedDeck(preferencesPath, deck) {
  if (typeof deck !== 'string' || !deck.trim() || deck.length > 1000) return false;
  await mkdir(path.dirname(preferencesPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${preferencesPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify({ version: 1, deck }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, preferencesPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return true;
}

function success(structuredContent, message) {
  return { content: [{ type: 'text', text: message }], structuredContent };
}

async function asToolResult(action) {
  try { return await action(); }
  catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : 'The Anki action failed.' }],
    };
  }
}

/**
 * Register a model-visible launcher and app-only tools. Card content and rating
 * results travel directly between the widget and this server, without a chat
 * turn. The established review library remains the sole authority for writes.
 */
export function registerAnkiReviewTools(server, {
  clientFactory = createAnkiConnect,
  dataDir = resolveAnkiDataDir(),
  sessionDir = path.join(dataDir, 'review-sessions'),
  preferencesPath = path.join(dataDir, 'last-deck.json'),
  reviewApi = { startReview, resumeReview, rateReview },
  now = Date.now,
  maxViews = MAX_VIEWS,
} = {}) {
  // A view is the particular widget instance attached to one show_anki_review
  // result. Hiding it must not alter the Anki review session it may display.
  const views = new Map();

  async function rememberDeck(result) {
    try {
      await saveLastUsedDeck(preferencesPath, result?.view?.deck);
    } catch {
      // A preference write is secondary to the Anki operation. In particular,
      // a saved rating must never be reported as failed because this write failed.
      result.warnings = [...(result.warnings ?? []), 'Could not remember the last used deck.'];
    }
  }

  function pruneViews(at = now()) {
    for (const [id, state] of views) {
      const expiresAt = state.hidden
        ? state.hiddenAt + HIDDEN_VIEW_TTL_MS
        : state.lastSeenAt + IDLE_VIEW_TTL_MS;
      if (at >= expiresAt) views.delete(id);
    }
  }

  function requireView(viewId) {
    pruneViews();
    if (!views.has(viewId)) throw new Error('This Anki review view is no longer available. Show it again.');
    return views.get(viewId);
  }

  registerAppTool(server, 'show_anki_review', {
    title: 'Show Anki review',
    description: 'Display an inline Anki review. When the user wants cards visible while you work, call this as your first tool action. Retain the returned viewId and call hide_anki_review before your final answer. The widget handles decks and ratings directly without chat messages.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ status: z.literal('ready'), viewId: uuid }),
    _meta: { ui: { resourceUri: ANKI_RESOURCE_URI } },
  }, async () => asToolResult(async () => {
    const at = now();
    pruneViews(at);
    // Hidden widgets no longer need a registry entry. Never evict a visible
    // view merely because another one was opened.
    for (const [id, state] of views) {
      if (views.size < maxViews) break;
      if (state.hidden) views.delete(id);
    }
    if (views.size >= maxViews) throw new Error('Too many Anki review views are open. Hide an older view and try again.');
    const viewId = randomUUID();
    views.set(viewId, { hidden: false, lastSeenAt: at, hiddenAt: null });
    return success({ status: 'ready', viewId }, 'Anki review is ready. Select a deck in the inline card.');
  }));

  registerAppTool(server, 'hide_anki_review', {
    title: 'Hide an Anki review view',
    description: 'Hide one inline Anki review widget after the current work finishes. This does not change the Anki review session or grade cards.',
    inputSchema: z.object({ viewId: uuid }).strict(),
    outputSchema: z.object({ viewId: uuid, hidden: z.literal(true) }),
    _meta: {},
  }, async ({ viewId }) => asToolResult(async () => {
    const state = requireView(viewId);
    if (!state.hidden) {
      state.hidden = true;
      state.hiddenAt = now();
    }
    return success({ viewId, hidden: true }, 'Anki review view hidden.');
  }));

  registerAppTool(server, 'get_anki_view_state', {
    title: 'Get Anki review view state',
    description: 'Check whether this specific Anki review widget should remain visible.',
    inputSchema: z.object({ viewId: uuid }).strict(),
    outputSchema: z.object({ viewId: uuid, hidden: z.boolean() }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ viewId }) => asToolResult(async () => {
    const state = requireView(viewId);
    if (!state.hidden) state.lastSeenAt = now();
    return success({ viewId, hidden: state.hidden }, state.hidden ? 'This view is hidden.' : 'This view is visible.');
  }));

  registerAppTool(server, 'list_anki_decks', {
    title: 'List Anki decks',
    description: 'List decks from the local Anki app.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ decks: z.array(z.string()), lastUsedDeck: z.string().nullable() }),
    _meta: { ui: { visibility: ['app'] } },
  }, async () => asToolResult(async () => {
    const decks = await clientFactory({ reviewWrites: false }).deckNames();
    const savedDeck = await readLastUsedDeck(preferencesPath);
    return success({ decks, lastUsedDeck: decks.includes(savedDeck) ? savedDeck : null }, `${decks.length} Anki deck(s) available.`);
  }));

  registerAppTool(server, 'start_anki_review', {
    title: 'Start unlimited Anki review',
    description: 'Start reviewing all available due and new cards in a deck. Future, suspended, and buried cards are excluded.',
    inputSchema: z.object({ deck: z.string().trim().min(1).max(1000), skipIdentical: z.boolean().optional() }).strict(),
    outputSchema: z.object({ view: z.unknown(), warnings: z.array(z.string()) }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ deck, skipIdentical }) => asToolResult(async () => {
    const result = await reviewApi.startReview({ client: clientFactory({ reviewWrites: false }), deck, sessionDir, skipIdentical });
    await rememberDeck(result);
    return success({ view: result.view, warnings: result.warnings }, result.view.done ? 'No due or new cards are available.' : 'Review card ready.');
  }));

  registerAppTool(server, 'resume_anki_review', {
    title: 'Resume Anki review',
    description: 'Fetch the current card and answer for an existing review session.',
    inputSchema: z.object({ sessionId: uuid }).strict(),
    outputSchema: z.object({ view: z.unknown(), warnings: z.array(z.string()) }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ sessionId }) => asToolResult(async () => {
    const result = await reviewApi.resumeReview({ client: clientFactory({ reviewWrites: false }), sessionId, sessionDir });
    await rememberDeck(result);
    return success({ view: result.view, warnings: result.warnings }, result.view.done ? 'Review session complete.' : 'Review card ready.');
  }));

  registerAppTool(server, 'rate_anki_review', {
    title: 'Save one Anki rating',
    description: 'Save the user-selected rating for exactly the active card, then return the next card.',
    inputSchema: z.object({
      sessionId: uuid,
      cardId: z.number().int().positive(),
      nonce: uuid,
      ease: z.number().int().min(1).max(4),
    }).strict(),
    outputSchema: z.object({ recorded: z.literal(true), rating: z.string(), view: z.unknown(), warnings: z.array(z.string()) }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ sessionId, cardId, nonce, ease }) => asToolResult(async () => {
    const result = await reviewApi.rateReview({ client: clientFactory({ reviewWrites: true }), sessionId, cardId, nonce, ease, sessionDir });
    if (result?.recorded !== true || !result.view) throw new Error('Anki did not confirm the new review. Keep this card and retry the same rating.');
    await rememberDeck(result);
    return success({ recorded: true, rating: ratingName(ease), view: result.view, warnings: result.warnings }, `Saved ${ratingName(ease)} in Anki.`);
  }));
}
