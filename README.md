# While

A small quiz for the time you spend waiting for Codex. The preferred mode shows questions directly inside the conversation: answer a sample question, read its explanation, and move to the next card while Codex works. No accounts, dependencies, or model API calls are needed.

## Inline quiz (preferred)

Ask Codex to **show the While quiz inline in this conversation**. The widget contains an embedded snapshot of the sample cards and handles answer checking, explanations, and **Next** locally. Inline mode needs no server, browser tab, or Codex hooks.

To generate the HTML widget from the current cards, use Node.js 22 or newer:

```sh
npm run inline:build -- "$PWD/.runtime/while-quiz.html"
```

The generator accepts one absolute `.html` output path. Codex can render the resulting widget in the conversation. Edit `data/cards.json` and rebuild to create a new card snapshot; an existing widget keeps the cards it was built with.

Widget state is best effort: it may reset if the conversation reloads or the widget is recreated. Inline mode does not receive a live task lifecycle feed, so it does not automatically detect when Codex starts or finishes a task. The separate browser companion below provides that optional integration.

## Browser companion (alternative)

Requires Node.js 22 or newer.

```sh
npm start
```

Open <http://127.0.0.1:4319>. You can answer questions immediately, or choose **Try demo** to preview the activity indicator. Demo activity is labelled and never replaces a running Codex task.

Answer with the buttons or keys **1–4**. Press **Enter** to advance after answering. Progress is saved in this browser; restarting the deck clears the saved run. A task finishing never discards the question you are answering.

## Connect the browser companion to Codex

```sh
npm run hooks:install
```

This merges the companion's hooks into this project's `.codex/hooks.json` without replacing other hooks. Commands use absolute paths, so rerun the installer after moving this folder or changing your Node installation.

Open a new Codex task in this project (or restart/reload the project so it discovers the new configuration). **Review and trust these hooks when Codex prompts.** Codex requires trust for non-managed hooks; installing the file does not bypass that review. Once active, sending a prompt starts the local server if needed and updates the panel. Keep the panel open alongside your task; the hooks do not repeatedly open browser tabs.

Hooks used:

| Event | Panel behavior |
| --- | --- |
| `UserPromptSubmit` | Shows that Codex is working |
| `Stop` | Marks that turn complete |
| `Interrupt` | Marks that turn interrupted |
| `SessionEnd` | Clears remaining active turns from that session |

The first three run asynchronously. `SessionEnd` runs synchronously because Codex requires it, with a short bounded execution time. Failures are silent and do not block or steer Codex. Only the event name, session ID, and turn ID are forwarded; prompts, replies, and transcripts are discarded.

Multiple tasks are tracked separately. The panel stays in its working state until all active tasks finish. It tracks turn lifecycle events, not approvals or individual tool activity. If Codex crashes before emitting an end event, restart the local server to clear the in-memory activity state.

To use the companion across other projects, explicitly install it globally:

```sh
node scripts/install-hooks.mjs --global
```

Review the resulting global hooks in Codex before using them. A project-only install is the default. To uninstall, remove only handlers pointing to `scripts/codex-hook.mjs` from the hook file where you installed them. Keep unrelated entries.

Official reference: [Codex hooks](https://learn.chatgpt.com/docs/hooks).

## Structure and the future Anki connection

- `inline/quiz.html` — self-contained quiz widget template for the conversation.
- `scripts/build-inline.mjs` — validates cards and embeds a safe JSON snapshot into the inline widget.
- `public/` — browser interface, quiz interactions, and saved progress.
- `data/cards.json` — eight sample cards. No Anki connection is active yet.
- `lib/state.mjs` — activity tracking, including overlapping tasks and reordered hooks.
- `server.mjs` — local HTTP server and live server-sent events.
- `scripts/codex-hook.mjs` — small, fail-open hook client.
- `scripts/install-hooks.mjs` — repeatable hook installer.

Both modes use cards with `id`, `category`, `question`, `choices`, `answerIndex`, and `explanation`. Inline mode embeds them at build time; the browser server exposes them through `GET /api/cards` as `{ "cards": [...] }`. A future Anki adapter can provide this same card shape. Anki review scheduling and grade submission would need a separate write-back adapter; this prototype does not update Anki.

The server binds to `127.0.0.1` only. Hook requests use a generated token stored in `.runtime/server.json`; this directory is ignored by Git. Runtime activity is kept in memory. There is no outbound network request or telemetry.

Use `QUIZ_PORT` to select a different port if necessary. Set the same value for the server and hook process; the default is 4319. Stop a foreground server with **Ctrl+C**. If a hook started it in the background, its PID is recorded in `.runtime/server.json`.

## Verify

```sh
npm test
```

Tests cover overlapping tasks, reordered lifecycle events, demo isolation, authenticated local hook delivery, live updates, and safe hook installation.
