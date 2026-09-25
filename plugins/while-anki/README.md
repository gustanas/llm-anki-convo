# While Anki for Codex

While Anki shows your Anki reviews in a Codex desktop conversation while Codex works. Reveal an answer, choose **Again**, **Hard**, **Good**, or **Easy**, and the rating is recorded in Anki. The next card appears in the same widget without sending a chat message. When work finishes, Codex can hide the view without grading or abandoning a pending card.

## Install from GitHub

1. Install [Anki](https://apps.ankiweb.net/) and import a deck.
2. In Anki, open **Tools → Add-ons → Get Add-ons**, enter `2055492159` to install [AnkiConnect](https://ankiweb.net/shared/info/2055492159), then restart Anki. Keep Anki open while reviewing.
3. Use the Codex desktop app and install Node.js 22 or newer. The MCP server runs locally on the computer where Anki is open.
4. Add the GitHub marketplace and install the plugin:

   ```sh
   codex plugin marketplace add gustanas/llm-anki-convo
   codex plugin add while-anki@llm-anki-convo
   ```

5. Start a **new Codex task** and ask: “Show Anki while you work, then hide it.” Choose a deck in the widget; the last deck used is preselected next time if it is still available.

The repository and marketplace are named `llm-anki-convo`; the plugin's install ID is `while-anki`, matching its **While Anki** display name. The installation includes the built server and widget assets, so users do not need to clone the repository or run `npm ci` or `npm run build`. This GitHub marketplace is distinct from OpenAI’s universal public Plugins Directory. [Marketplace documentation](https://developers.openai.com/plugins/build/plugins)

If you installed the earlier `mcp-apps-probe@while-anki` version, remove that plugin and its old marketplace before running the new install commands:

```sh
codex plugin remove mcp-apps-probe@while-anki
codex plugin marketplace remove while-anki
```

Your saved deck and review sessions remain in the same local data directory.

## Review behavior

The widget includes every available **due and new** card in the chosen deck, even past its daily cap. Future, suspended, and buried cards are excluded. It loads one card at a time, so there is no fixed card-count limit. Anki supplies the interval labels and records each rating in its review history. **Rating a card changes its real Anki schedule.**

The widget uses app-only MCP tools to list decks, start or resume a review, and submit a rating. These calls do not create a new chat message. The server verifies the active session, card, nonce, and Anki review history before confirming a rating. If Anki is unavailable or a grade cannot be confirmed, the current card stays visible; reopen Anki and retry the same rating.

The model-visible `show_anki_review` tool opens the widget and returns a `viewId`. `hide_anki_review` hides that exact view before the final answer. Hiding clears the rendered card and asks the host to close the widget. It does not grade a card, end the review session, or discard a pending rating. Codex may retain the tool-result header, but the widget’s one-pixel minimum frame height lets the blank area collapse.

## Optional automatic showing

Installing the plugin does not make the widget appear on every prompt. You can set a one-time preference in your own `~/.codex/AGENTS.md`; see the [example in the repository README](../../README.md#show-anki-automatically). The repository’s `AGENTS.md` also has a development-only `off` / `work` / `always` switch. These are Codex instructions, not native plugin settings or a hook that renders before the model starts. Start a new task after changing instructions.

## Configuration and privacy

AnkiConnect uses `http://127.0.0.1:8765` by default. Set `ANKI_CONNECT_URL` if AnkiConnect listens at a different local address, or `ANKI_CONNECT_KEY` if you configured an API key. Only loopback HTTP endpoints are accepted. Set `WHILE_ANKI_DATA_DIR` to an absolute path to choose where the plugin stores its private data.

The MCP server connects to Anki locally and does not require a separate account or hosted service. Card text and supported local images and audio are displayed inside Codex. The last-deck preference, review session files, and grading receipts stay in a private local data directory (normally `~/Library/Application Support/While Anki/` on macOS, `%LOCALAPPDATA%\\While Anki\\` on Windows, or `~/.local/share/while-anki/` on Linux). A host-provided `PLUGIN_DATA` directory takes precedence over those defaults. Do not commit generated card files or session data; they can contain your deck text and media. The bundled widget assets contain no imported deck content.

## Develop and verify

From this plugin directory:

```sh
npm ci
npm run build
npm test
```

The tests use local fixtures and never rate cards in your Anki collection.
