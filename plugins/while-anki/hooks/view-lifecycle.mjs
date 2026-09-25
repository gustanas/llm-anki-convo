import { resolveViewLifecycleDir, recordShownView, markTurnViewsHidden, pruneViewLifecycleFiles } from '../view-lifecycle.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

function shownViewId(input) {
  if (!/(?:^|__)show_anki_review$/.test(input.tool_name ?? '')) return null;
  if (input.tool_response?.isError === true) return null;
  if (input.tool_response?.structuredContent?.status !== 'ready') return null;
  return input.tool_response?.structuredContent?.viewId ?? null;
}

async function main() {
  const input = await readInput();
  if (!input || typeof input !== 'object') return;
  try {
    const directory = resolveViewLifecycleDir();
    if (input.hook_event_name === 'PostToolUse') {
      const viewId = shownViewId(input);
      if (viewId && await recordShownView(directory, {
        sessionId: input.session_id, turnId: input.turn_id, viewId,
      })) {
        await pruneViewLifecycleFiles(directory);
      }
      return;
    }
    if (input.hook_event_name === 'Stop' || input.hook_event_name === 'Interrupt') {
      await markTurnViewsHidden(directory, {
        sessionId: input.session_id,
        turnId: input.turn_id,
      });
      await pruneViewLifecycleFiles(directory);
    }
  } catch {
    // Lifecycle cleanup is best effort; it must never block a user turn or grade a card.
  } finally {
    // Stop hooks require JSON output even when marker storage is unavailable.
    if (input.hook_event_name === 'Stop') process.stdout.write('{}');
  }
}

await main().catch(() => {});
