# While Anki

Review Anki cards inside a Codex desktop conversation while Codex works. Reveal the answer and choose **Again**, **Hard**, **Good**, or **Easy**; the rating is saved in Anki and the next card appears without posting a chat message. Ask Codex to hide the card view when it finishes.

## Install the Codex plugin

1. Install [Anki](https://apps.ankiweb.net/), import a deck, and install [AnkiConnect](https://ankiweb.net/shared/info/2055492159) from **Tools → Add-ons → Get Add-ons** using code `2055492159`. Restart Anki and leave it open while reviewing.
2. Use the Codex desktop app and install [Node.js 22 or newer](https://nodejs.org/) on the same computer as Anki. The plugin does not require cloning this repository, running `npm ci`, or building JavaScript.
3. Add the GitHub marketplace and install the plugin:

   ```sh
   codex plugin marketplace add gustanas/llm-anki-convo
   codex plugin add while-anki@llm-anki-convo
   ```

4. Start a **new Codex task** and ask: “Show Anki while you work, then hide it.” Choose a deck in the inline widget. The last deck you used is selected next time when it is still available. Use the **Auto-show** control in the widget to choose when Anki should appear on future messages.

The GitHub repository and marketplace are both named `llm-anki-convo`; the plugin's install ID is `while-anki`, matching its **While Anki** display name. This marketplace is separate from OpenAI’s universal public Plugins Directory. [Codex marketplace documentation](https://developers.openai.com/plugins/build/plugins)

If you installed the earlier `mcp-apps-probe@while-anki` version, remove that plugin and its old marketplace before running the new install commands:

```sh
codex plugin remove mcp-apps-probe@while-anki
codex plugin marketplace remove while-anki
```

Your saved deck and review sessions remain in the same local data directory.

The widget can review all available **due and new** cards, including those beyond Anki’s daily cap. Future, suspended, and buried cards are excluded. Ratings change your real Anki schedule. If a rating response is lost, **Check Again** verifies the card without sending a possible duplicate; an unresolved card should be reviewed in Anki. Missing or unsupported media is flagged beside the card.

### Show Anki automatically

Open Anki once, then choose **Auto-show** in the widget:

- **Off** (default): show Anki only when you ask.
- **Long tasks**: also show it for work likely to take multiple steps, such as coding, research, or file changes. Skip quick questions and status checks.
- **Every message**: show it for ordinary messages too, including quick questions.

The preference is saved locally and applies across future Codex tasks on the same computer. An explicit “no Anki” request overrides it. Codex hides each opened view when its response is finished without grading or abandoning the current card.

Auto-show uses a bundled `UserPromptSubmit` hook. `PostToolUse`, `Stop`, and `Interrupt` hooks track the view opened for the current turn and request its closure if Codex misses the normal hide call. They never grade cards. Codex requires you to review and trust new or changed plugin hooks before they run; use `/hooks` if prompted. The prompt hook does not draw the widget itself, so the widget appears at Codex’s first tool call after processing begins. [Codex hook documentation](https://developers.openai.com/codex/hooks)

### Data and permissions

The local MCP server talks to AnkiConnect on loopback. Card text and supported media are shown inside Codex; the last-deck preference, review session data, and rating receipts are stored locally. The plugin does not need an account or a hosted service. Keep generated card files and session data out of Git. You can set `ANKI_CONNECT_URL` for a different local address or `ANKI_CONNECT_KEY` if your AnkiConnect setup uses an API key; only loopback HTTP endpoints are accepted.

See the [plugin guide](plugins/while-anki/README.md) for development and troubleshooting.

## Development

The plugin lives in `plugins/while-anki/`. Shared AnkiConnect and card/media parsing code lives in `lib/`, with tests in `test/`.

From the repository root:

```sh
npm ci --prefix plugins/while-anki
npm run build
npm test
```

The build regenerates the bundled server and widget assets shipped with the plugin. Tests cover the shared libraries and plugin using local fixtures; they do not grade cards in your Anki collection.
