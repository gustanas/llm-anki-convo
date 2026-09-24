# MCP Apps quiet-action probe

This branch tests whether Codex desktop can render an MCP Apps widget whose button calls an MCP tool without posting a chat message. It never connects to Anki or changes cards.

The `show_probe` tool returns an MCP Apps UI resource (`text/html;profile=mcp-app`). Its button calls the app-only `increment_probe` tool. Both tools share a harmless in-memory counter in one server process.

## Local setup

From this directory:

```sh
npm ci
npm run build
npm test
```

From the repository root, add and install the branch-local plugin:

```sh
codex plugin marketplace add /Users/gustavo/dev/llm-anki-convo
codex plugin add mcp-apps-probe@personal
```

The experimental `.mcp.json` points to this checkout's absolute path and local Node executable. Update those paths if the checkout moves. Restart Codex so it discovers the installed server.

## In-app test

Ask Codex: **Show the MCP Apps quiet-action probe.**

1. If only text appears, Codex exposed the tool but did not render its MCP Apps UI.
2. If the widget appears, click **Increment server count** once.
3. Pass: the count changes from 0 to 1 in the same widget without a new chat message.
4. If it reports that server tool calls are unavailable or fails, this host does not provide the needed quiet-action bridge.

A passing probe demonstrates the host path. A later Anki version would replace the counter tool with the existing validated, idempotent review command and return the next card. The probe does not claim Anki grading works until that separate integration is built and tested.
