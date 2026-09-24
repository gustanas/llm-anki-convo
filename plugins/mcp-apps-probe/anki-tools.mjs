import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { createAnkiConnect } from '../../lib/anki-connect.mjs';
import { rateReview, resumeReview, startReview, ratingName } from '../../lib/anki-review.mjs';

export const ANKI_RESOURCE_URI = 'ui://mcp-apps-probe/anki-review.html';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PRIVATE_OUTPUT_DIR = path.join(ROOT, 'dist');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_V4);

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
  outputDir = PRIVATE_OUTPUT_DIR,
  reviewApi = { startReview, resumeReview, rateReview },
} = {}) {
  registerAppTool(server, 'show_anki_review', {
    title: 'Show Anki review',
    description: 'Display an inline Anki review. The widget reads decks and records ratings through direct MCP Apps server calls, without posting each grade to chat.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ status: z.literal('ready') }),
    _meta: { ui: { resourceUri: ANKI_RESOURCE_URI } },
  }, async () => success({ status: 'ready' }, 'Anki review is ready. Select a deck in the inline card.'));

  registerAppTool(server, 'list_anki_decks', {
    title: 'List Anki decks',
    description: 'List decks from the local Anki app.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ decks: z.array(z.string()) }),
    _meta: { ui: { visibility: ['app'] } },
  }, async () => asToolResult(async () => {
    const decks = await clientFactory({ reviewWrites: false }).deckNames();
    return success({ decks }, `${decks.length} Anki deck(s) available.`);
  }));

  registerAppTool(server, 'start_anki_review', {
    title: 'Start unlimited Anki review',
    description: 'Start reviewing all available due and new cards in a deck. Future, suspended, and buried cards are excluded.',
    inputSchema: z.object({ deck: z.string().trim().min(1).max(1000), skipIdentical: z.boolean().optional() }).strict(),
    outputSchema: z.object({ view: z.unknown(), warnings: z.array(z.string()) }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ deck, skipIdentical }) => asToolResult(async () => {
    const result = await reviewApi.startReview({ client: clientFactory({ reviewWrites: false }), deck, outputDir, skipIdentical });
    return success({ view: result.view, warnings: result.warnings }, result.view.done ? 'No due or new cards are available.' : 'Review card ready.');
  }));

  registerAppTool(server, 'resume_anki_review', {
    title: 'Resume Anki review',
    description: 'Fetch the current card and answer for an existing review session.',
    inputSchema: z.object({ sessionId: uuid }).strict(),
    outputSchema: z.object({ view: z.unknown(), warnings: z.array(z.string()) }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ sessionId }) => asToolResult(async () => {
    const result = await reviewApi.resumeReview({ client: clientFactory({ reviewWrites: false }), sessionId });
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
    const result = await reviewApi.rateReview({ client: clientFactory({ reviewWrites: true }), sessionId, cardId, nonce, ease });
    if (result?.recorded !== true || !result.view) throw new Error('Anki did not confirm the new review. Keep this card and retry the same rating.');
    return success({ recorded: true, rating: ratingName(ease), view: result.view, warnings: result.warnings }, `Saved ${ratingName(ease)} in Anki.`);
  }));
}
