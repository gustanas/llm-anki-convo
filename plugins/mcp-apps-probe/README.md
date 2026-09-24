# Quiet Anki reviews with MCP Apps

This branch tests Anki reviews inside a Codex conversation without sending a chat message for each rating. The MCP App widget calls an app-only MCP tool directly; the local server validates the active review and saves the selected rating through AnkiConnect. The same widget then shows the next card. A harmless counter probe remains available to test the quiet tool-call path without touching Anki.

## Set up locally

Install Anki and the [AnkiConnect add-on](https://ankiweb.net/shared/info/2055492159) (code `2055492159`), restart Anki, import a deck, and keep Anki open. AnkiConnect listens on loopback by default. If you configured a custom local URL or API key, set `ANKI_CONNECT_URL` or `ANKI_CONNECT_KEY` for the MCP server process.

From this directory:

```sh
npm ci
npm run build
npm test
```

From the repository root, install the branch-local plugin:

```sh
codex plugin marketplace add /Users/gustavo/dev/llm-anki-convo
codex plugin add mcp-apps-probe@personal
```

Start a new Codex task after installing or updating the plugin so its tool list refreshes. The experimental `.mcp.json` contains absolute paths to this checkout and its Node executable. Update them if the checkout moves or Node is installed elsewhere.

## Review cards inline

Ask Codex to **show an Anki review using the MCP App**. The `show_anki_review` tool opens the widget. Choose a deck in the widget, reveal the answer, then press **Again**, **Hard**, **Good**, or **Easy**. The widget calls `rate_anki_review` directly. Once Anki confirms the grade, the next card appears in the same widget without a new chat message. The widget also uses `list_anki_decks`, `start_anki_review`, and `resume_anki_review` to manage the session quietly.

The session considers every available **due and new** card, including cards beyond Anki's daily cap. It loads cards one at a time and has no fixed review-count limit. Future, suspended, and buried cards are excluded. Anki supplies the rating intervals and records the actual review. This is not a copy-only practice quiz: pressing a rating changes the card's Anki scheduling.

For an end-to-end test, use a deck with a due or new card. Reveal a card, press one rating, and check that the widget advances without posting a chat message. Then check that card's review history in Anki. If Anki is unavailable or the grade cannot be confirmed, the widget keeps the card instead of claiming it was saved; reopen Anki and retry the same rating. The server checks the session, card, nonce, and Anki review history so a repeated click or uncertain reply does not intentionally record a second grade.

Card text and supported local images/audio are displayed in the Codex widget. Session files and grading receipts stay under this repository's ignored `dist/review-sessions/`, and generated card output belongs in ignored `dist/` or a private conversation visualization directory. These files contain private deck content and must not be committed or published. The generic plugin UI bundle contains no deck data.

## Test the quiet-action bridge alone

Ask Codex: **Show the MCP Apps quiet-action probe.** The `show_probe` tool displays a counter widget. Click **Increment server count** once. The count should increase in that widget without a new chat message. This counter uses an in-memory `increment_probe` tool and never accesses Anki or changes cards. If the counter cannot call its server tool, the Anki rating UI cannot use this direct-call path in that host.
