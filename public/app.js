"use strict";

(() => {
  const storageKey = "while.quiz.v1";
  const root = document.querySelector("#quiz-root");
  const stats = document.querySelector("#session-stats");
  const announcement = document.querySelector("#quiz-announcement");
  const workAnnouncement = document.querySelector("#work-announcement");
  const badge = document.querySelector("#connection-badge");
  const badgeLabel = document.querySelector("#connection-label");
  const workStrip = document.querySelector("#work-strip");
  const workTitle = document.querySelector("#work-title");
  const workDescription = document.querySelector("#work-description");
  const demoButton = document.querySelector("#demo-button");
  const demoError = document.querySelector("#demo-error");

  let cards = [];
  let position = 0;
  let answers = Object.create(null);
  let fingerprint = "";
  let storageAvailable = true;
  let taskState = null;
  let connection = "connecting";
  let demoPending = false;
  let previousWorkMessage = "";
  let eventRevision = 0;
  let events;

  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const countLabel = (value) => String(value).padStart(2, "0");
  const hasAnswer = (card) => card && Object.prototype.hasOwnProperty.call(answers, card.id);

  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { "Accept": "application/json", ...options.headers } });
    let data;
    try { data = await response.json(); } catch { throw new Error("The companion returned an unreadable response. Please try again."); }
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : `The request failed (${response.status}). Please try again.`);
    return data;
  }

  function validateCards(data) {
    const ids = new Set();
    if (!data || !Array.isArray(data.cards) || data.cards.length === 0) throw new Error("This deck has no questions yet. Add a few cards and try again.");
    return data.cards.map((card) => {
      if (!card || typeof card.id !== "string" || !card.id || ids.has(card.id) || typeof card.question !== "string" || !Array.isArray(card.choices) || card.choices.length < 2 || card.choices.length > 4 || !card.choices.every((choice) => typeof choice === "string") || !Number.isInteger(card.answerIndex) || card.answerIndex < 0 || card.answerIndex >= card.choices.length || typeof card.explanation !== "string") throw new Error("A question in this deck is incomplete. Please check the card data and try again.");
      ids.add(card.id);
      return { ...card, category: typeof card.category === "string" ? card.category : "Curiosity" };
    });
  }

  function deckFingerprint(deck) {
    const value = JSON.stringify(deck.map(({ id, question, choices, answerIndex }) => ({ id, question, choices, answerIndex })));
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16);
  }

  function restoreProgress() {
    answers = Object.create(null);
    position = 0;
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (!stored || stored.fingerprint !== fingerprint || !Number.isInteger(stored.position) || stored.position < 0 || stored.position > cards.length || !stored.answers || typeof stored.answers !== "object") return;
      position = stored.position;
      for (const card of cards.slice(0, Math.min(position + 1, cards.length))) {
        const answer = Object.prototype.hasOwnProperty.call(stored.answers, card.id) ? stored.answers[card.id] : undefined;
        if (Number.isInteger(answer) && answer >= 0 && answer < card.choices.length) answers[card.id] = answer;
      }
    } catch {
      // A corrupt saved session should not prevent a fresh quiz from loading.
    }
  }

  function saveProgress() {
    try { localStorage.setItem(storageKey, JSON.stringify({ fingerprint, position, answers })); }
    catch { storageAvailable = false; }
  }

  function getScore() {
    return cards.reduce((score, card) => {
      if (hasAnswer(card)) {
        score.answered += 1;
        if (answers[card.id] === card.answerIndex) score.correct += 1;
      }
      return score;
    }, { answered: 0, correct: 0 });
  }

  function updateStats() {
    const { answered, correct } = getScore();
    stats.textContent = answered ? `${answered} answered · ${correct} correct${storageAvailable ? " · Progress saved" : " · Saved for this visit"}` : storageAvailable ? "Your progress stays in this browser." : "Your progress lasts for this visit.";
  }

  function sourceLink(card) {
    if (!card.source || typeof card.source.url !== "string") return "";
    try {
      const url = new URL(card.source.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      return `<a class="source-link" href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(card.source.label || "Read more")} <span aria-hidden="true">↗</span></a>`;
    } catch { return ""; }
  }

  function renderQuiz({ focus = false } = {}) {
    root.setAttribute("aria-busy", "false");
    updateStats();
    if (position >= cards.length) {
      renderComplete(focus);
      return;
    }
    const card = cards[position];
    const answered = hasAnswer(card);
    const selected = answers[card.id];
    const correct = selected === card.answerIndex;
    const lastCard = position === cards.length - 1;
    root.innerHTML = `<article class="quiz-card" aria-labelledby="question-title">
      <div class="card-topline"><span class="category">${escapeHTML(card.category)}</span><span class="card-count" aria-label="Question ${position + 1} of ${cards.length}"><strong>${countLabel(position + 1)}</strong> / ${countLabel(cards.length)}</span></div>
      <h2 class="question" id="question-title" tabindex="-1">${escapeHTML(card.question)}</h2>
      <div class="choices" role="group" aria-labelledby="question-title">${card.choices.map((choice, index) => {
        const isCorrect = answered && index === card.answerIndex;
        const isWrong = answered && index === selected && !correct;
        const resultLabel = isCorrect ? (index === selected ? "Your answer, correct" : "Correct answer") : isWrong ? "Your answer, incorrect" : "";
        return `<button class="choice${isCorrect ? " is-correct" : isWrong ? " is-wrong" : answered ? " is-dimmed" : ""}" type="button" data-answer="${index}"${answered ? " disabled" : ""}${resultLabel ? ` aria-label="${escapeHTML(choice)}. ${resultLabel}"` : ""}><span class="choice-key" aria-hidden="true">${index + 1}</span><span class="choice-text">${escapeHTML(choice)}</span>${isCorrect || isWrong ? `<span class="choice-result" aria-hidden="true">${isCorrect ? "✓" : "×"}</span>` : ""}</button>`;
      }).join("")}</div>
      ${answered ? `<div class="explanation"><p class="explanation-title">${correct ? "That's right. A little more to know:" : "A new thing to know:"}</p><p class="explanation-copy">${escapeHTML(card.explanation)}</p>${sourceLink(card)}</div>` : ""}
      <div class="card-actions">${answered ? `<p class="answer-prompt">One small thing learned.</p>` : `<button class="skip-button" type="button" id="skip-button">Skip for now</button>`}<button class="next-button" type="button" id="next-button"${answered ? "" : " disabled"}>${lastCard ? "See results" : "Next question"}<span aria-hidden="true">→</span></button></div>
    </article>`;
    root.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => selectAnswer(Number(button.dataset.answer))));
    root.querySelector("#skip-button")?.addEventListener("click", () => advance(true));
    root.querySelector("#next-button").addEventListener("click", () => advance(false));
    if (focus) root.querySelector("#question-title").focus();
  }

  function selectAnswer(index) {
    const card = cards[position];
    if (!card || hasAnswer(card) || !Number.isInteger(index) || index < 0 || index >= card.choices.length) return;
    answers[card.id] = index;
    saveProgress();
    renderQuiz();
    announcement.textContent = `${index === card.answerIndex ? "Correct." : `The correct answer is ${card.choices[card.answerIndex]}.`} ${card.explanation}`;
    root.querySelector("#next-button").focus({ preventScroll: true });
  }

  function advance(skip) {
    const card = cards[position];
    if (!card || (!skip && !hasAnswer(card))) return;
    position += 1;
    announcement.textContent = "";
    saveProgress();
    renderQuiz({ focus: true });
  }

  function renderComplete(focus) {
    const { answered, correct } = getScore();
    const skipped = cards.length - answered;
    root.innerHTML = `<article class="quiz-card complete-card" aria-labelledby="complete-title">
      <div class="complete-symbol" aria-hidden="true">✳</div><p class="eyebrow">A MOMENT WELL SPENT</p>
      <h2 id="complete-title" tabindex="-1">A little wiser already.</h2>
      <p class="complete-copy">${answered === 0 ? "You’ve reached the end of this collection. Give it another go whenever curiosity strikes." : "That’s the collection. Take a new little fact with you, or give your memory another round."}</p>
      <div class="score-line" aria-label="Quiz results"><div class="score-stat"><strong>${correct}<span aria-hidden="true"> / </span>${cards.length}</strong><span>correct</span></div><div class="score-stat"><strong>${answered}</strong><span>answered</span></div><div class="score-stat"><strong>${skipped}</strong><span>skipped</span></div></div>
      <button class="next-button" type="button" id="restart-button">Go again <span aria-hidden="true">↻</span></button>
    </article>`;
    root.querySelector("#restart-button").addEventListener("click", () => {
      position = 0;
      answers = Object.create(null);
      saveProgress();
      renderQuiz({ focus: true });
      announcement.textContent = "A fresh round. Question 1.";
    });
    if (focus) {
      root.querySelector("#complete-title").focus();
      announcement.textContent = `Collection complete. ${correct} correct, ${answered} answered, ${skipped} skipped.`;
    }
  }

  async function loadCards() {
    root.setAttribute("aria-busy", "true");
    try {
      cards = validateCards(await request("/api/cards"));
      fingerprint = deckFingerprint(cards);
      restoreProgress();
      saveProgress();
      renderQuiz();
    } catch (error) {
      root.setAttribute("aria-busy", "false");
      root.innerHTML = `<div class="quiz-card error-card" role="alert"><h2>Our questions are taking a moment.</h2><p>${escapeHTML(error.message)}</p><button class="retry-button" type="button" id="retry-button">Try again <span aria-hidden="true">↻</span></button></div>`;
      root.querySelector("#retry-button").addEventListener("click", loadCards);
      stats.textContent = "Your saved progress is still here.";
    }
  }

  function acceptState(state) {
    if (!state || !["idle", "working", "complete", "interrupted"].includes(state.status) || !Number.isInteger(state.activeCount) || state.activeCount < 0 || !["live", "demo", null].includes(state.source)) return false;
    taskState = state;
    renderWorkState();
    return true;
  }

  function renderWorkState() {
    const offline = connection === "offline";
    const connecting = connection === "connecting";
    const demo = taskState?.source === "demo";
    const status = taskState?.status || "idle";
    let label;
    let title;
    let description;
    if (offline) {
      label = "Companion offline";
      title = "Task updates are disconnected";
      description = "Your quiz still works. Reconnecting automatically…";
    } else if (connecting && !taskState) {
      label = "Connecting to companion…";
      title = "Connecting to your companion";
      description = "You can keep learning at your own pace.";
    } else if (status === "working") {
      label = demo ? "Demo is running" : "Codex is working";
      title = demo ? "A pretend task is in progress" : taskState.activeCount > 1 ? `Codex is working on ${taskState.activeCount} tasks` : "Codex is working on your task";
      description = demo ? "Try a question, then finish the demo." : "We’ll let you know here when it’s ready.";
    } else if (status === "complete") {
      label = demo ? "Demo complete" : "Your task is ready";
      title = demo ? "The demo task is complete" : "Codex has finished your task";
      description = demo ? "That’s how a finished task appears here." : "Your result is waiting in Codex. Finish this card at your pace.";
    } else if (status === "interrupted") {
      label = demo ? "Demo interrupted" : "Task interrupted";
      title = demo ? "The demo task was interrupted" : "Your Codex task was interrupted";
      description = "You can return to Codex, or keep learning here.";
    } else {
      label = "Ready when you are";
      title = "A little space between tasks";
      description = "Start a Codex task, or try a demo to see it in action.";
    }
    const displayedStatus = offline ? "offline" : status;
    badge.dataset.status = displayedStatus;
    workStrip.dataset.status = displayedStatus;
    badgeLabel.textContent = label;
    workTitle.textContent = title;
    workDescription.textContent = description;
    demoButton.innerHTML = demoPending ? "One moment…" : demo && status === "working" ? 'Finish demo <span aria-hidden="true">✓</span>' : 'Try demo <span aria-hidden="true">↗</span>';
    demoButton.disabled = demoPending || connection !== "connected" || (taskState?.source === "live" && status === "working");
    demoButton.title = taskState?.source === "live" && status === "working" ? "A live Codex task is already running" : "Preview task updates with a pretend task";
    if (previousWorkMessage && previousWorkMessage !== title) workAnnouncement.textContent = `${title}. ${description}`;
    previousWorkMessage = title;
  }

  async function loadState() {
    const revision = eventRevision;
    try {
      const state = await request("/api/state");
      // A snapshot started before a live event must not overwrite that event.
      if (revision === eventRevision) acceptState(state);
    }
    catch { /* EventSource retries independently; quiz progress stays usable. */ }
  }

  function connectEvents() {
    if (!("EventSource" in window)) {
      connection = "offline";
      renderWorkState();
      workDescription.textContent = "Live task updates aren’t available in this browser. Your quiz still works.";
      return;
    }
    events = new EventSource("/api/events");
    events.addEventListener("open", () => {
      connection = "connected";
      renderWorkState();
      loadState();
    });
    events.addEventListener("state", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (acceptState(data)) {
          eventRevision += 1;
          connection = "connected";
          renderWorkState();
        }
      } catch { /* Ignore malformed event data; keep the most recent valid state. */ }
    });
    events.addEventListener("error", () => {
      connection = "offline";
      renderWorkState();
    });
  }

  demoButton.addEventListener("click", async () => {
    if (demoPending || demoButton.disabled) return;
    const action = taskState?.source === "demo" && taskState.status === "working" ? "finish" : "start";
    demoPending = true;
    demoError.hidden = true;
    renderWorkState();
    try {
      const state = await request("/api/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      if (!acceptState(state)) throw new Error("The demo returned an unexpected response. Please try again.");
    } catch (error) {
      demoError.textContent = error.message;
      demoError.hidden = false;
    } finally {
      demoPending = false;
      renderWorkState();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    const card = cards[position];
    if (!card) return;
    if (/^[1-4]$/.test(event.key) && !hasAnswer(card)) {
      event.preventDefault();
      selectAnswer(Number(event.key) - 1);
    } else if (event.key === "Enter" && hasAnswer(card) && (event.target === document.body || event.target === root.querySelector("#next-button"))) {
      event.preventDefault();
      advance(false);
    }
  });

  loadCards();
  loadState();
  connectEvents();
})();
