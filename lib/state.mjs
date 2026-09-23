const EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd']);

function identifier(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

// Keep the activity model independent of both the UI and the future card provider.
export function createActivityStore(now = () => new Date().toISOString()) {
  const turns = new Map();
  let lastLive = { status: 'idle', updatedAt: null };
  let demo = null;

  function snapshot() {
    const activeCount = [...turns.values()].filter(turn => turn.status === 'working').length;
    if (activeCount) return { status: 'working', activeCount, source: 'live', updatedAt: lastLive.updatedAt };
    if (demo) return { ...demo, activeCount: 0, source: 'demo' };
    return { ...lastLive, activeCount: 0, source: lastLive.updatedAt ? 'live' : null };
  }

  function applyHook(event) {
    if (!event || !EVENTS.has(event.hook_event_name) || !identifier(event.session_id)) {
      throw new Error('Invalid hook event or session_id.');
    }
    const name = event.hook_event_name;
    if (name !== 'SessionEnd' && !identifier(event.turn_id)) throw new Error('A turn_id is required.');
    const session = event.session_id;
    if (name === 'SessionEnd') {
      let closed = false;
      for (const turn of turns.values()) {
        if (turn.session === session && turn.status === 'working') {
          turn.status = 'interrupted';
          closed = true;
        }
      }
      if (closed) { lastLive = { status: 'interrupted', updatedAt: now() }; demo = null; }
      return snapshot();
    }
    const key = JSON.stringify([session, event.turn_id]);
    const previous = turns.get(key);
    // Async hooks can arrive out of order. A late start cannot revive a finished turn.
    if (previous && previous.status !== 'working') return snapshot();
    if (name === 'UserPromptSubmit' && previous) return snapshot();
    const status = name === 'UserPromptSubmit' ? 'working' : name === 'Stop' ? 'complete' : 'interrupted';
    turns.set(key, { session, status });
    lastLive = { status, updatedAt: now() };
    demo = null;
    // Retain terminal tombstones to handle delayed start events, with bounded memory.
    if (turns.size > 512) {
      for (const [id, turn] of turns) {
        if (turn.status !== 'working') turns.delete(id);
        if (turns.size <= 512) break;
      }
    }
    return snapshot();
  }

  function applyDemo(action) {
    if (!['start', 'finish', 'reset'].includes(action)) throw new Error('Unknown demo action.');
    if (action !== 'reset' && snapshot().activeCount > 0) {
      throw new Error('Codex is working. Try the demo after the task finishes.');
    }
    if (action === 'reset') demo = null;
    else if (action === 'start') demo = { status: 'working', updatedAt: now() };
    else {
      if (demo?.status !== 'working') throw new Error('Start a demo first.');
      demo = { status: 'complete', updatedAt: now() };
    }
    return snapshot();
  }

  return { snapshot, applyHook, applyDemo };
}
