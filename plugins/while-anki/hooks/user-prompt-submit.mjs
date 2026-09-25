import { resolveAutoShowSettingsPath, readAutoShowMode } from '../auto-show-settings.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const CONTEXT = Object.freeze({
  long_tasks: 'While Anki auto-show is set to Long tasks. For coding, debugging, research, file changes, testing, follow-up instructions to do such work, or any request expected to take multiple steps, call show_anki_review as your first tool action after a brief acknowledgment, before planning, browsing, commands, or delegation. Skip it for quick questions and status checks. Keep the returned viewId and call hide_anki_review with that exact viewId after the work and immediately before your final answer. Hiding must not rate a card or end its review session. An explicit request for no Anki overrides this setting.',
  every_message: 'While Anki auto-show is set to Every message. Call show_anki_review as your first tool action after a brief acknowledgment for this turn, including quick questions and before any other tool. Keep the returned viewId and call hide_anki_review with that exact viewId after the work and immediately before your final answer. Hiding must not rate a card or end its review session. An explicit request for no Anki overrides this setting.',
});

function suppressForPrompt(prompt) {
  if (prompt.startsWith('While Anki rating v1:')) return true;
  return /\b(?:no\s+(?:anki|flashcards?)|without\s+(?:anki|flashcards?)|(?:don['’]?t|do\s+not|never)\s+(?:show|open|display|use)\s+(?:any\s+|the\s+)?(?:anki|flashcards?)|(?:don['’]?t|do\s+not)\s+want\s+(?:to\s+see\s+)?(?:any\s+|the\s+)?anki|(?:skip|hide|disable|turn\s+off)\s+(?:the\s+)?anki)\b/i.test(prompt);
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const input = await readStdin();
  if (input?.hook_event_name !== 'UserPromptSubmit' || typeof input.prompt !== 'string') return;
  if (suppressForPrompt(input.prompt)) return;

  const mode = await readAutoShowMode(resolveAutoShowSettingsPath());
  if (mode === 'off') return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: CONTEXT[mode],
    },
  }));
}

await main().catch(() => {
  // A missing or unreadable preference must never block a user message.
});
