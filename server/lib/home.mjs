// The Synapse home folder (SYNAPSE_HOME, default ~/.synapse) and the files in it.
//
//   <home>/synapse.config.json   people, owners, channels, server address (no secrets)
//   <home>/projects.json         the project registry (no secrets: it names the env vars that hold keys)
//   <home>/.env                  the keys, one KEY=VALUE per line (owner-only permissions)
//   <home>/data/                 state, the ask and files stores, logs
//   <home>/app/                  the installed copy of server/, client/, hooks/, dashboard/ (written by `synapse init`)
//
// The server, the CLI and the tests use this module. The MCP client and the hooks carry their own small copy of the
// home rule, because each must run on its own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4560;
export const DEFAULT_HOST = '127.0.0.1';

// SYNAPSE_HOME wins. Otherwise, a module installed at <home>/app/<part>/... finds its home two levels up, when that
// folder holds a synapse.config.json. Otherwise ~/.synapse.
export function resolveHome({ env = process.env, moduleDir = null } = {}) {
  if (env.SYNAPSE_HOME) return path.resolve(env.SYNAPSE_HOME);
  if (moduleDir) {
    const candidate = path.resolve(moduleDir, '..', '..');
    if (path.basename(path.resolve(moduleDir, '..')) === 'app' && fs.existsSync(path.join(candidate, 'synapse.config.json'))) return candidate;
  }
  return path.join(os.homedir(), '.synapse');
}

export function homePaths(home) {
  return {
    home,
    config: path.join(home, 'synapse.config.json'),
    projects: path.join(home, 'projects.json'),
    env: path.join(home, '.env'),
    data: path.join(home, 'data'),
    app: path.join(home, 'app'),
  };
}

// KEY=VALUE lines. Comments and blank lines are skipped; surrounding quotes are removed. Values are never logged.
export function parseEnvText(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.set(m[1], v);
  }
  return out;
}

// Fill only the variables that are still unset, so a real environment variable always wins. Returns the names loaded.
export function loadEnvFile(file, env = process.env) {
  if (!fs.existsSync(file)) return [];
  const loaded = [];
  for (const [k, v] of parseEnvText(fs.readFileSync(file, 'utf8'))) {
    if (env[k] === undefined) { env[k] = v; loaded.push(k); }
  }
  return loaded;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Write a file through a temp file and a rename, so a crash never leaves half a file behind. A failed write or rename
// removes its temp file.
export function writeFileAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}
