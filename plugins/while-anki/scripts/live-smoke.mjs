#!/usr/bin/env node
// Opt-in integration test. It creates a uniquely named disposable deck in the
// currently open Anki profile, reviews only its cards, and removes its deck and
// media in finally. It never selects, edits, or grades an existing deck.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { createAnkiConnect, deckQuery, validateAnkiUrl } from '../../../lib/anki-connect.mjs';
import { registerAnkiReviewTools } from '../anki-tools.mjs';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
const DECK_PREFIX = 'While Anki Smoke ';
const MEDIA_PREFIX = 'while_anki_smoke_';
const STOCK_MODELS = new Set(['Basic', 'Basic (and reversed card)', 'Basic (optional reversed card)', 'Cloze']);

function wavSilence() {
  const samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes.toString('base64');
}

function invokeAnki() {
  const endpoint = validateAnkiUrl(process.env.ANKI_CONNECT_URL || 'http://127.0.0.1:8765');
  const key = process.env.ANKI_CONNECT_KEY;
  return async (action, params = {}) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params, ...(key ? { key } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`AnkiConnect ${action} returned an HTTP error.`);
    const reply = await response.json();
    if (!reply || typeof reply !== 'object' || !Object.hasOwn(reply, 'error') || reply.error !== null) {
      // Do not print the remote error: it may contain private card text.
      throw new Error(`AnkiConnect ${action} failed.`);
    }
    return reply.result;
  };
}

function checkTool(result, name) {
  if (result?.isError || !result?.structuredContent) {
    // A tool error may contain private card text, so report only its name.
    throw new Error(`${name} failed.`);
  }
  return result.structuredContent;
}

function basicNote(deck, token, front, back) {
  return { deckName: deck, modelName: 'Basic', fields: { Front: `${token} ${front}`, Back: back }, options: { allowDuplicate: false } };
}

export async function existingModels(invoke) {
  const names = await invoke('modelNames');
  if (!Array.isArray(names) || !names.includes('Basic')) throw new Error('The stock Basic note type is unavailable.');
  const ids = await invoke('modelNamesAndIds');
  if (!ids || typeof ids !== 'object') throw new Error('Cannot inspect note-type deck overrides.');
  const staysInRequestedDeck = async (name) => {
    const id = ids[name];
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    const models = await invoke('findModelsById', { modelIds: [id] });
    const model = Array.isArray(models) && models.find((item) => item?.id === id && item?.name === name);
    return Array.isArray(model?.tmpls) && model.tmpls.length > 0 && model.tmpls.every((template) =>
      template && (template.did === null || template.did === undefined || template.did === 0));
  };
  if (!(await staysInRequestedDeck('Basic'))) throw new Error('Basic has a deck override; the smoke test will not create its cards.');
  const basicFields = await invoke('modelFieldNames', { modelName: 'Basic' });
  if (!Array.isArray(basicFields) || !basicFields.includes('Front') || !basicFields.includes('Back')) {
    throw new Error('The Basic note type does not have Front and Back fields.');
  }
  let clozeFields = null;
  if (names.includes('Cloze') && await staysInRequestedDeck('Cloze')) {
    const fields = await invoke('modelFieldNames', { modelName: 'Cloze' });
    if (Array.isArray(fields) && fields.includes('Text')) clozeFields = fields;
  }
  let custom = null;
  let audioModel = null;
  for (const name of names) {
    if (STOCK_MODELS.has(name)) continue;
    if (!(await staysInRequestedDeck(name))) continue;
    const fields = await invoke('modelFieldNames', { modelName: name });
    if (!Array.isArray(fields) || fields.length < 2 || fields.length > 30) continue;
    const templates = await invoke('modelTemplates', { modelName: name });
    if (!templates || typeof templates !== 'object') continue;
    const allMarkup = Object.values(templates).map((template) => `${template?.Front ?? ''} ${template?.Back ?? ''}`).join(' ');
    if (/<script\b|{{\s*(?:type|cloze):/i.test(allMarkup)) continue;
    const audioField = fields.includes('Audio') ? 'Audio' : fields.includes('Sound') ? 'Sound' : null;
    if (!audioModel && audioField && Object.keys(templates).length <= 3 && allMarkup.includes(`{{${audioField}}}`)) {
      audioModel = { name, fields, audioField };
    }
    if (fields.length > 6 || Object.keys(templates).length !== 1) continue;
    if (!allMarkup.includes('{{') || allMarkup.length > 1500) continue;
    if (!custom || allMarkup.length < custom.markupBytes) custom = { name, fields, markupBytes: allMarkup.length };
  }
  return { clozeFields, custom, audioModel };
}

async function connectTools(dataDir) {
  const server = new McpServer({ name: 'while-anki-live-smoke', version: '0.0.0' });
  registerAnkiReviewTools(server, { dataDir, autoShowSettingsPath: path.join(dataDir, 'auto-show.json') });
  const client = new Client({ name: 'while-anki-live-smoke-client', version: '0.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

const validAnkiId = (id) => Number.isSafeInteger(id) && id > 0;
const noteQuery = (id) => `nid:${id}`;

async function cardsForExactNote(invoke, noteId) {
  const ids = await invoke('findCards', { query: noteQuery(noteId) });
  if (!Array.isArray(ids) || !ids.every(validAnkiId)) throw new Error('Anki returned invalid card IDs.');
  const cards = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = await invoke('cardsInfo', { cards: ids.slice(offset, offset + 100) });
    if (!Array.isArray(batch) || batch.length !== Math.min(100, ids.length - offset) ||
        batch.some((card) => card?.note !== noteId)) throw new Error('Anki returned cards from another note.');
    cards.push(...batch);
  }
  return cards;
}

async function noteExists(invoke, noteId) {
  const found = await invoke('findNotes', { query: noteQuery(noteId) });
  if (!Array.isArray(found) || !found.every(validAnkiId)) throw new Error('Anki returned invalid note IDs.');
  return found.includes(noteId);
}

async function noteHasMarker(invoke, noteId, token) {
  const notes = await invoke('notesInfo', { notes: [noteId] });
  if (!Array.isArray(notes) || notes.length !== 1 || notes[0]?.noteId !== noteId) return false;
  return Object.values(notes[0].fields ?? {}).some((field) =>
    typeof field?.value === 'string' && field.value.includes(token));
}

export async function cleanup(invoke, { deck, token, deckWasAbsent, createdDeckId, attemptedCreate, noteIds, mediaNames }) {
  const warnings = [];
  let notesRemoved = true;
  // A note type's template can override the requested deck. Search by note ID,
  // and also by this run's unique marker to recover a note whose addNote reply
  // was lost after Anki saved it. Never delete a note without checking fields.
  const candidates = new Set(noteIds);
  if (attemptedCreate) {
    try {
      const discovered = await invoke('findNotes', { query: token });
      if (!Array.isArray(discovered) || !discovered.every(validAnkiId)) throw new Error('Invalid note search result.');
      for (const id of discovered) candidates.add(id);
    } catch { warnings.push('Could not audit test notes by their unique marker.'); notesRemoved = false; }
  }
  for (const id of candidates) {
    try {
      if (!(await noteExists(invoke, id))) continue;
      if (!(await noteHasMarker(invoke, id, token))) {
        warnings.push('A possible test note no longer has its unique marker; it was not deleted.');
        notesRemoved = false;
        continue;
      }
      await invoke('deleteNotes', { notes: [id] });
      if (await noteExists(invoke, id)) {
        warnings.push('A disposable note could not be confirmed deleted.');
        notesRemoved = false;
      }
    } catch { warnings.push('Disposable note cleanup failed.'); notesRemoved = false; }
  }
  let deckRemoved = false;
  if (attemptedCreate && deckWasAbsent && deck.startsWith(DECK_PREFIX)) {
    try {
      const decks = await invoke('deckNamesAndIds');
      const actualId = decks?.[deck];
      if (actualId === undefined) deckRemoved = true;
      else if (createdDeckId !== null && actualId !== createdDeckId) warnings.push('Disposable deck identity changed; cleanup skipped.');
      else if (Object.keys(decks).some((name) => name.startsWith(`${deck}::`))) warnings.push('Disposable deck has a subdeck; cleanup skipped.');
      else if ((await invoke('findCards', { query: deckQuery(deck) })).length) warnings.push('Disposable deck still has cards; cleanup skipped.');
      else {
        await invoke('deleteDecks', { decks: [deck], cardsToo: true });
        deckRemoved = !(await invoke('deckNames')).includes(deck);
        if (!deckRemoved) warnings.push('Disposable deck could not be confirmed deleted.');
      }
    } catch { warnings.push('Disposable deck cleanup failed.'); }
  }
  if (deckRemoved && notesRemoved) {
    for (const filename of mediaNames) {
      if (!filename.startsWith(MEDIA_PREFIX) || !filename.includes(token)) continue;
      try {
        const data = await invoke('retrieveMediaFile', { filename });
        if (data !== false) {
          await invoke('deleteMediaFile', { filename });
          if ((await invoke('retrieveMediaFile', { filename })) !== false) warnings.push('Disposable media could not be confirmed deleted.');
        }
      } catch { warnings.push('Disposable media cleanup failed.'); }
    }
  } else if (mediaNames.size) warnings.push('Disposable media retained because notes or their deck were not confirmed deleted.');
  return warnings;
}

export async function collectDisposableCards(invoke, noteIds, deck, token) {
  const cards = [];
  for (const noteId of noteIds) {
    assert.ok(await noteHasMarker(invoke, noteId, token), 'A disposable note lost its ownership marker.');
    const noteCards = await cardsForExactNote(invoke, noteId);
    assert.ok(noteCards.length > 0, 'A disposable note produced no card.');
    assert.ok(noteCards.every((card) => card.deckName === deck), 'A note template placed a test card outside the disposable deck.');
    cards.push(...noteCards);
  }
  const cardIds = cards.map((card) => card.cardId);
  assert.ok(cardIds.length >= 1 && cardIds.length <= 20 && new Set(cardIds).size === cardIds.length);
  const deckCardIds = await invoke('findCards', { query: deckQuery(deck) });
  assert.ok(Array.isArray(deckCardIds) && deckCardIds.length === cardIds.length &&
    deckCardIds.every((id) => cardIds.includes(id)), 'The disposable deck contains another card.');
  return { cards, cardIds };
}

export async function liveSmoke() {
  const token = randomUUID().replaceAll('-', '');
  const deck = `${DECK_PREFIX}${token}`;
  const mediaFilename = `${MEDIA_PREFIX}${token}.png`;
  const audioFilename = `${MEDIA_PREFIX}${token}.wav`;
  const invoke = invokeAnki();
  const localState = await mkdtemp(path.join(tmpdir(), 'while-anki-live-'));
  const state = { deck, token, deckWasAbsent: false, createdDeckId: null, attemptedCreate: false,
    noteIds: new Set(), mediaNames: new Set() };
  let tools;
  let viewId;
  let failure;
  let cleanupWarnings = [];
  let stage = 'preflight';
  let result;
  try {
    const anki = createAnkiConnect();
    assert.ok((await anki.version()) >= 6, 'AnkiConnect API v6 is required.');
    const models = await existingModels(invoke);
    state.deckWasAbsent = !(await anki.deckNames()).includes(deck);
    assert.ok(state.deckWasAbsent, 'The generated deck name unexpectedly exists.');

    stage = 'create disposable deck';
    state.attemptedCreate = true;
    state.createdDeckId = await invoke('createDeck', { deck });
    assert.ok(Number.isSafeInteger(state.createdDeckId) && state.createdDeckId > 0);

    stage = 'create disposable basic card';
    const noteIds = state.noteIds;
    const basicId = await invoke('addNote', { note: basicNote(deck, token, 'basic front', 'basic back') });
    assert.ok(Number.isSafeInteger(basicId) && basicId > 0);
    noteIds.add(basicId);

    let clozeAdded = false;
    let clozeId = null;
    if (models.clozeFields) {
      stage = 'create disposable cloze card';
      try {
        clozeId = await invoke('addNote', { note: {
          deckName: deck, modelName: 'Cloze',
          fields: Object.fromEntries(models.clozeFields.map((name) => [name,
            name === 'Text' ? `${token} cloze {{c1::answer}}` : 'smoke test'])),
          options: { allowDuplicate: false },
        } });
        assert.ok(Number.isSafeInteger(clozeId) && clozeId > 0);
        noteIds.add(clozeId);
        clozeAdded = true;
      } catch { /* Existing custom Cloze templates may reject this test note. */ }
    }

    let customAdded = false;
    if (models.custom) {
      stage = 'create disposable custom-template card';
      try {
        const customId = await invoke('addNote', { note: {
          deckName: deck, modelName: models.custom.name,
          fields: Object.fromEntries(models.custom.fields.map((name, index) => [name, `${token} field ${index + 1}`])),
          options: { allowDuplicate: false },
        } });
        assert.ok(Number.isSafeInteger(customId) && customId > 0);
        noteIds.add(customId);
        customAdded = true;
      } catch { /* The user's custom template is never changed; skip if it rejects test content. */ }
    }

    stage = 'create disposable media card';
    let mediaAdded = false;
    const mediaBefore = await invoke('retrieveMediaFile', { filename: mediaFilename });
    assert.equal(mediaBefore, false, 'The generated media name unexpectedly exists.');
    state.mediaNames.add(mediaFilename);
    try {
      await invoke('storeMediaFile', { filename: mediaFilename, data: PNG_1PX });
      const mediaId = await invoke('addNote', { note: basicNote(deck, token,
        `media front <img src="${mediaFilename}">`, 'media back') });
      assert.ok(Number.isSafeInteger(mediaId) && mediaId > 0);
      noteIds.add(mediaId);
      mediaAdded = true;
    } catch { /* A host without media writes can still test ordinary review. */ }

    stage = 'create disposable audio card';
    let audioAdded = false;
    let basicAudioId = null;
    let customAudioId = null;
    const audioBefore = await invoke('retrieveMediaFile', { filename: audioFilename });
    assert.equal(audioBefore, false, 'The generated audio name unexpectedly exists.');
    state.mediaNames.add(audioFilename);
    try {
      await invoke('storeMediaFile', { filename: audioFilename, data: wavSilence() });
      basicAudioId = await invoke('addNote', { note: basicNote(deck, token,
        `audio front [sound:${audioFilename}]`, 'audio back') });
      assert.ok(Number.isSafeInteger(basicAudioId) && basicAudioId > 0);
      noteIds.add(basicAudioId);
      audioAdded = true;
    } catch { /* A host without audio storage can still test ordinary review. */ }
    if (audioAdded && models.audioModel) {
      stage = 'create disposable custom audio card';
      try {
        customAudioId = await invoke('addNote', { note: {
          deckName: deck, modelName: models.audioModel.name,
          fields: Object.fromEntries(models.audioModel.fields.map((name, index) => [name,
            name === models.audioModel.audioField ? `[sound:${audioFilename}]` : `${token} field ${index + 1}`])),
          options: { allowDuplicate: false },
        } });
        assert.ok(Number.isSafeInteger(customAudioId) && customAudioId > 0);
        noteIds.add(customAudioId);
      } catch { /* Existing custom templates are never changed. */ }
    }

    stage = 'discover disposable cards';
    const markerIds = await invoke('findNotes', { query: token });
    assert.ok(Array.isArray(markerIds) && [...noteIds].every((id) => markerIds.includes(id)),
      'The unique marker search cannot recover every disposable note.');
    const { cards, cardIds } = await collectDisposableCards(invoke, noteIds, deck, token);
    const mediaCardIds = new Set(cards.filter((card) => mediaAdded && String(card.fields?.Front?.value ?? '').includes(mediaFilename)).map((card) => card.cardId));
    const basicAudioCardIds = new Set(cards.filter((card) => card.note === basicAudioId).map((card) => card.cardId));
    assert.ok(cards.filter((card) => basicAudioCardIds.has(card.cardId)).every((card) => card.modelName === 'Basic'));
    const clozeCardIds = new Set(cards.filter((card) => card.note === clozeId).map((card) => card.cardId));
    const customAudioCardIds = new Set(cards.filter((card) => card.note === customAudioId).map((card) => card.cardId));
    const customCardIds = new Set(cards.filter((card) => customAdded && card.modelName === models.custom.name && card.note !== customAudioId).map((card) => card.cardId));
    if (process.env.WHILE_ANKI_SMOKE_AUDIO_SHAPE === '1' && basicAudioId) {
      const question = cards.find((card) => card.note === basicAudioId)?.question ?? '';
      console.log(`Basic audio player tokens: ${(question.match(/\[anki:play:[qa]:\d+\]/g) ?? []).length}`);
      console.log(`Basic Front field retained sound tag: ${String(cards.find((card) => card.note === basicAudioId)?.fields?.Front?.value ?? '').includes(`[sound:${audioFilename}]`)}`);
    }
    const baseline = new Map();
    for (const cardId of cardIds) baseline.set(cardId, (await anki.reviewHistory(cardId)).length);

    stage = 'connect plugin tools';
    tools = await connectTools(localState);
    const call = async (name, args) => checkTool(await tools.client.callTool({ name, arguments: args }), name);
    viewId = (await call('show_anki_review', {})).viewId;
    const listed = await call('list_anki_decks', {});
    assert.ok(listed.decks.includes(deck));

    stage = 'review disposable cards';
    let review = await call('start_anki_review', { deck });
    const sessionId = review.view.sessionId;
    const rated = new Set();
    let sawMedia = false;
    let sawBasicAudio = false;
    let sawCustomAudio = false;
    let sawCustom = false;
    let sawCloze = false;
    while (!review.view.done) {
      const { cardId, nonce } = review.view;
      assert.ok(cardIds.includes(cardId) && !rated.has(cardId), 'The review selected an unexpected card.');
      if (mediaCardIds.has(cardId)) {
        assert.ok(review.view.card.media.question.some((item) => item.type === 'image'), 'The media image was not embedded.');
        sawMedia = true;
      }
      if (customCardIds.has(cardId)) {
        assert.ok(review.view.card?.question || review.view.card?.media?.question?.length);
        assert.ok(review.view.card?.answer || review.view.card?.media?.answer?.length);
        sawCustom = true;
      }
      if (clozeCardIds.has(cardId)) sawCloze = true;
      if (basicAudioCardIds.has(cardId)) {
        const audio = review.view.card.media.question.filter((item) => item.type === 'audio');
        assert.equal(audio.length, 1, 'The Basic Front sound was missing or duplicated.');
        assert.ok(audio[0].src.startsWith('data:audio/wav;base64,'));
        sawBasicAudio = true;
      }
      if (customAudioCardIds.has(cardId)) {
        sawCustomAudio ||= [...review.view.card.media.question, ...review.view.card.media.answer]
          .some((item) => item.type === 'audio' && typeof item.src === 'string' && item.src.startsWith('data:audio/'));
      }
      const resumed = await call('resume_anki_review', { sessionId });
      assert.equal(resumed.view.cardId, cardId);
      assert.equal(resumed.view.nonce, nonce);
      review = await call('rate_anki_review', { sessionId, cardId, nonce, ease: 4 });
      assert.equal(review.recorded, true);
      rated.add(cardId);
      const history = await anki.reviewHistory(cardId);
      assert.equal(history.length, baseline.get(cardId) + 1, 'Anki did not record exactly one review.');
      assert.ok(history.some((entry) => entry.ease === 4), 'Anki did not record the chosen Easy rating.');
      assert.ok(rated.size <= cardIds.length, 'Review did not finish after the disposable cards.');
    }
    assert.equal(rated.size, cardIds.length);
    assert.equal(review.view.reviewed, cardIds.length);
    assert.equal((await call('resume_anki_review', { sessionId })).view.done, true);
    if (mediaAdded) assert.ok(sawMedia, 'The disposable media card was not reviewed.');
    if (customAdded) assert.ok(sawCustom, 'The existing custom template was not reviewed.');
    if (clozeAdded) assert.ok(sawCloze, 'The disposable Cloze card was not reviewed.');
    if (audioAdded) assert.ok(sawBasicAudio, 'The disposable Basic audio card was not reviewed.');
    stage = 'custom Audio-field media not embedded';
    if (customAudioId !== null) assert.ok(sawCustomAudio, 'The custom Audio-field sound was not embedded.');
    result = { reviewed: rated.size, clozeAdded, customAdded, mediaAdded, audioAdded,
      basicAudioEmbedded: sawBasicAudio, customAudioAdded: customAudioId !== null,
      customAudioEmbedded: sawCustomAudio };
  } catch (error) { failure = { stage, name: error?.name || 'Error' }; }
  finally {
    if (tools) {
      if (viewId) {
        try { checkTool(await tools.client.callTool({ name: 'hide_anki_review', arguments: { viewId } }), 'hide_anki_review'); }
        catch { failure ??= { stage: 'hide plugin view', name: 'Error' }; }
      }
      await Promise.allSettled([tools.client.close(), tools.server.close()]);
    }
    cleanupWarnings = await cleanup(invoke, state);
    await rm(localState, { recursive: true, force: true });
    if (cleanupWarnings.length) failure ??= { stage: 'cleanup', name: cleanupWarnings.join(' ') };
  }
  if (failure) throw new Error(`Live smoke failed at ${failure.stage} (${failure.name}).${cleanupWarnings.length ? ` Cleanup: ${cleanupWarnings.join(' ')}` : ''}`);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') {
    console.error('Usage: npm run smoke:live -- --run (mutates and then removes a disposable Anki deck)');
    process.exitCode = 2;
  } else {
    try {
      const result = await liveSmoke();
      console.log(`Live Anki smoke passed: ${result.reviewed} disposable card(s) reviewed; cloze ${result.clozeAdded ? 'tested' : 'unavailable'}; existing custom template ${result.customAdded ? 'tested' : 'unavailable'}; image ${result.mediaAdded ? 'tested' : 'unavailable'}; Basic audio ${result.basicAudioEmbedded ? 'embedded' : result.audioAdded ? 'not embedded' : 'unavailable'}; custom Audio-field ${result.customAudioAdded ? result.customAudioEmbedded ? 'embedded' : 'not embedded' : 'unavailable'}. Disposable deck and media removed.`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
