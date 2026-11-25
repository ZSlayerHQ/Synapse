// Regression for audit run-2 finding 3: synapse doctor never prints a project file's control characters raw. ESC (every
// ANSI sequence), BEL, CR, other C0, DEL, C1 and line separators in .synapse/config.json and .mcp.json values come out
// as visible \uXXXX escapes. The home is a minimal fake installation; no bus is started (doctor notes it is down).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'synapse.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NASTY = '\u001b]0;pwned\u0007\u001b[2J\r\u0085\u009b31m\u2028FAKE ok line\u007f';

test('doctor escapes control characters in every value it prints from project files', () => {
  const home = tmp('synapse-esc-home-');
  const proj = tmp('synapse-esc-proj-');
  try {
    fs.writeFileSync(path.join(home, '.synapse-home'), '');
    fs.writeFileSync(path.join(home, 'synapse.config.json'), JSON.stringify({ version: 2, server: { host: '127.0.0.1', port: 4778 }, people: { owner1: {} }, owners: ['owner1'] }));
    fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { alpha: { keyEnv: 'SYNAPSE_KEY_ALPHA', root: proj.replace(/\\/g, '/'), assertableBots: ['alphabot'] } } }));
    fs.writeFileSync(path.join(home, '.env'), `SYNAPSE_KEY_ALPHA=${'k'.repeat(32)}\n`, { mode: 0o600 });
    fs.mkdirSync(path.join(proj, '.synapse'));
    fs.writeFileSync(path.join(proj, '.synapse', 'config.json'), JSON.stringify({ project: 'alpha', developer: `alphabot${NASTY}`, keyEnv: `K${NASTY}` }));
    fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { synapse: { type: `stdio${NASTY}`, command: `node${NASTY}`, args: [], [`x${NASTY}`]: 1 } } }));
    const r = spawnSync(process.execPath, [CLI, 'doctor', '--home', home, '--project', proj], { encoding: 'utf8', timeout: 60000, env: { ...process.env, SYNAPSE_HOME: home } });
    const out = r.stdout + r.stderr;
    assert.match(out, /alphabot/, 'the project values were printed');
    assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/, 'no raw control character (newline aside) reaches the terminal');
    assert.match(out, /\\u001b/, 'ESC shows as a visible escape');
    assert.doesNotMatch(out, /^\s*FAKE ok line/m, 'a separator cannot start a forged status line');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true }); }
});
