import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAutoShowSettingsPath } from './auto-show-settings.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ID_LENGTH = 256;
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOSED_TURN_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function resolveViewLifecycleDir(settingsPath = resolveAutoShowSettingsPath()) {
  return path.join(path.dirname(settingsPath), 'view-lifecycle');
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function turnKey(sessionId, turnId) {
  if (!validId(sessionId) || !validId(turnId)) return null;
  return createHash('sha256').update(JSON.stringify([sessionId, turnId])).digest('hex');
}

function validViewId(viewId) {
  return typeof viewId === 'string' && UUID_V4.test(viewId);
}

async function createMarker(filename) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    await writeFile(filename, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

/** Associate only a successful show_anki_review result with its Codex turn. */
export async function recordShownView(directory, { sessionId, turnId, viewId }) {
  const key = turnKey(sessionId, turnId);
  if (!key || !validViewId(viewId)) return false;
  const viewPath = path.join(directory, 'turns', key, viewId);
  await createMarker(viewPath);
  // Turn completion or interruption can race an in-flight tool call. The
  // tombstone is written before scanning, so either that scan sees this entry
  // or this check hides the late result.
  if (await isTurnClosed(directory, key)) {
    await markViewHidden(directory, viewId);
    await rm(viewPath, { force: true });
  }
  return true;
}

async function isTurnClosed(directory, key) {
  try {
    await stat(path.join(directory, 'closed', key));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Request hiding only the views observed in this exact session and turn. */
export async function markTurnViewsHidden(directory, { sessionId, turnId }) {
  const key = turnKey(sessionId, turnId);
  if (!key) return 0;
  await createMarker(path.join(directory, 'closed', key));
  const turnDirectory = path.join(directory, 'turns', key);
  let entries;
  try {
    entries = await readdir(turnDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let hidden = 0;
  for (const viewId of entries) {
    if (!validViewId(viewId)) continue;
    await markViewHidden(directory, viewId);
    hidden++;
  }
  await rm(turnDirectory, { recursive: true, force: true });
  return hidden;
}

/** A valid marker also lets a widget close after its MCP server restarted. */
export async function isViewMarkedHidden(directory, viewId) {
  if (!validViewId(viewId)) return false;
  try {
    await stat(path.join(directory, 'hidden', viewId));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Drop an old marker if an identifier is ever generated again. */
export async function markViewHidden(directory, viewId) {
  if (!validViewId(viewId)) return false;
  await createMarker(path.join(directory, 'hidden', viewId));
  return true;
}

/** Keep the fallback's small marker store bounded without touching review data. */
export async function pruneViewLifecycleFiles(directory, now = Date.now()) {
  const stampPath = path.join(directory, 'last-prune.json');
  try {
    const last = JSON.parse(await readFile(stampPath, 'utf8'));
    if (Number.isFinite(last?.at) && now - last.at < CLEANUP_INTERVAL_MS) return;
  } catch { /* A missing or corrupt stamp simply triggers a sweep. */ }

  for (const subdirectory of ['hidden', 'turns', 'closed']) {
    const root = path.join(directory, subdirectory);
    let entries;
    try { entries = await readdir(root); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of entries) {
      const filename = path.join(root, name);
      try {
        const info = await stat(filename);
        const ttl = subdirectory === 'closed' ? CLOSED_TURN_TTL_MS : MARKER_TTL_MS;
        if (now - info.mtimeMs > ttl) await rm(filename, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(stampPath, JSON.stringify({ at: now }), { mode: 0o600 });
}
