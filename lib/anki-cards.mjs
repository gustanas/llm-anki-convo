import path from 'node:path';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac',
};
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, entity) => {
    if (!entity.startsWith('#')) return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity] : match;
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '�';
  });
}

const withoutCode = (html) => String(html ?? '')
  .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  .replace(/<(script|style|iframe|object|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

// Text extraction only: this output is always rendered with textContent, never HTML.
export function htmlToText(html) {
  return decodeEntities(withoutCode(html)
    .replace(/\[(?:sound:[^\]]+|anki:play:[^\]]+)\]/gi, '')
    .replace(/<rt\b[^>]*>([\s\S]*?)<\/rt\s*>/gi, ' ($1)')
    .replace(/<\/?(?:br|p|div|li|h[1-6]|hr|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function attribute(tag, name) {
  // Consume whole attribute values so data-src or text inside title="src=..."
  // cannot stand in for an actual src (or id) attribute.
  for (const match of tag.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    if (match[1].toLowerCase() === name) return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return '';
}

function mediaReferences(html) {
  const clean = withoutCode(html);
  const refs = [];
  for (const match of clean.matchAll(/\[sound:([^\]]+)\]/gi)) refs.push({ type: 'audio', filename: decodeEntities(match[1]) });
  for (const match of clean.matchAll(/<(img|audio|source)\b[^>]*>/gi)) {
    refs.push({ type: match[1].toLowerCase() === 'img' ? 'image' : 'audio', filename: attribute(match[0], 'src'), alt: attribute(match[0], 'alt') });
  }
  return refs.filter((ref, index) => ref.filename && refs.findIndex((item) => item.filename === ref.filename) === index);
}

function decodedFilename(filename) {
  try { return decodeURIComponent(filename); } catch { return filename; }
}

function fieldAudioReferences(raw, fieldName = null) {
  const fields = fieldName === null ? Object.values(raw.fields ?? {}) : [raw.fields?.[fieldName]];
  const references = fields.flatMap((field) =>
    typeof field?.value === 'string' ? mediaReferences(field.value).filter((ref) => ref.type === 'audio') : []);
  return references.filter((ref, index) => references.findIndex((other) =>
    decodedFilename(other.filename) === decodedFilename(ref.filename)) === index);
}

function cardSides(raw) {
  const field = (name) => raw.fields?.[name]?.value || '';
  // Jlab's listening card templates contain substantial addon UI. Use their
  // named content fields so Japanese text, explanations and audio stay useful.
  if (raw.ord === 0 && field('Jlab-ListeningFront') && field('RemarksBack')) {
    const front = [...new Set([field('Jlab-ListeningFront'), field('Other-Front')].filter(Boolean))].join('<br>');
    return {
      question: `${field('Audio')}${field('Image')}<br>${front}<br>${field('RemarksFront')}`,
      answer: [field('RemarksBack'), field('Jlab-Translation'), field('Other-Back'), field('References'), field('Source') && `Source: ${field('Source')}`].filter(Boolean).join('<br><br>'),
    };
  }
  const question = withoutCode(raw.question);
  let answer = withoutCode(raw.answer);
  const divider = [...answer.matchAll(/<hr\b[^>]*>/gi)].find((match) => attribute(match[0], 'id').toLowerCase() === 'answer');
  if (divider) answer = answer.slice(divider.index + divider[0].length);
  return { question, answer };
}

export async function normalizeAnkiCards(rawCards, {
  retrieveMediaFile,
  skipIdentical = false,
  limit = 10,
  maxMediaBytes = 500_000,
  maxFileBytes = 200_000,
} = {}) {
  if (!Array.isArray(rawCards)) throw new Error('Expected an Anki cardsInfo array.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Card limit must be between 1 and 100.');
  if (![maxMediaBytes, maxFileBytes].every((value) => Number.isInteger(value) && value >= 0)) throw new Error('Media limits must be nonnegative integers.');
  const warnings = new Set();
  const cards = [];
  const cache = new Map();
  let mediaBytes = 0;
  let skippedIdentical = 0;
  for (const raw of rawCards) {
    if (cards.length >= limit) break;
    if (!Number.isSafeInteger(raw?.cardId) || raw.cardId <= 0 || typeof raw.question !== 'string' || typeof raw.answer !== 'string') {
      warnings.add('Skipped a card with incomplete Anki content.');
      continue;
    }
    const sides = cardSides(raw);
    if (skipIdentical && withoutCode(raw.question).trim() === withoutCode(raw.answer).trim()) { skippedIdentical++; continue; }
    const card = { id: `anki:${raw.cardId}`, type: 'flashcard', category: raw.deckName || 'Anki', question: htmlToText(sides.question), answer: htmlToText(sides.answer), media: { question: [], answer: [] } };
    let cardMediaBytes = 0;
    // Anki replaces [sound:...] with [anki:play:q:N] or [anki:play:a:N]
    // in cardsInfo HTML. Recover only an unambiguous single local file from
    // the original fields (including Basic Front), never from player markup.
    for (const side of ['question', 'answer']) {
      const html = sides[side];
      const refs = mediaReferences(html);
      const players = [...html.matchAll(/\[anki:play:[qa]:\d+\]/gi)];
      if (players.length) {
        const directAudio = refs.filter((ref) => ref.type === 'audio');
        const fieldAudio = fieldAudioReferences(raw);
        // The stock Basic card displays Front on the question side and Back
        // after the answer divider. This also resolves a sound on each side.
        const basicSideAudio = raw.modelName === 'Basic' && raw.ord === 0
          ? fieldAudioReferences(raw, side === 'question' ? 'Front' : 'Back') : [];
        const recovered = fieldAudio.length === 1 ? fieldAudio[0]
          : basicSideAudio.length === 1 ? basicSideAudio[0] : null;
        if (players.length === 1 && directAudio.length === 0 && recovered) refs.push(recovered);
        else if (directAudio.length === 0) warnings.add('Some custom Anki audio players could not be resolved; review those cards in Anki.');
      }
      // Audio first, so large illustrations cannot consume the listening budget.
      refs.sort((a, b) => (a.type === 'audio' ? 0 : 1) - (b.type === 'audio' ? 0 : 1));
      const seenOnSide = new Set();
      for (const ref of refs) {
        const filename = decodedFilename(ref.filename);
        if (seenOnSide.has(`${ref.type}:${filename}`)) continue;
        seenOnSide.add(`${ref.type}:${filename}`);
        const mime = MIME[path.extname(filename).toLowerCase()];
        if (/[\\/\0]/u.test(filename) || filename.includes(':') || !mime?.startsWith(`${ref.type}/`)) {
          warnings.add('Skipped remote or unsupported media; only local images and audio are embedded.');
          continue;
        }
        if (!retrieveMediaFile) { warnings.add('Media was not loaded; use the live Anki build command to include it.'); continue; }
        if (!cache.has(filename)) {
          try { cache.set(filename, await retrieveMediaFile(filename)); }
          catch (error) { warnings.add(`Could not load some Anki media: ${error.message}`); cache.set(filename, false); }
        }
        const base64 = cache.get(filename);
        if (typeof base64 !== 'string' || !base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
          warnings.add('Some media files were missing or invalid.');
          continue;
        }
        const bytes = Buffer.byteLength(base64, 'base64');
        if (bytes > maxFileBytes || mediaBytes + cardMediaBytes + bytes > maxMediaBytes) {
          warnings.add('Some media exceeded the inline size budget and was omitted; use a smaller batch or review it in Anki.');
          continue;
        }
        cardMediaBytes += bytes;
        card.media[side].push({ type: ref.type, src: `data:${mime};base64,${base64}`, ...(ref.alt ? { alt: ref.alt } : {}) });
      }
    }
    if ((!card.question && !card.media.question.length) || (!card.answer && !card.media.answer.length)) {
      warnings.add('Skipped a card whose front or back has no supported text or media.');
      continue;
    }
    mediaBytes += cardMediaBytes;
    cards.push(card);
  }
  if (skippedIdentical) warnings.add(`Skipped ${skippedIdentical} card(s) with identical fronts and backs.`);
  return { cards, warnings: [...warnings], mediaBytes };
}
