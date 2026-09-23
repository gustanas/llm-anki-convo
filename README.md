# While

A small quiz for the time you spend waiting for Codex. Practice with sample questions or your own Anki cards directly inside the conversation. Requires Node.js 22 or newer; no npm dependencies or model API calls.

## Use your Anki deck

1. Install [Anki](https://apps.ankiweb.net/) and import a deck.
2. In Anki, open **Tools → Add-ons → Get Add-ons**, enter **2055492159** ([AnkiConnect](https://ankiweb.net/shared/info/2055492159)), and restart Anki.
3. Keep Anki open and list your decks:

```sh
npm run anki:decks
```

Build a small practice batch using the full name from that list:

```sh
npm run anki:build -- --deck "Your deck" --limit 5
```

Ask Codex to **show my Anki quiz inline while you work**. Codex can run the build with `--output /absolute/path/while-anki.html` pointing to its conversation visualization directory and display it in a working update. No browser window or web server is needed.

## Review the whole due and new queue

To save real Anki reviews, ask Codex to **start an unlimited Anki review of my deck inline**. Or start it from the project directory:

```sh
npm run anki:review -- start --deck "Your deck"
```

Codex can pass `--output-dir` with the current conversation's writable visualization directory and show the generated card inline. Choose **Show answer**, then **Again**, **Hard**, **Good**, or **Easy**. The review button asks Codex to save that exact rating through AnkiConnect and then posts the next card at the chat end. This creates one short Codex turn per rating; keep Anki open during the session. If saving fails, the card stays active and the grade is not reported as saved.

The review queue includes **all due and new cards**, including those past Anki's daily cap. It loads one card at a time, so there is no fixed card-count limit or large inline deck snapshot. Future reviews, suspended cards, and buried cards are excluded. Anki controls the next interval and records the review; the card shows Anki's interval labels before you choose. `--skip-identical` can omit course notes whose front and back are identical. The session and grading receipts stay private under ignored `dist/review-sessions/`.

If the session needs refreshing after reopening Anki, use `npm run anki:review -- resume --session UUID` with the session ID printed at start. The CLI checks the review history on retries to avoid recording a grade twice after an uncertain connection result.

The earlier `anki:build` command remains available for a small **practice copy** with no scheduling changes.

The default output is `dist/while-anki.html`. A normalized card snapshot and session details are also saved inside ignored `dist/`. **These files contain your private deck text and media; do not commit or publish them.** Output within this repository is restricted to `dist/` by the live Anki builder.

In the practice copy, use **Show answer** to reveal the back, then **Next card**. The counter tracks cards revealed, not correctness. It does not grade reviews, move cards, sync, or change Anki’s schedule. Rebuilding reads the deck again; an existing inline quiz keeps its snapshot. Without scheduling writes, the next build may select the same cards again.

Selection prioritizes due cards, then new cards, then other available cards if needed. Suspended and buried cards are excluded. This is a practice selection, not Anki’s full reviewer order or daily-limit algorithm. Parent deck names include their subdecks. `--skip-identical` skips cards with identical rendered fronts and backs, such as course introduction notes; it examines up to 100 candidates to fill a batch.

### Card and media support

Basic front/back and rendered cloze cards become plain-text flashcards. Jlab listening cards use their named content fields to retain the prompt, explanations, and media without addon controls. Styling, embedded scripts, and custom interactive templates are not executed. Complex templates may need a dedicated adapter.

Local PNG/JPEG/GIF/WebP images and MP3/OGG/WAV/M4A/AAC/FLAC audio are embedded at build time. Each file is limited to 200 KB and the batch has a 500 KB media budget; the final inline output must stay below 1 MB. Missing, unsupported, or oversized media is reported. Remote media is skipped. Generic sound tags and a single conventional `Audio`/`Sound` field are supported; unresolved custom Anki audio players are reported. Audio uses manual playback controls.

AnkiConnect defaults to `http://127.0.0.1:8765`. Override its local address with `ANKI_CONNECT_URL`, or set `ANKI_CONNECT_KEY` if you configured an API key in the addon. Only loopback HTTP endpoints are accepted. Ordinary deck commands use read actions. The review command separately enables AnkiConnect's `answerCards` action for one verified user-selected rating.

For inspection, save raw Anki card data locally:

```sh
npm run anki:pull -- --deck "Your deck" --limit 10
```

This saves `dist/anki-raw.json`. Raw snapshots contain Anki HTML and are not directly used as inline quiz data. To rebuild an already normalized snapshot without Anki running:

```sh
npm run inline:build -- "$PWD/dist/while-anki.html" --cards "$PWD/dist/anki-cards.json"
```

## Use the sample quiz

Ask Codex to **show the While quiz inline in this conversation**, or build the bundled eight-card sample:

```sh
npm run inline:build -- "$PWD/dist/while-quiz.html"
```

Answer with the buttons or keys **1–4** while the quiz has focus, then choose **Next question** or press **Enter**. Edit `data/cards.json` and rebuild to change the sample questions.

To keep quizzes in working updates, ask Codex to show one when work starts and omit it from the final answer. The app controls whether those updates collapse when work finishes. The quiz cannot remove earlier copies, pin itself to the bottom, or detect task completion. Saved progress is best effort and may reset if the conversation reloads or the quiz is recreated.

## Structure

- `inline/quiz.html` — self-contained multiple-choice and flashcard interface.
- `inline/review.html` — one-card Anki review with real rating controls.
- `lib/anki-connect.mjs` — local AnkiConnect client; review writes require an explicit opt-in.
- `lib/anki-cards.mjs` — text extraction and bounded local media embedding.
- `lib/anki-review.mjs` — unlimited due/new selection, session checks, and recorded ratings.
- `scripts/build-anki.mjs` — live Anki-to-inline build.
- `scripts/review-anki.mjs` — start, resume, and save one Anki review.
- `scripts/anki.mjs` — deck listing and private raw snapshots.
- `scripts/build-inline.mjs` — validation and safe snapshot embedding.
- `data/cards.json` — public sample questions; imported decks stay in `dist/`.

Sample cards use `id`, `category`, `question`, `choices`, `answerIndex`, and `explanation`. Anki cards use `type: "flashcard"`, `id`, `category`, `question`, `answer`, and optional `media.question`/`media.answer` arrays of embedded image/audio objects.

## Verify

```sh
npm test
```

Tests cover the local API protocol and error handling, card selection, private snapshots, normalization, safe embedding, output guards, flashcard interactions, compact restored progress, and review-session idempotency. API tests use a temporary loopback server; they never grade cards in your Anki collection.
