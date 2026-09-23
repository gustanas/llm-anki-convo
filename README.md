# While

A small quiz for the time you spend waiting for Codex. Questions appear directly inside the conversation: answer a sample question, read its explanation, and move to the next card while Codex works. No accounts, dependencies, or model API calls are needed.

## Show the quiz

Ask Codex to **show the While quiz inline in this conversation**. In a Codex session with inline visualization support, the quiz contains an embedded snapshot of the sample cards and handles answer checking, explanations, and **Next** locally.

To keep the quiz in the working updates, ask Codex to show it when work starts and leave it out of the final answer. The app controls whether those updates collapse when work finishes; the quiz cannot remove earlier copies or pin itself to the bottom of the conversation.

To generate the HTML widget from the current cards, use Node.js 22 or newer:

```sh
npm run inline:build -- "$PWD/dist/while-quiz.html"
```

The generator accepts one absolute `.html` output path. Codex can render the resulting widget in the conversation. Edit `data/cards.json` and rebuild to create a new card snapshot; an existing widget keeps the cards it was built with.

Answer with the buttons or keys **1–4** while the quiz has focus. After answering, choose **Next question** or press **Enter**. Saved progress is best effort: it may reset if the conversation reloads or the quiz is recreated. The quiz does not receive a live task lifecycle feed, so it does not automatically detect when Codex starts or finishes a task.

## Structure and the future Anki connection

- `inline/quiz.html` — self-contained quiz widget template for the conversation.
- `scripts/build-inline.mjs` — validates cards and embeds a safe JSON snapshot into the inline widget.
- `data/cards.json` — eight sample cards. No Anki connection is active yet.
- `test/build-inline.test.mjs` — checks for card validation, safe embedding, and output paths.

Cards use `id`, `category`, `question`, `choices`, `answerIndex`, and `explanation`. They are embedded at build time. A future Anki adapter can provide this same card shape. Anki review scheduling and grade submission would need a separate write-back adapter; this prototype does not update Anki.

## Verify

```sh
npm test
```

Tests cover card validation, safe JSON embedding, generation from the bundled deck, and protecting the source template from accidental overwrites.
