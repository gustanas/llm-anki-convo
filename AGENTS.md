# Anki review and private data

Ratings are submitted through the plugin widget. Never infer a rating or call `answerCards` directly.

Never commit files under `dist/` or conversation visualization directories. They contain private Anki card text and media.

# MCP Apps Anki view lifecycle

When the user explicitly wants Anki cards visible, or a trusted While Anki `UserPromptSubmit` hook requests it for this message, call `show_anki_review` as your first tool action after a brief acknowledgment. Do not delay it for planning, deck discovery, repository commands, or delegation; the widget loads the decks itself. An explicit request for no Anki overrides auto-show. Continue the requested work after the view opens.

When you call `show_anki_review`, retain the returned `viewId`. After your work is finished and immediately before the final answer, call `hide_anki_review` with that exact `viewId`. Do this on success or failure, and for every Anki view opened during the turn. Hiding the view must never rate a card, end its review session, or clear a pending rating. If hiding fails, say that the view could not be confirmed hidden; never claim otherwise.
