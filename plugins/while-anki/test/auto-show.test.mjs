import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  readAutoShowMode,
  resolveAutoShowSettingsPath,
  writeAutoShowMode,
} from '../auto-show-settings.mjs';

const hookScript = fileURLToPath(new URL('../hooks/user-prompt-submit.mjs', import.meta.url));

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'while-anki-auto-show-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runHook(directory, prompt, input = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], {
      env: { ...process.env, WHILE_ANKI_DATA_DIR: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Hook exited ${code}: ${stderr}`));
      else resolve(stdout ? JSON.parse(stdout) : null);
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, ...input }));
  });
}

test('settings paths are stable across platforms and independent of PLUGIN_DATA', () => {
  assert.equal(resolveAutoShowSettingsPath({
    env: { PLUGIN_DATA: '/somewhere/else' }, platform: 'darwin', home: '/Users/test',
  }), '/Users/test/Library/Application Support/While Anki/auto-show.json');
  assert.equal(resolveAutoShowSettingsPath({
    env: { XDG_DATA_HOME: '/xdg', PLUGIN_DATA: '/other' }, platform: 'linux', home: '/home/test',
  }), '/xdg/while-anki/auto-show.json');
  assert.equal(resolveAutoShowSettingsPath({
    env: {}, platform: 'linux', home: '/home/test',
  }), '/home/test/.local/share/while-anki/auto-show.json');
  assert.equal(resolveAutoShowSettingsPath({
    env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local', PLUGIN_DATA: 'D:\\plugin-data' },
    platform: 'win32', home: 'C:\\Users\\Test',
  }), 'C:\\Users\\Test\\AppData\\Local\\While Anki\\auto-show.json');
  assert.equal(resolveAutoShowSettingsPath({
    env: { WHILE_ANKI_DATA_DIR: '/custom/anki', PLUGIN_DATA: '/other' },
    platform: 'darwin', home: '/Users/test',
  }), '/custom/anki/auto-show.json');
  assert.throws(() => resolveAutoShowSettingsPath({
    env: { WHILE_ANKI_DATA_DIR: 'relative/data' }, platform: 'darwin', home: '/Users/test',
  }), /absolute path/);
});

test('settings default off, persist valid modes privately, and tolerate corrupt data', async () => {
  await withTempDir(async (directory) => {
    const settingsPath = resolveAutoShowSettingsPath({ env: { WHILE_ANKI_DATA_DIR: directory } });
    assert.equal(await readAutoShowMode(settingsPath), 'off');
    for (const mode of ['long_tasks', 'every_message', 'off']) {
      assert.equal(await writeAutoShowMode(settingsPath, mode), mode);
      assert.equal(await readAutoShowMode(settingsPath), mode);
      assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { version: 1, mode });
    }
    if (process.platform !== 'win32') assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    await assert.rejects(writeAutoShowMode(settingsPath, 'invalid'), /Invalid auto-show mode/);
    assert.equal(await readAutoShowMode(settingsPath), 'off');
    await writeFile(settingsPath, '{bad json');
    assert.equal(await readAutoShowMode(settingsPath), 'off');
    await writeFile(settingsPath, JSON.stringify({ version: 1, mode: 'future_mode' }));
    assert.equal(await readAutoShowMode(settingsPath), 'off');
  });
});

test('prompt hook honors off, long tasks, and every message without echoing prompts', async () => {
  await withTempDir(async (directory) => {
    const settingsPath = path.join(directory, 'auto-show.json');
    assert.equal(await runHook(directory, 'Please fix a bug'), null);
    await writeAutoShowMode(settingsPath, 'long_tasks');
    const longTasks = await runHook(directory, 'Please fix a bug with secret-abc');
    assert.equal(longTasks.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(longTasks.hookSpecificOutput.additionalContext, /multiple steps/);
    assert.match(longTasks.hookSpecificOutput.additionalContext, /hide_anki_review/);
    assert.doesNotMatch(longTasks.hookSpecificOutput.additionalContext, /secret-abc/);
    await writeAutoShowMode(settingsPath, 'every_message');
    const everyMessage = await runHook(directory, 'What time is it?');
    assert.match(everyMessage.hookSpecificOutput.additionalContext, /including quick questions/);
  });
});

test('prompt hook suppresses explicit no-Anki requests and legacy ratings', async () => {
  await withTempDir(async (directory) => {
    await writeAutoShowMode(path.join(directory, 'auto-show.json'), 'every_message');
    for (const prompt of [
      'No Anki for this one, please.',
      'Please do not show Anki while you work.',
      'Fix this bug without Anki.',
      'Skip Anki this time.',
      "I don't want Anki here.",
      'While Anki rating v1: session=foo card=1 nonce=bar ease=3',
    ]) {
      assert.equal(await runHook(directory, prompt), null, prompt);
    }
    assert.equal(await runHook(directory, 'Hi', { hook_event_name: 'SessionStart' }), null);
  });
});
