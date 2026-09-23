import { request } from 'node:http';

const READ_ACTIONS = new Set(['version', 'deckNames', 'findCards', 'cardsInfo', 'retrieveMediaFile', 'getReviewsOfCards']);
const DEFAULT_URL = 'http://127.0.0.1:8765';
const MAX_CARDS = 100;
const validId = (value) => Number.isSafeInteger(value) && value > 0;

export class AnkiConnectError extends Error {
  constructor(message, code) { super(message); this.name = 'AnkiConnectError'; this.code = code; }
}

export function validateAnkiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AnkiConnectError('ANKI_CONNECT_URL must be a local HTTP URL.', 'INVALID_URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AnkiConnectError('ANKI_CONNECT_URL must use HTTP on localhost, 127.0.0.1, or [::1], with no credentials or path.', 'INVALID_URL');
  }
  // Avoid DNS resolution for localhost: a configured hostname must stay local.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

export function createAnkiConnect({
  url = process.env.ANKI_CONNECT_URL || DEFAULT_URL,
  apiKey = process.env.ANKI_CONNECT_KEY || undefined,
  timeoutMs = 5000,
  maxResponseBytes = 16 * 1024 * 1024,
  reviewWrites = false,
} = {}) {
  const endpoint = validateAnkiUrl(url);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('AnkiConnect timeout must be between 1 and 30000 milliseconds.');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024) throw new Error('Invalid AnkiConnect response size limit.');
  if (apiKey !== undefined && typeof apiKey !== 'string') throw new Error('ANKI_CONNECT_KEY must be a string.');
  const redact = (value) => apiKey ? String(value).replaceAll(apiKey, '[redacted]') : String(value);

  async function invoke(action, params = {}) {
    if (!READ_ACTIONS.has(action) && !(reviewWrites && action === 'answerCards')) {
      throw new AnkiConnectError('This Anki client allows read-only actions only unless review grading is enabled.', 'READ_ONLY');
    }
    const body = JSON.stringify({ action, version: 6, params, ...(apiKey ? { key: apiKey } : {}) });
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const req = request(endpoint, {
        method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        // Attach before any early return: destroying an incomplete HTTP response
        // can emit an error even after the request's promise has been rejected.
        res.on('error', () => finish(new AnkiConnectError('The AnkiConnect response was interrupted. Keep Anki open and try again.', 'CONNECTION_ERROR')));
        if (res.statusCode !== 200) {
          finish(new AnkiConnectError(`AnkiConnect returned HTTP ${res.statusCode}. Check that its local URL and add-on are correct.`, 'HTTP_ERROR'));
          res.destroy();
          req.destroy();
          return;
        }
        let bytes = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            finish(new AnkiConnectError('AnkiConnect response exceeded the size limit. Try a smaller card batch or media file.', 'TOO_LARGE'));
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          let reply;
          try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return finish(new AnkiConnectError('AnkiConnect returned invalid JSON. Check that its URL points to the add-on.', 'INVALID_RESPONSE')); }
          if (!reply || typeof reply !== 'object' || !Object.hasOwn(reply, 'result') || !Object.hasOwn(reply, 'error')) {
            return finish(new AnkiConnectError('The local service did not return an AnkiConnect API v6 response.', 'INVALID_RESPONSE'));
          }
          if (reply.error !== null) {
            const message = redact(reply.error).slice(0, 400);
            const auth = /api.?key|authentication/i.test(message);
            return finish(new AnkiConnectError(auth
              ? 'AnkiConnect rejected authentication. Set ANKI_CONNECT_KEY to the key configured in the add-on.'
              : `AnkiConnect could not ${action}: ${message}`, auth ? 'AUTH_ERROR' : 'API_ERROR'));
          }
          finish(null, reply.result);
        });
      });
      timer = setTimeout(() => {
        finish(new AnkiConnectError('AnkiConnect timed out. Keep Anki open, close any blocking dialog, and try again.', 'TIMEOUT'));
        req.destroy();
      }, timeoutMs);
      req.on('error', () => finish(new AnkiConnectError(`Cannot reach AnkiConnect at ${endpoint.origin}. Open Anki, enable the AnkiConnect add-on, and restart Anki.`, 'CONNECTION_ERROR')));
      req.end(body);
    });
  }

  return Object.freeze({
    invoke,
    version: () => invoke('version'),
    deckNames: async () => {
      const names = await invoke('deckNames');
      if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) throw new AnkiConnectError('AnkiConnect returned an invalid deck list.', 'INVALID_RESPONSE');
      return names;
    },
    findCards: async (query) => {
      if (typeof query !== 'string' || !query.trim() || query.length > 4096) throw new Error('Provide a nonempty Anki card search.');
      const ids = await invoke('findCards', { query });
      if (!Array.isArray(ids) || !ids.every(validId)) throw new AnkiConnectError('AnkiConnect returned invalid card IDs.', 'INVALID_RESPONSE');
      return ids;
    },
    cardsInfo: async (cards) => {
      if (!Array.isArray(cards) || cards.length > MAX_CARDS || !cards.every(validId)) throw new Error('cardsInfo accepts at most 100 valid card IDs.');
      if (cards.length === 0) return [];
      const result = await invoke('cardsInfo', { cards });
      if (!Array.isArray(result)) throw new AnkiConnectError('AnkiConnect returned invalid card information.', 'INVALID_RESPONSE');
      return result;
    },
    retrieveMediaFile: async (filename) => {
      if (typeof filename !== 'string' || !filename || /[\\/\0]/u.test(filename)) throw new Error('Provide an Anki media filename, without a directory path.');
      const data = await invoke('retrieveMediaFile', { filename });
      if (data !== false && typeof data !== 'string') throw new AnkiConnectError('AnkiConnect returned invalid media data.', 'INVALID_RESPONSE');
      return data;
    },
    answerCard: async (cardId, ease) => {
      if (!reviewWrites) throw new AnkiConnectError('Review grading is disabled for this client.', 'READ_ONLY');
      if (!validId(cardId) || !Number.isInteger(ease) || ease < 1 || ease > 4) throw new Error('Provide a valid card ID and Anki rating from 1 to 4.');
      const result = await invoke('answerCards', { answers: [{ cardId, ease }] });
      if (!Array.isArray(result) || result.length !== 1 || result[0] !== true) {
        throw new AnkiConnectError('Anki did not confirm the review. Check the card in Anki before retrying.', 'REVIEW_UNCONFIRMED');
      }
      return true;
    },
    reviewHistory: async (cardId) => {
      if (!validId(cardId)) throw new Error('Provide a valid Anki card ID.');
      const result = await invoke('getReviewsOfCards', { cards: [cardId] });
      const reviews = result?.[String(cardId)];
      if (!Array.isArray(reviews)) throw new AnkiConnectError('Anki returned invalid review history.', 'INVALID_RESPONSE');
      return reviews;
    },
  });
}

export function deckQuery(deck) {
  if (typeof deck !== 'string' || !deck.trim() || deck.length > 1000 || /[\r\n\0]/u.test(deck)) throw new Error('Provide a valid Anki deck name.');
  return `deck:"${deck.replace(/[\\"*_]/gu, '\\$&')}"`;
}

export async function pullCards({ client = createAnkiConnect(), deck, limit = 10, includeOther = true } = {}) {
  const search = `${deckQuery(deck)} -is:suspended -is:buried`;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CARDS) throw new Error('Card limit must be an integer between 1 and 100.');
  const version = await client.version();
  if (!Number.isInteger(version) || version < 6) throw new AnkiConnectError('AnkiConnect API v6 or newer is required. Update the add-on and restart Anki.', 'OLD_VERSION');
  if (!(await client.deckNames()).includes(deck)) throw new AnkiConnectError('That deck was not found. Run the decks command and copy its full name, including any parent decks.', 'DECK_NOT_FOUND');
  const selected = new Map();
  const groups = [['due', 'is:due'], ['new', 'is:new']];
  if (includeOther) groups.push(['other', '-is:due -is:new']);
  for (const [kind, filter] of groups) {
    if (selected.size >= limit) break;
    const ids = await client.findCards(`${search} ${filter}`);
    for (const id of ids) {
      if (!selected.has(id)) selected.set(id, kind);
      if (selected.size >= limit) break;
    }
  }
  const warnings = [];
  const ids = [...selected.keys()];
  const cards = [];
  const seen = new Set();
  for (let offset = 0; offset < ids.length; offset += 25) {
    for (const card of await client.cardsInfo(ids.slice(offset, offset + 25))) {
      if (!card || !selected.has(card.cardId) || seen.has(card.cardId) ||
          !card.fields || typeof card.fields !== 'object' ||
          typeof card.deckName !== 'string' ||
          (card.deckName !== deck && !card.deckName.startsWith(`${deck}::`)) || card.queue < 0) continue;
      seen.add(card.cardId);
      cards.push(card);
    }
  }
  cards.sort((a, b) => ids.indexOf(a.cardId) - ids.indexOf(b.cardId));
  if (cards.length < ids.length) warnings.push(`${ids.length - cards.length} selected card(s) became unavailable or were excluded before reading.`);
  const selection = { due: 0, new: 0, other: 0 };
  for (const card of cards) selection[selected.get(card.cardId)] += 1;
  if (selection.other) warnings.push(`Included ${selection.other} other available card(s) because fewer than ${limit} due or new cards were available.`);
  if (!cards.length) warnings.push('No available cards were found in this deck. Suspended and buried cards are excluded.');
  return { source: 'anki-connect', deck, fetchedAt: new Date().toISOString(), selection, warnings, cards };
}
