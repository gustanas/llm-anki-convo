#!/usr/bin/env node
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'];

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function buildHooksConfig(existing = {}, {
  hookPath = path.join(PROJECT_ROOT, 'scripts', 'codex-hook.mjs'),
  nodePath = process.execPath,
} = {}) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('hooks.json must contain an object.');
  const config = structuredClone(existing);
  if (config.hooks === undefined) config.hooks = {};
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('hooks must be an object.');
  const command = `${shellQuote(nodePath)} ${shellQuote(hookPath)}`;
  for (const event of EVENTS) {
    const groups = config.hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`${event} hooks must be an array.`);
    // Remove only our existing handler, keeping other handlers and matchers.
    const preserved = groups.flatMap((group) => {
      if (!group || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((hook) => !(
        hook?.type === 'command' && typeof hook.command === 'string' &&
        (hook.command.includes(shellQuote(hookPath)) || hook.command.includes(hookPath))
      ));
      if (hooks.length === group.hooks.length) return [group];
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    config.hooks[event] = [...preserved, {
      hooks: [{ type: 'command', command, async: event !== 'SessionEnd', timeout: 3 }],
    }];
  }
  return config;
}

export async function installHooks({ targetPath, dryRun = false, hookPath, nodePath } = {}) {
  const destination = targetPath ?? path.join(PROJECT_ROOT, '.codex', 'hooks.json');
  let existing = {};
  let oldText;
  try {
    oldText = await readFile(destination, 'utf8');
    existing = JSON.parse(oldText);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot safely read ${destination}: ${error.message}`);
  }
  const config = buildHooksConfig(existing, { hookPath, nodePath });
  const changed = JSON.stringify(existing) !== JSON.stringify(config);
  if (!dryRun && changed) {
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }
  return { path: destination, changed, config };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => !['--global', '--dry-run', '--help'].includes(arg))) {
    throw new Error('Usage: node scripts/install-hooks.mjs [--global] [--dry-run]');
  }
  if (args.has('--help')) {
    console.log('Usage: node scripts/install-hooks.mjs [--global] [--dry-run]\nDefault: this project’s .codex/hooks.json. --global explicitly selects $CODEX_HOME/hooks.json (or ~/.codex/hooks.json).');
    return;
  }
  const result = await installHooks({
    targetPath: args.has('--global') ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json') : undefined,
    dryRun: args.has('--dry-run'),
  });
  if (args.has('--dry-run')) console.log(JSON.stringify(result.config, null, 2));
  else {
    console.log(`${result.changed ? 'Installed' : 'Already installed'}: ${result.path}`);
    console.log('Review and trust these hooks in Codex when prompted. New or changed hooks may require a new Codex session.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
