import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, collectDisposableCards, existingModels } from '../scripts/live-smoke.mjs';

const TOKEN = 'a'.repeat(32);
const DECK = `While Anki Smoke ${TOKEN}`;

test('live smoke rejects note types with a template deck override before creating cards', async () => {
  const specs = new Map([
    [1, { id: 1, name: 'Basic', tmpls: [{ did: null }] }],
    [2, { id: 2, name: 'Custom', tmpls: [{ did: 42 }] }],
  ]);
  const invoke = async (action, params = {}) => {
    if (action === 'modelNames') return ['Basic', 'Custom'];
    if (action === 'modelNamesAndIds') return { Basic: 1, Custom: 2 };
    if (action === 'findModelsById') return [specs.get(params.modelIds[0])];
    if (action === 'modelFieldNames') return ['Front', 'Back'];
    throw new Error(`Unexpected ${action}`);
  };
  assert.equal((await existingModels(invoke)).custom, null);
  specs.get(1).tmpls[0].did = 42;
  await assert.rejects(existingModels(invoke), /Basic has a deck override/);
});

test('live smoke refuses to grade a card placed outside its disposable deck', async () => {
  const invoke = async (action, params = {}) => {
    if (action === 'notesInfo') return [{ noteId: 10, fields: { Front: { value: `${TOKEN} test` } } }];
    if (action === 'findCards' && params.query === 'nid:10') return [100];
    if (action === 'cardsInfo') return [{ cardId: 100, note: 10, deckName: 'Imported deck' }];
    throw new Error(`Unexpected ${action}`);
  };
  await assert.rejects(collectDisposableCards(invoke, new Set([10]), DECK, TOKEN), /outside the disposable deck/);
});

test('cleanup removes only marker-verified note IDs, including cards outside the disposable deck', async () => {
  const filename = `while_anki_smoke_${TOKEN}.wav`;
  const deleted = [];
  let notePresent = true;
  let deckPresent = true;
  let mediaPresent = true;
  const invoke = async (action, params = {}) => {
    if (action === 'findNotes') return params.query === TOKEN || params.query === 'nid:10'
      ? notePresent ? [10] : [] : [];
    if (action === 'notesInfo') return [{ noteId: 10, fields: { Front: { value: `${TOKEN} test` } } }];
    if (action === 'deleteNotes') { deleted.push(['note', ...params.notes]); notePresent = false; return null; }
    if (action === 'deckNamesAndIds') return deckPresent ? { [DECK]: 50 } : {};
    if (action === 'findCards') return [];
    if (action === 'deleteDecks') { deleted.push(['deck', ...params.decks]); deckPresent = false; return null; }
    if (action === 'deckNames') return deckPresent ? [DECK] : [];
    if (action === 'retrieveMediaFile') return mediaPresent ? 'ZGF0YQ==' : false;
    if (action === 'deleteMediaFile') { deleted.push(['media', params.filename]); mediaPresent = false; return null; }
    throw new Error(`Unexpected ${action}`);
  };
  const warnings = await cleanup(invoke, { deck: DECK, token: TOKEN, deckWasAbsent: true,
    createdDeckId: 50, attemptedCreate: true, noteIds: new Set([10]), mediaNames: new Set([filename]) });
  assert.deepEqual(warnings, []);
  assert.deepEqual(deleted, [['note', 10], ['deck', DECK], ['media', filename]]);
});

test('cleanup preserves a note whose unique marker is gone and keeps its deck and media', async () => {
  const filename = `while_anki_smoke_${TOKEN}.png`;
  const deleted = [];
  const invoke = async (action, params = {}) => {
    if (action === 'findNotes') return params.query === TOKEN ? [] : [10];
    if (action === 'notesInfo') return [{ noteId: 10, fields: { Front: { value: 'changed by user' } } }];
    if (action === 'deckNamesAndIds') return { [DECK]: 50 };
    if (action === 'findCards') return [100];
    if (action.startsWith('delete')) { deleted.push(action); return null; }
    throw new Error(`Unexpected ${action}`);
  };
  const warnings = await cleanup(invoke, { deck: DECK, token: TOKEN, deckWasAbsent: true,
    createdDeckId: 50, attemptedCreate: true, noteIds: new Set([10]), mediaNames: new Set([filename]) });
  assert.equal(deleted.length, 0);
  assert.match(warnings.join(' '), /was not deleted/);
  assert.match(warnings.join(' '), /still has cards/);
});
