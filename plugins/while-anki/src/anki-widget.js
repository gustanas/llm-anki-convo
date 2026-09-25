import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'While Anki review', version: '0.2.0' });
const elements = Object.fromEntries([
  'review-root',
  'deck-panel', 'deck-select', 'start-review', 'resume-review', 'refresh-decks', 'card-panel',
  'deck-name', 'progress', 'question', 'question-media', 'answer', 'answer-text',
  'answer-media', 'reveal-row', 'reveal-answer', 'rating-row', 'choose-deck', 'reload-card', 'status',
].map((id) => [id, document.getElementById(id)]));
const el = (id) => elements[id];
const labels = ['Again', 'Hard', 'Good', 'Easy'];
const imageSource = /^data:image\/(?:png|jpeg|gif|webp);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const audioSource = /^data:audio\/(?:mpeg|mp3|ogg|wav|mp4|aac|flac);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const sessionKey = 'while-anki-mcp-session-id';
const pendingKey = 'while-anki-mcp-pending-v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let connected = false;
let busy = false;
let view = null;
let revealed = false;
let pendingRating = null;
let awaitingNextCard = false;
let viewId = null;
let visibilityTimer = null;
let checkingVisibility = false;
let dismissed = false;

function message(text, error = false) {
  if (dismissed) return;
  el('status').textContent = text;
  el('status').dataset.error = String(error);
}

function rememberedSession() {
  try { return sessionStorage.getItem(sessionKey); }
  catch { return null; }
}

function rememberSession(id) {
  try {
    if (id) sessionStorage.setItem(sessionKey, id);
    else sessionStorage.removeItem(sessionKey);
  } catch { /* Session remains usable until this widget closes. */ }
}

function rememberPending(args) {
  try {
    if (args) sessionStorage.setItem(pendingKey, JSON.stringify({ version: 1, view, args }));
    else sessionStorage.removeItem(pendingKey);
    return true;
  } catch { return false; }
}

function validView(next) {
  return next && typeof next === 'object' && typeof next.sessionId === 'string' &&
    typeof next.deck === 'string' && Number.isSafeInteger(next.reviewed) &&
    typeof next.done === 'boolean' && (next.done || (next.card &&
      typeof next.card.question === 'string' && typeof next.card.answer === 'string' &&
      Number.isSafeInteger(next.cardId) && next.cardId > 0 && typeof next.nonce === 'string'));
}

function restorePending() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null'); }
  catch { rememberPending(null); return false; }
  const args = saved?.args;
  if (saved?.version !== 1 || !validView(saved.view) || saved.view.done ||
      !args || args.sessionId !== saved.view.sessionId ||
      args.cardId !== saved.view.cardId || args.nonce !== saved.view.nonce ||
      !Number.isInteger(args.ease) || args.ease < 1 || args.ease > 4) {
    rememberPending(null);
    return false;
  }
  view = saved.view;
  revealed = true;
  pendingRating = { ease: args.ease, args };
  rememberSession(view.sessionId);
  paintView();
  message(`Previous rating was not confirmed. Reopen Anki if needed, then retry ${labels[args.ease - 1]}.`);
  return true;
}

function toolError(result) {
  return result?.content?.find((item) => item?.type === 'text')?.text || 'Anki did not confirm the action.';
}

async function call(name, args) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result?.isError) throw new Error(toolError(result));
  if (!result?.structuredContent || typeof result.structuredContent !== 'object') {
    throw new Error(`The ${name} tool returned no usable result.`);
  }
  return result.structuredContent;
}

function addMedia(container, items, side) {
  container.replaceChildren();
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item.src !== 'string') continue;
    if (item.type === 'image' && imageSource.test(item.src)) {
      const image = document.createElement('img');
      image.src = item.src;
      image.alt = typeof item.alt === 'string' && item.alt.trim() ? item.alt : `${side} image`;
      container.append(image);
    } else if (item.type === 'audio' && audioSource.test(item.src)) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = item.src;
      audio.setAttribute('aria-label', `${side} audio`);
      container.append(audio);
    }
  }
}

function renderRatings() {
  el('rating-row').replaceChildren();
  labels.forEach((label, index) => {
    const ease = index + 1;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = index === 2 ? 'primary' : '';
    button.dataset.ease = String(ease);
    button.setAttribute('aria-label', `Record ${label} in Anki`);
    const name = document.createElement('span');
    name.textContent = label;
    button.append(name);
    const interval = view?.intervals?.[index];
    if (typeof interval === 'string' || typeof interval === 'number') {
      const small = document.createElement('small');
      small.textContent = String(interval).slice(0, 32);
      button.append(small);
    }
    button.addEventListener('click', () => void rate(ease));
    el('rating-row').append(button);
  });
}

function renderControls() {
  if (dismissed) return;
  const active = view !== null;
  el('deck-panel').hidden = active;
  el('card-panel').hidden = !active;
  el('deck-select').disabled = !connected || busy || !el('deck-select').value;
  el('start-review').disabled = !connected || busy || !el('deck-select').value;
  el('resume-review').hidden = !rememberedSession();
  el('resume-review').disabled = !connected || busy || !rememberedSession();
  el('refresh-decks').disabled = !connected || busy;
  if (!active) return;
  el('answer').hidden = view.done || !revealed;
  el('reveal-row').hidden = view.done || revealed;
  el('reveal-answer').disabled = busy;
  el('rating-row').hidden = view.done || !revealed || awaitingNextCard;
  for (const button of el('rating-row').querySelectorAll('button')) {
    button.disabled = busy || awaitingNextCard || (pendingRating !== null && pendingRating.ease !== Number(button.dataset.ease));
  }
  el('choose-deck').disabled = busy || pendingRating !== null;
  el('reload-card').disabled = busy || pendingRating !== null;
}

function paintView() {
  if (dismissed) return;
  el('deck-name').textContent = view.deck;
  el('progress').textContent = `${view.reviewed} saved${view.remaining === null ? '' : ` · ${view.remaining} available`}`;
  el('question').textContent = view.done ? 'No due or new cards remain.' : view.card.question;
  el('answer-text').textContent = view.done ? '' : view.card.answer;
  addMedia(el('question-media'), view.done ? [] : view.card.media?.question, 'Question');
  addMedia(el('answer-media'), view.done ? [] : view.card.media?.answer, 'Answer');
  if (!view.done) renderRatings();
  else el('rating-row').replaceChildren();
  renderControls();
}

function acceptView(next) {
  if (!validView(next)) {
    throw new Error('Anki returned an invalid review card. No card was advanced here.');
  }
  view = next;
  revealed = false;
  pendingRating = null;
  awaitingNextCard = false;
  rememberSession(view.sessionId);
  rememberPending(null);
  if (dismissed) { view = null; return; }
  paintView();
  message(view.done ? `${view.reviewed} reviews saved in Anki. This deck is clear for now.` : 'Reveal the answer, then choose an Anki rating.');
}

async function loadDecks() {
  if (!connected || busy || dismissed) return;
  busy = true;
  renderControls();
  message('Loading Anki decks…');
  try {
    const { decks, lastUsedDeck } = await call('list_anki_decks', {});
    if (dismissed) return;
    if (!Array.isArray(decks) || !decks.every((deck) => typeof deck === 'string')) {
      throw new Error('Anki returned an invalid deck list.');
    }
    const selected = el('deck-select').value;
    el('deck-select').replaceChildren();
    for (const deck of decks) {
      const option = document.createElement('option');
      option.value = deck;
      option.textContent = deck;
      el('deck-select').append(option);
    }
    if (decks.includes(selected)) el('deck-select').value = selected;
    else if (typeof lastUsedDeck === 'string' && decks.includes(lastUsedDeck)) {
      el('deck-select').value = lastUsedDeck;
    }
    message(decks.length ? 'Choose a deck to start.' : 'No Anki decks found. Import a deck, then refresh.');
  } catch (error) {
    message(`Could not load Anki decks: ${error.message ?? String(error)} Open Anki, then refresh.`, true);
  } finally {
    busy = false;
    renderControls();
  }
}

async function start() {
  const deck = el('deck-select').value;
  if (!connected || busy || !deck || dismissed) return;
  busy = true;
  renderControls();
  message('Finding the next due or new card…');
  try {
    const result = await call('start_anki_review', { deck });
    acceptView(result.view);
  } catch (error) {
    message(`Could not start review: ${error.message ?? String(error)}`, true);
  } finally {
    busy = false;
    renderControls();
  }
}

async function resume(sessionId) {
  if (!connected || busy || !sessionId || dismissed) return;
  busy = true;
  renderControls();
  message('Restoring your Anki review…');
  try {
    const result = await call('resume_anki_review', { sessionId });
    acceptView(result.view);
  } catch (error) {
    message(`Could not reload this review: ${error.message ?? String(error)} Open Anki and try again.`, true);
  } finally {
    busy = false;
    renderControls();
  }
}

async function rate(ease) {
  if (!connected || busy || dismissed || !view || view.done || !revealed ||
      !Number.isInteger(ease) || ease < 1 || ease > 4 ||
      (pendingRating && pendingRating.ease !== ease)) return;
  const args = pendingRating?.args ?? {
    sessionId: view.sessionId,
    cardId: view.cardId,
    nonce: view.nonce,
    ease,
  };
  pendingRating = { ease, args };
  const persisted = rememberPending(args);
  busy = true;
  renderControls();
  message(persisted ? `Saving ${labels[ease - 1]} in Anki…` :
    `Saving ${labels[ease - 1]} in Anki… Keep this card open until Anki confirms it.`);
  try {
    const result = await call('rate_anki_review', args);
    if (result.recorded !== true) throw new Error('Anki did not confirm the rating.');
    try { acceptView(result.view); }
    catch (error) {
      pendingRating = null;
      awaitingNextCard = true;
      rememberPending(null);
      message(`Rating saved in Anki, but the next card could not load: ${error.message ?? String(error)} Use Reload card.`, true);
    }
  } catch (error) {
    message(`Rating was not confirmed: ${error.message ?? String(error)} Retry ${labels[ease - 1]} on this card.`, true);
  } finally {
    busy = false;
    renderControls();
  }
}

el('refresh-decks').addEventListener('click', () => void loadDecks());
el('start-review').addEventListener('click', () => void start());
el('resume-review').addEventListener('click', () => void resume(rememberedSession()));
el('reveal-answer').addEventListener('click', () => {
  if (!view || view.done || busy || revealed || dismissed) return;
  revealed = true;
  renderControls();
  el('rating-row').querySelector('button')?.focus({ preventScroll: true });
});
el('choose-deck').addEventListener('click', () => {
  if (busy || pendingRating || dismissed) return;
  rememberSession(null);
  rememberPending(null);
  view = null;
  revealed = false;
  awaitingNextCard = false;
  renderControls();
  message('Choose a deck to start.');
});
el('reload-card').addEventListener('click', () => {
  if (!view || busy || pendingRating || dismissed) return;
  void resume(view.sessionId);
});

function stopVisibilityChecks() {
  if (visibilityTimer !== null) clearInterval(visibilityTimer);
  visibilityTimer = null;
}

function dismiss() {
  if (dismissed) return;
  dismissed = true;
  stopVisibilityChecks();
  // Only the displayed content is removed. The session and any exact pending
  // rating remain in sessionStorage so a later widget can recover safely.
  view = null;
  el('question').textContent = '';
  el('answer-text').textContent = '';
  el('deck-name').textContent = '';
  el('progress').textContent = '';
  el('question-media').replaceChildren();
  el('answer-media').replaceChildren();
  el('rating-row').replaceChildren();
  el('deck-select').replaceChildren();
  el('status').textContent = '';
  el('review-root').hidden = true;
  document.body.style.padding = '0';
  document.body.style.height = '1px';
  document.body.style.minHeight = '1px';
  document.body.style.overflow = 'hidden';
  document.documentElement.style.height = '1px';
  document.documentElement.style.minHeight = '1px';
  document.documentElement.style.overflow = 'hidden';
  // Some hosts ignore a zero-size notification. Keep the SDK's automatic
  // resize measurement and this explicit notification at the same tiny size.
  try { void app.sendSizeChanged({ height: 1 }).catch(() => {}); }
  catch { /* The host may decline resize. */ }
  // ChatGPT exposes a stronger optional close request. Feature-detect it so
  // portable MCP Apps hosts can continue using the standard teardown signal.
  try {
    if (typeof window !== 'undefined' && typeof window.openai?.requestClose === 'function') {
      void Promise.resolve(window.openai.requestClose()).catch(() => {});
    }
  } catch { /* The standard teardown request below still runs. */ }
  try { void app.requestTeardown().catch(() => {}); }
  catch { /* The hidden root stays collapsed if the host declines teardown. */ }
}

async function checkVisibility() {
  if (!connected || !viewId || dismissed || checkingVisibility) return;
  checkingVisibility = true;
  try {
    const state = await call('get_anki_view_state', { viewId });
    if (state.viewId === viewId && state.hidden === true) dismiss();
  } catch { /* A transient check failure should not interrupt a review. */ }
  finally { checkingVisibility = false; }
}

function startVisibilityChecks() {
  if (!connected || !viewId || dismissed || visibilityTimer !== null) return;
  void checkVisibility();
  visibilityTimer = setInterval(() => void checkVisibility(), 1500);
}

// The initial show_anki_review result supplies an identifier for this widget
// instance. Keep this listener in place before connecting to the host.
app.ontoolresult = (result) => {
  const data = result?.structuredContent;
  if (data?.status !== 'ready' || typeof data.viewId !== 'string' ||
      !uuid.test(data.viewId) || viewId !== null) return;
  viewId = data.viewId;
  startVisibilityChecks();
};
app.onteardown = async () => { stopVisibilityChecks(); return {}; };

app.onerror = (error) => message(`Host error: ${error.message ?? String(error)}`, true);

async function connect() {
  try {
    await app.connect();
    if (!app.getHostCapabilities()?.serverTools) {
      message('This host does not support direct MCP App actions.', true);
      return;
    }
    connected = true;
    startVisibilityChecks();
    renderControls();
    if (dismissed) return;
    if (restorePending()) return;
    await loadDecks();
    const sessionId = rememberedSession();
    if (sessionId) await resume(sessionId);
  } catch (error) {
    message(`MCP Apps connection failed: ${error.message ?? String(error)}`, true);
  }
}

renderControls();
void connect();
