import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MODES = new Set(['off', 'long_tasks', 'every_message']);

// PLUGIN_DATA is deliberately not used here: Codex passes it to hooks, but
// may not pass the same value to the MCP server that serves the settings UI.
export function resolveAutoShowSettingsPath({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const override = env.WHILE_ANKI_DATA_DIR;
  if (override !== undefined) {
    if (typeof override !== 'string' || !paths.isAbsolute(override)) {
      throw new Error('WHILE_ANKI_DATA_DIR must be an absolute path.');
    }
    return paths.join(paths.resolve(override), 'auto-show.json');
  }

  if (platform === 'darwin') {
    return paths.join(home, 'Library', 'Application Support', 'While Anki', 'auto-show.json');
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && paths.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : env.APPDATA && paths.isAbsolute(env.APPDATA)
        ? env.APPDATA
        : paths.join(home, 'AppData', 'Local');
    return paths.join(base, 'While Anki', 'auto-show.json');
  }
  const base = env.XDG_DATA_HOME && paths.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : paths.join(home, '.local', 'share');
  return paths.join(base, 'while-anki', 'auto-show.json');
}

export async function readAutoShowMode(settingsPath) {
  try {
    const value = JSON.parse(await readFile(settingsPath, 'utf8'));
    return value?.version === 1 && MODES.has(value.mode) ? value.mode : 'off';
  } catch {
    return 'off';
  }
}

export async function writeAutoShowMode(settingsPath, mode) {
  if (!MODES.has(mode)) throw new Error('Invalid auto-show mode.');
  await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify({ version: 1, mode }), {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    await rename(temporaryPath, settingsPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return mode;
}
