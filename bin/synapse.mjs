#!/usr/bin/env node
// synapse: install and wire the Synapse bus on Windows, macOS or Linux. Node only; no PowerShell, no shell scripts.
//
//   synapse init [--owner <name>] [--port <n>]       create the Synapse home, install (or upgrade) the app in it
//   synapse set-human-key <name> [--role <r>]        set a person's personal key (they run it: the key is read without echo)
//   synapse add-project <dir> [--id <id>] [--bot <name>] [--shared] [--no-mcp]
//   synapse start [--background] | stop | restart     run the bus
//   synapse doctor [--project <dir>] [--ready]        check every surface this CLI wrote; --ready also fails on a down bus
//   synapse uninstall [--yes] [--keep-home]           remove what this CLI wrote, and nothing else
//   synapse unlock                                   clear an install lock whose process is no longer running
//   synapse discord setup [--person <name>=<user id>]... [--channel <project>/<channel>=<channel id>]... [--cards <project>=<channel>] [--new-token]
//                                                    turn the optional Discord pack on (the token is read without echo)
//   synapse discord disable                          turn it off again (the mappings and the token are kept)
//
// Global: --home <dir> (or SYNAPSE_HOME; default ~/.synapse).
//
// <home>/install-manifest.json records every file, MCP server entry and hook entry this CLI wrote, each with a sha256 of
// exactly what it wrote. Uninstall removes only what still matches; anything edited or unknown is kept and named.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, execSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveHome, homePaths, parseEnvText, readJson, writeFileAtomic, DEFAULT_PORT, DEFAULT_HOST } from '../server/lib/home.mjs';
import { loadHomeConfig, checkConfig, checkRegistry, checkDiscord, discordTokenProblem, withDefaults, PROJECT_RE, BOT_RE, DEFAULT_CHANNELS, DEFAULT_DISCORD_TOKEN_ENV } from '../server/lib/config.mjs';
import { hashHumanKey, humanKeyProblem, NAME_RE, ROLES } from '../server/lib/people.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(__dirname, '..');
const MCP_NAME = 'synapse';
const APP_PARTS = ['server', 'client', 'hooks', 'shared', 'dashboard', 'schema', 'bin', 'node_modules'];
const APP_FILES = ['AGENTS.md', 'package.json', 'package-lock.json', 'LICENSE', 'synapse.config.example.json'];
// Files the running bus writes in the home. Their content changes all the time, so they are listed by exact name, not hash.
const RUNTIME_FILES = ['state.json', 'ask.db', 'ask.db-wal', 'ask.db-shm', 'files.db', 'files.db-wal', 'files.db-shm', 'digest-state.json', 'bus.log', 'bus-owner.json'].map((f) => `data/${f}`);
const MANIFEST_VERSION = 3;
const HOOKS = [
  { event: 'SessionStart', matcher: null, script: 'session-checkin.cjs', timeout: 10 },
  { event: 'SessionEnd', matcher: null, script: 'session-checkout.cjs', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit', script: 'pre-edit-check.cjs', timeout: 5 },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|Bash', script: 'post-sync.cjs', timeout: 5 },
];
const IS_WIN = process.platform === 'win32';
// A step check that does nothing here. Only code running in this process can replace it (the test harness
// scripts/cli-fault-harness.mjs sets globalThis.__synapseCliOps before importing this file); no environment variable can.
const fault = (globalThis.__synapseCliOps && globalThis.__synapseCliOps.check) || (() => {});

// ─── Arguments ───
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out.flags[k] = a.slice(eq + 1);
      else if (['yes', 'keep-home', 'background', 'ready', 'stdin', 'shared', 'no-mcp', 'new-token'].includes(k)) out.flags[k] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.flags.home) process.env.SYNAPSE_HOME = path.resolve(String(args.flags.home));
const HOME = resolveHome({ env: process.env });
const P = homePaths(HOME);
const MANIFEST = path.join(HOME, 'install-manifest.json');
const MARKER = path.join(HOME, '.synapse-home');
const LOCK_FILE = path.join(HOME, '.install.lock');
const OWNER_FILE = path.join(P.data, 'bus-owner.json');
const fwd = (p) => p.replace(/\\/g, '/');
const samePath = (a, b) => (IS_WIN || process.platform === 'darwin' ? fwd(path.resolve(a)).toLowerCase() === fwd(path.resolve(b)).toLowerCase() : path.resolve(a) === path.resolve(b));
const inside = (child, parent) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const jsonText = (o) => JSON.stringify(o, null, 2) + '\n';
const fileKey = (file) => fwd(path.resolve(file));
const few = (l) => `${l.slice(0, 5).join(', ')}${l.length > 5 ? `, and ${l.length - 5} more` : ''}`;

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const note = (m) => console.log(`  note  ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
function die(msg, code = 1) { console.error(`synapse: ${msg}`); process.exit(code); }

// ─── Key file protection ───
// POSIX: chmod 600 (and 700 on the home). Windows: Node cannot set an ACL, so the file inherits its folder's ACL; under
// the user profile that is the current user, SYSTEM and Administrators by default. Say so plainly.
function protectFile(file) {
  if (IS_WIN) return { ok: null, message: `${file} inherits its folder's Windows ACL (by default under your user profile: you, SYSTEM and Administrators). Node cannot narrow it further; keep the Synapse home inside your user profile.` };
  fs.chmodSync(file, 0o600);
  return { ok: true, message: `${file} is mode 600` };
}
function checkFileProtection(file) {
  if (IS_WIN) return { ok: null, message: 'Windows: key-file permissions are not checked (see the note from "synapse init")' };
  const mode = fs.statSync(file).mode & 0o777;
  return mode & 0o077 ? { ok: false, message: `${file} is mode ${mode.toString(8)}; run: chmod 600 "${file}"` } : { ok: true, message: `${file} is mode ${mode.toString(8)}` };
}

// ─── Fingerprints: exactly what this CLI wrote ───
const digest = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;
const entryHash = (obj) => digest(Buffer.from(JSON.stringify(obj)));
function fingerprint(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
    return st.isFile() ? digest(fs.readFileSync(file)) : null;
  } catch { return null; }
}
// Every file and symlink below root/base, as a relative slash path -> fingerprint.
function walkFiles(root, out = {}, base = '') {
  for (const e of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(root, out, rel);
    else out[rel] = fingerprint(path.join(root, rel));
  }
  return out;
}
const sameFiles = (a, b) => { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]); };
// Remove the folders that hold listed files, deepest first, each only when empty; then root, when empty.
function pruneListedDirs(root, rels) {
  const dirs = new Set();
  for (const rel of rels) for (let d = path.posix.dirname(rel); d && d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
  for (const d of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)) { try { fs.rmdirSync(path.join(root, d)); } catch {} }
  try { fs.rmdirSync(root); } catch {}
}
// Remove each listed file that still matches; returns how many matched.
function removeMatching(root, files) {
  fault('cleanup');
  let n = 0;
  for (const [rel, fp] of Object.entries(files)) { const p = path.join(root, rel); if (fingerprint(p) === fp) { fs.rmSync(p); n++; } }
  return n;
}
const rmdirIfEmpty = (d) => { try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch {} };

// ─── One installer at a time ───
// Taking the lock is one exclusive create. Nothing ever takes over a lock: a lock whose process is gone is reported,
// and "synapse unlock" clears it after checking that process is dead. Only the process whose token is in it removes it.
function readLock() { try { const h = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); return Number.isInteger(h.pid) ? h : null; } catch { return null; } }
function withInstallLock(fn) {
  const createdHome = !fs.existsSync(HOME);
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
  let fd;
  try { fd = fs.openSync(LOCK_FILE, 'wx'); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const held = readLock();
    if (held && alive(held.pid)) die(`another synapse command (pid ${held.pid}) is changing this installation; wait for it to finish`);
    die(`${LOCK_FILE} is ${held ? `left by pid ${held.pid}, which is no longer running` : 'unreadable (being written, or damaged)'}. If no synapse command is running, clear it with: synapse unlock`);
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
  fs.closeSync(fd);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const h = readLock();
    if (h && h.token === token) fs.rmSync(LOCK_FILE, { force: true });
    if (createdHome) rmdirIfEmpty(HOME); // a first command that stopped in its preflight leaves no folder behind
  };
  process.on('exit', release);
  return Promise.resolve().then(fn).finally(release);
}
async function cmdUnlock() {
  if (!fs.existsSync(LOCK_FILE)) { console.log('synapse: there is no install lock'); return; }
  // One unlock at a time: while the stale lock exists no installer can take it, so only a second unlock could race.
  const guard = `${LOCK_FILE}.unlocking`;
  try { fs.closeSync(fs.openSync(guard, 'wx')); } catch (e) {
    if (e.code === 'EEXIST') die(`another "synapse unlock" is running (or one stopped half way: if none is running, delete ${guard} yourself)`);
    throw e;
  }
  process.on('exit', () => { try { fs.rmSync(guard, { force: true }); } catch {} });
  const text = fs.readFileSync(LOCK_FILE, 'utf8');
  const held = readLock();
  if (held && alive(held.pid)) die(`pid ${held.pid} holds the install lock and is still running; not removing it (if that pid is some other program, remove ${LOCK_FILE} yourself)`);
  if (!held && Date.now() - fs.statSync(LOCK_FILE).mtimeMs < 30_000) die('the lock was created moments ago and names no process yet; wait a little, then run unlock again');
  if (fs.readFileSync(LOCK_FILE, 'utf8') !== text) die('the lock changed while it was being checked; run unlock again');
  fs.rmSync(LOCK_FILE);
  console.log(`synapse: removed the install lock${held ? ` left by pid ${held.pid}` : ''}`);
}

// ─── Several files as one change ───
// Each write is { file, text, mode? }. On a failure every file already written gets its old content back (or is removed,
// with a folder this created). When a file cannot be put back, the message names it: never "nothing was changed".
function applyWrites(writes) {
  const done = [];
  try {
    writes.forEach((w, i) => {
      const before = fs.existsSync(w.file) ? fs.readFileSync(w.file) : null;
      const dirExisted = fs.existsSync(path.dirname(w.file));
      fault(`write-${i + 1}`);
      writeFileAtomic(w.file, w.text, w.mode);
      done.push({ ...w, before, dirExisted });
    });
  } catch (e) {
    const stuck = [];
    for (const d of done.reverse()) {
      try {
        fault('restore');
        if (d.before !== null) writeFileAtomic(d.file, d.before, d.mode); else fs.rmSync(d.file, { force: true });
      } catch { stuck.push(d.file); continue; }
      if (d.before === null && !d.dirExisted) rmdirIfEmpty(path.dirname(d.file));
    }
    const why = `writing ${e.path || 'a file'} failed (${e.code || e.message})`;
    if (stuck.length) die(`${why}, and ${stuck.length} file(s) could not be put back; they hold this command's new content: ${stuck.join(', ')}. Fix the cause, then run the command again.`);
    die(`${why}; every file this command had written was put back, so nothing was changed`);
  }
}

// ─── The install manifest ───
function newManifest() {
  return { kind: 'synapse-install-manifest', version: MANIFEST_VERSION, home: fwd(HOME), createdAt: new Date().toISOString(), files: {}, app: null, runtime: RUNTIME_FILES, projects: {} };
}
// The manifest of this home, or a stop: a command never guesses what it owns.
function readManifest() {
  if (!fs.existsSync(MANIFEST)) die(`${MANIFEST} is missing, so this CLI cannot tell what it installed; nothing was changed`);
  let m;
  try { m = readJson(MANIFEST); } catch { die(`${MANIFEST} is not valid JSON; nothing was changed`); }
  if (!m || m.kind !== 'synapse-install-manifest') die(`${MANIFEST} is not a Synapse install manifest; nothing was changed`);
  if (m.version !== MANIFEST_VERSION) die(`${MANIFEST} is version ${m.version}; this synapse reads version ${MANIFEST_VERSION}. Use the synapse that installed it; nothing was changed`);
  if (!samePath(m.home, HOME)) die(`${MANIFEST} belongs to ${m.home}; nothing was changed`);
  m.files ||= {};
  m.projects ||= {};
  return m;
}
function peekManifest() { try { const m = readJson(MANIFEST); return m && m.kind === 'synapse-install-manifest' && m.version === MANIFEST_VERSION ? m : null; } catch { return null; } }
// Record the content of every listed whole file a write produces, then write the manifest last in the same change.
function withManifest(m, writes, owned = () => false) {
  for (const w of writes) { const k = fileKey(w.file); if (k in m.files || owned(w.file)) m.files[k] = digest(Buffer.from(w.text)); }
  return [...writes, { file: MANIFEST, text: jsonText(m) }];
}

// ─── The environment the bus will see ───
// Boot reads process.env directly (case-insensitive on Windows) and fills only the names still unset from <home>/.env.
// A plain-object copy of process.env would be case-sensitive and could disagree with boot, so the checks use this view:
// same lookup rule, same order. `overrides` (a token about to be written) win, as they will once written.
function effectiveEnv(fileEnv, overrides = {}) {
  const norm = (k) => (IS_WIN ? String(k).toUpperCase() : String(k));
  const store = new Map();
  for (const [k, v] of Object.entries(process.env)) store.set(norm(k), v);
  for (const [k, v] of fileEnv) if (!store.has(norm(k))) store.set(norm(k), v);
  for (const [k, v] of Object.entries(overrides)) store.set(norm(k), v);
  return new Proxy({}, {
    get: (_, k) => (typeof k === 'string' ? store.get(norm(k)) : undefined),
    set: (_, k, v) => { store.set(norm(k), v); return true; },
    has: (_, k) => typeof k === 'string' && store.has(norm(k)),
    ownKeys: () => [...store.keys()],
    getOwnPropertyDescriptor: (_, k) => (typeof k === 'string' && store.has(norm(k)) ? { value: store.get(norm(k)), enumerable: true, configurable: true, writable: true } : undefined),
  });
}

// ─── .env editing (values never printed) ───
function readEnv() { return fs.existsSync(P.env) ? parseEnvText(fs.readFileSync(P.env, 'utf8')) : new Map(); }
function envTextWith(name, value) {
  const text = fs.existsSync(P.env) ? fs.readFileSync(P.env, 'utf8') : '';
  const lines = text.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const idx = lines.findIndex((l) => l.replace(/^export\s+/, '').startsWith(`${name}=`));
  if (idx >= 0) lines[idx] = `${name}=${value}`; else lines.push(`${name}=${value}`);
  return lines.join('\n') + '\n';
}
const newKey = () => randomBytes(32).toString('base64url');
const keyEnvFor = (id) => `SYNAPSE_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
// The key a bot's sessions use: its own when the roster binds one, else the project's.
const sessionKeyEnv = (project, bot) => (project && project.roster && project.roster[bot] && project.roster[bot].keyEnv) || (project && project.keyEnv);

// ─── Project wiring ───
function readJsonStrict(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return readJson(file); } catch { throw new Error(`${file} is not valid JSON; fix or move it, then run this again (nothing was changed)`); }
}
const hookScript = (script) => fwd(path.join(P.app, 'hooks', script));
const clientScript = () => fwd(path.join(P.app, 'client', 'index.js'));
// A hook entry that runs a script of THIS app (exec form, or the older shell-form string): used only to report entries
// that look like Synapse's but are not, byte for byte, what this CLI recorded.
function pointsIntoApp(h) {
  if (!h || typeof h !== 'object') return false;
  if (Array.isArray(h.args) && typeof h.args[0] === 'string') return fwd(h.args[0]).startsWith(`${fwd(P.app)}/hooks/`);
  return typeof h.command === 'string' && fwd(h.command).includes(`${fwd(P.app)}/hooks/`);
}
const hookEntry = (h) => ({ type: 'command', command: 'node', args: [hookScript(h.script)], timeout: h.timeout });
function addHooks(settings) {
  const s = { ...settings, hooks: { ...(settings.hooks || {}) } };
  for (const h of HOOKS) s.hooks[h.event] = [...(Array.isArray(s.hooks[h.event]) ? s.hooks[h.event] : []), h.matcher ? { matcher: h.matcher, hooks: [hookEntry(h)] } : { hooks: [hookEntry(h)] }];
  return s;
}
const recordedHooks = () => HOOKS.map((h) => ({ event: h.event, matcher: h.matcher, hash: entryHash(hookEntry(h)) }));
// Take out the hook entries this CLI recorded, matched byte for byte under the same event and matcher, one entry per
// record. A group is
// dropped only when this emptied it. `unknown`: entries that run this app's scripts but match no record (edited, or
// written by another install). With nothing to remove, the settings come back unchanged.
function stripRecordedHooks(settings, recorded) {
  const want = new Map(); // each record matches at most one entry; a second copy is reported, not removed
  for (const r of recorded || []) { const k = `${r.event}|${r.matcher || ''}|${r.hash}`; want.set(k, (want.get(k) || 0) + 1); }
  const unknown = [];
  let removed = 0;
  const hooks = {};
  for (const [event, groups] of Object.entries((settings && settings.hooks) || {})) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = [];
    for (const g of groups) {
      const list = g && Array.isArray(g.hooks) ? g.hooks : null;
      if (!list) { kept.push(g); continue; }
      const left = list.filter((x) => {
        const k = `${event}|${g.matcher || ''}|${entryHash(x)}`;
        if (want.get(k)) { want.set(k, want.get(k) - 1); removed++; return false; }
        if (pointsIntoApp(x)) unknown.push({ event, matcher: g.matcher || null });
        return true;
      });
      if (left.length || left.length === list.length) kept.push(left.length === list.length ? g : { ...g, hooks: left });
    }
    if (kept.length || !groups.length) hooks[event] = kept;
  }
  if (!removed) return { settings, removed, unknown };
  const out = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return { settings: out, removed, unknown };
}
function mcpEntry(id, bot, keyEnv) {
  return { type: 'stdio', command: 'node', args: [clientScript(), '--project', id, '--developer', bot, '--key-env', keyEnv], env: { SYNAPSE_HOME: fwd(HOME) } };
}

// ─── git ───
const git = (dir, gitArgs) => execFileSync('git', gitArgs, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
// The enclosing work tree (it may be a parent of the project folder) and its exclude file, as git itself resolves it
// (a linked worktree shares the main repository's info/exclude).
function gitInfo(dir) {
  try {
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    const exclude = git(dir, ['rev-parse', '--git-path', 'info/exclude']);
    return top && exclude ? { top: path.resolve(top), exclude: path.resolve(dir, exclude) } : null;
  } catch { return null; }
}
function gitTracked(dir, rel) {
  try { execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: dir, stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}
function gitIgnored(dir, rel) {
  try { execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: dir, stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}
// Text of an ignore file with these lines added (null when all are there already).
function ignoreTextWith(file, lines) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const add = lines.filter((l) => !have.has(l));
  return add.length ? { text: `${text}${text && !text.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`, added: add } : null;
}
function removeIgnoreLine(file, line) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const kept = lines.filter((l) => l.trim() !== line);
  if (kept.length !== lines.length) fs.writeFileSync(file, kept.join('\n'));
}

// ─── The app: install or upgrade ───
// 1. Refuse while the installed app holds a file the manifest does not list, or a listed file that changed (user files
//    are never moved). 2. Build the new app in a staging folder. 3. Write the new manifest. 4. Swap the folders.
// 5. Verify the installed files. On a failure at 3-5: put back the previous folder and manifest and exit non-zero; if
// that rollback itself fails, say exactly what is where, and never report success.
function installApp(m) {
  const hadApp = fs.existsSync(P.app);
  if (hadApp) {
    if (!m.app || !m.app.files) die(`${P.app} exists but the install manifest does not list it; move it out of the home, then run init again. Nothing was changed.`);
    const changed = [];
    const unknown = [];
    for (const [rel, fp] of Object.entries(walkFiles(P.app))) {
      if (!(rel in m.app.files)) unknown.push(rel);
      else if (m.app.files[rel] !== fp) changed.push(rel);
    }
    if (changed.length || unknown.length) {
      die(`${P.app} holds ${[changed.length ? `${changed.length} changed file(s) (${few(changed)})` : '', unknown.length ? `${unknown.length} file(s) Synapse did not install (${few(unknown)})` : ''].filter(Boolean).join(' and ')}. Move them out of ${P.app}, or restore the changed ones, then run init again. Nothing was changed.`);
    }
  }
  const stamp = `${Date.now()}-${process.pid}`;
  const staging = path.join(HOME, `app.staging-${stamp}`);
  const previous = path.join(HOME, `app.previous-${stamp}`);
  fs.mkdirSync(staging);
  try {
    for (const part of APP_PARTS) if (fs.existsSync(path.join(SOURCE_ROOT, part))) fs.cpSync(path.join(SOURCE_ROOT, part), path.join(staging, part), { recursive: true, verbatimSymlinks: true });
    for (const f of APP_FILES) if (fs.existsSync(path.join(SOURCE_ROOT, f))) fs.copyFileSync(path.join(SOURCE_ROOT, f), path.join(staging, f));
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true }); // this command's own fresh copy
    die(`copying the app failed (${e.message}); the installed app was not changed`);
  }
  const staged = walkFiles(staging);
  const oldManifest = fs.readFileSync(MANIFEST);
  const oldApp = m.app;
  let step = 'writing the new manifest';
  let movedAside = false;
  let promoted = false;
  try {
    writeFileAtomic(MANIFEST, jsonText({ ...m, app: { files: staged } }));
    step = 'moving the installed app aside';
    if (hadApp) { fault('reinit-aside'); fs.renameSync(P.app, previous); movedAside = true; }
    step = 'moving the new app into place';
    fs.renameSync(staging, P.app);
    promoted = true;
    step = 'verifying the new app';
    fault('reinit-verify');
    if (!sameFiles(walkFiles(P.app), staged)) throw new Error('the installed files differ from the staged copy');
  } catch (e) {
    const failed = [];
    const attempt = (what, fn) => { try { fn(); } catch (x) { failed.push(`${what} (${x.code || x.message})`); } };
    if (promoted) attempt(`moving the new app from ${P.app} back to ${staging}`, () => fs.renameSync(P.app, staging));
    if (movedAside && !failed.length) attempt(`moving the previous app from ${previous} back to ${P.app}`, () => { fault('reinit-restore-app'); fs.renameSync(previous, P.app); });
    attempt(`restoring ${MANIFEST}`, () => writeFileAtomic(MANIFEST, oldManifest));
    const why = `init failed while ${step} (${e.code || e.message})`;
    if (failed.length) {
      const record = `${MANIFEST}.before-${stamp}`;
      let saved = true;
      try { fs.writeFileSync(record, oldManifest); } catch { saved = false; }
      die(`${why}, and the rollback did not finish: ${failed.join('; ')}. Now: the previous app is at ${movedAside && fs.existsSync(previous) ? previous : P.app}, the new app at ${fs.existsSync(staging) ? staging : P.app}${saved ? `, and the previous manifest is saved as ${record}` : ''}. Put the previous app at ${P.app} and that manifest at ${MANIFEST}, then run init again.`);
    }
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    die(`${why}; the previous app and manifest were put back${fs.existsSync(staging) ? ` (the unused copy at ${staging} can be deleted)` : ''}`);
  }
  m.app = { files: staged };
  // The upgrade is done and verified; removing the old copy is best effort and never turns it into a failure.
  if (hadApp) {
    try { removeMatching(previous, oldApp.files); pruneListedDirs(previous, Object.keys(oldApp.files)); } catch (e) {
      warn(`the upgrade succeeded, but removing the old copy stopped (${e.code || e.message})`);
    }
    if (fs.existsSync(previous)) warn(`the previous app is left at ${previous}; nothing uses it, delete that folder when convenient`);
  }
}

// ─── Commands ───
async function cmdInit() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 15)) die(`Node ${process.versions.node} is too old; Synapse needs Node 22.15 or newer`);
  if (!fs.existsSync(path.join(SOURCE_ROOT, 'node_modules', 'express'))) die(`dependencies are missing in ${SOURCE_ROOT}; run "npm ci" there first`);
  const existing = fs.existsSync(HOME) ? fs.readdirSync(HOME).filter((n) => n !== '.install.lock') : [];
  if (existing.length && !fs.existsSync(MARKER)) die(`${HOME} exists, is not empty and is not a Synapse home; choose another --home`);
  let owner = null;
  let port = DEFAULT_PORT;
  if (!fs.existsSync(P.config)) {
    owner = String(args.flags.owner || os.userInfo().username || 'owner').toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z]+/, '') || 'owner';
    if (!NAME_RE.test(owner)) die(`"${owner}" is not a valid person name; pass --owner <name> (lowercase letters, digits, - or _)`);
    port = args.flags.port ? Number(args.flags.port) : DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) die('--port must be a port number');
  }
  await withInstallLock(async () => {
    const fresh = !fs.existsSync(MARKER);
    const m = fresh ? newManifest() : readManifest();
    if (!IS_WIN) fs.chmodSync(HOME, 0o700);
    if (fresh) applyWrites([{ file: MARKER, text: jsonText({ kind: 'synapse-home', createdAt: new Date().toISOString() }) }, { file: MANIFEST, text: jsonText(m) }]);
    if (path.resolve(SOURCE_ROOT) !== path.resolve(P.app)) installApp(m);
    fs.mkdirSync(P.data, { recursive: true, mode: 0o700 });
    console.log(`synapse init: home ${HOME}`);
    ok(`app installed at ${P.app}`);
    const writes = [];
    const created = new Set();
    if (!fs.existsSync(P.config)) {
      writes.push({ file: P.config, text: jsonText({
        $schema: './app/schema/synapse.config.schema.json',
        version: 2,
        server: { host: DEFAULT_HOST, port },
        people: { [owner]: { roles: ['owner'] } },
        owners: [owner],
        channels: DEFAULT_CHANNELS,
        corsOrigins: [],
        discord: { enabled: false },
        dashboard: { public: false },
      }) });
      created.add(P.config);
    }
    if (!fs.existsSync(P.projects)) { writes.push({ file: P.projects, text: jsonText({ version: 1, projects: {} }) }); created.add(P.projects); }
    if (!fs.existsSync(P.env)) { writes.push({ file: P.env, text: '# Synapse keys. Owner-only. Never commit, print or share this file.\n', mode: 0o600 }); created.add(P.env); }
    applyWrites(withManifest(m, writes, (f) => created.has(f)));
    (created.has(P.config) ? ok : note)(created.has(P.config) ? `wrote ${P.config} (owner: ${owner}, port ${port})` : `kept the existing ${P.config}`);
    (created.has(P.projects) ? ok : note)(created.has(P.projects) ? `wrote ${P.projects}` : `kept the existing ${P.projects}`);
    const prot = protectFile(P.env);
    (prot.ok === null ? note : ok)(prot.message);
    const cfg = readJson(P.config);
    console.log('\nNext:');
    console.log(`  1. [human] in your own terminal: node "${fwd(path.join(P.app, 'bin', 'synapse.mjs'))}" set-human-key ${cfg.owners[0]}`);
    console.log('  2. synapse add-project <dir>');
    console.log('  3. synapse start --background, then synapse doctor --ready');
  });
}

async function readSecretLine(prompt) {
  if (args.flags.stdin || !process.stdin.isTTY) {
    let raw = '';
    for await (const c of process.stdin) raw += c;
    return raw.split(/\r?\n/)[0];
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let s = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); resolve(s); return; }
        if (c === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function cmdSetHumanKey() {
  const name = args._[1];
  if (!name || !NAME_RE.test(name)) die('usage: synapse set-human-key <name> [--role owner|approver|pingable] [--projects a,b]');
  if (!fs.existsSync(P.config) || !fs.existsSync(MARKER)) die('no Synapse home here; run "synapse init" first');
  const cfg = readJson(P.config);
  const role = args.flags.role;
  if (!(cfg.people && cfg.people[name]) && (!role || !ROLES.includes(role))) die(`"${name}" is not in people; add them with --role ${ROLES.join('|')}`);
  const key = await readSecretLine(`Personal key for ${name} (12-256 printable characters, no spaces; not shown): `);
  const confirm = args.flags.stdin || !process.stdin.isTTY ? key : await readSecretLine('Again: ');
  if (key !== confirm) die('the two entries differ; nothing changed');
  const problem = humanKeyProblem(key);
  if (problem) die(`${problem}; nothing changed`);
  await withInstallLock(() => {
    const m = readManifest();
    const fresh = readJson(P.config);
    fresh.people = fresh.people || {};
    if (!fresh.people[name]) fresh.people[name] = { roles: [role], ...(args.flags.projects ? { projects: String(args.flags.projects).split(',').map((s) => s.trim()).filter(Boolean) } : {}) };
    fresh.people[name].keyHash = hashHumanKey(key);
    applyWrites(withManifest(m, [{ file: P.config, text: jsonText(fresh) }]));
  });
  console.log(`synapse: stored a hash of ${name}'s key in ${P.config}. Keep the key yourself; Synapse cannot show it again. Restart the bus to apply.`);
}

async function cmdAddProject() {
  const dirArg = args._[1];
  if (!dirArg) die('usage: synapse add-project <dir> [--id <id>] [--bot <name>] [--name <display name>] [--shared]');
  const dir = path.resolve(dirArg);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(`${dir} is not a folder`);
  if (!fs.existsSync(MARKER) || !fs.existsSync(path.join(P.app, 'client', 'index.js'))) die('no Synapse home here; run "synapse init" first');
  const shared = !!args.flags.shared;
  const noMcp = !!args.flags['no-mcp'];
  await withInstallLock(() => {
    // ── Preflight: read and check everything, and build every new file in memory, before the first write ──
    const m = readManifest();
    const prevRec = m.projects[fileKey(dir)] || null;
    let cfg; let reg; let mcp; let settings; let otherSettings; let localCfg;
    const settingsRel = shared ? '.claude/settings.json' : '.claude/settings.local.json';
    const settingsFile = path.join(dir, settingsRel);
    const otherFile = path.join(dir, '.claude', shared ? 'settings.local.json' : 'settings.json');
    const mcpFile = path.join(dir, '.mcp.json');
    const localCfgFile = path.join(dir, '.synapse', 'config.json');
    try {
      cfg = readJson(P.config);
      reg = readJson(P.projects);
      mcp = readJsonStrict(mcpFile, {});
      settings = readJsonStrict(settingsFile, {});
      otherSettings = readJsonStrict(otherFile, null);
      localCfg = readJsonStrict(localCfgFile, null);
    } catch (e) { die(e.message); }
    // Wiring this CLI did not write as it is now is never overwritten: it is named, and left to you.
    if (localCfg && fingerprint(localCfgFile) !== m.files[fileKey(localCfgFile)]) die(`${localCfgFile} was not written by this installation as it is now (edited, or from another install). Move it away, then run add-project again. Nothing was changed.`);
    const oldMcp = mcp.mcpServers && mcp.mcpServers[MCP_NAME];
    if (oldMcp && !(prevRec && prevRec.mcp && prevRec.mcp.hash === entryHash(oldMcp))) die(`${mcpFile} has a "${MCP_NAME}" server that is not, byte for byte, the one this installation wrote. Remove it by hand, then run add-project again. Nothing was changed.`);
    const stripped = stripRecordedHooks(settings, prevRec && prevRec.hooks && prevRec.hooks.file === settingsRel ? prevRec.hooks.entries : []);
    if (stripped.unknown.length) die(`${settingsFile} has Synapse hook entries this installation did not write as they are now (${stripped.unknown.map((u) => u.event).join(', ')}). Remove them by hand, then run add-project again. Nothing was changed.`);
    if (otherSettings && stripRecordedHooks(otherSettings, []).unknown.length) die(`${otherFile} also has Synapse hook entries (from the other mode, or edited). Remove them by hand, or run uninstall first. Nothing was changed.`);
    const id = String(args.flags.id || (localCfg && localCfg.project) || path.basename(dir)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!PROJECT_RE.test(id)) die(`"${id}" is not a valid project id; pass --id <id>`);
    const bot = String(args.flags.bot || (localCfg && localCfg.developer) || `${id.replace(/[^a-z0-9]/g, '')}bot`).toLowerCase();
    if (!BOT_RE.test(bot) || bot.includes('.')) die(`"${bot}" is not a valid bot name; pass --bot <name>`);
    if (cfg.people && cfg.people[bot]) die(`"${bot}" is a person's name; a bot needs its own name (--bot)`);
    if (bot === (cfg.systemSender || 'synapse')) die(`"${bot}" is the bus's own sender name; choose another --bot`);
    const prev = reg.projects[id];
    if (prev && prev.root && !samePath(prev.root, dir)) die(`project id "${id}" is already used for ${prev.root}; pass --id <another id>`);
    const keyEnv = keyEnvFor(id);
    // Every key name in the registry, project or per-bot, has one owner.
    for (const [other, p] of Object.entries(reg.projects)) {
      if (other !== id && p.keyEnv === keyEnv) die(`project "${other}" already uses the key name ${keyEnv}; pass a different --id`);
      for (const [b, r] of Object.entries((p && p.roster) || {})) if (r && r.keyEnv === keyEnv) die(`bot "${b}" of project "${other}" already uses the key name ${keyEnv}; pass a different --id`);
    }
    if (Object.entries(reg.projects).some(([other, p]) => other !== id && p.root && samePath(p.root, dir))) die(`${dir} is already registered under another project id`);
    const g = gitInfo(dir);
    const tracked = (rel) => !!g && gitTracked(dir, rel);
    // The candidate registry: existing per-bot key bindings are kept, and the whole file must load before it is written.
    const env = readEnv();
    const keyValue = env.get(keyEnv) || newKey();
    const prevRoster = (prev && prev.roster) || {};
    const entry = {
      ...(prev || {}),
      displayName: String(args.flags.name || (prev && prev.displayName) || path.basename(dir)),
      root: fwd(dir),
      keyEnv,
      assertableBots: [...new Set([...((prev && prev.assertableBots) || []), bot])],
      roster: { ...prevRoster, [bot]: prevRoster[bot] || { displayName: bot } },
    };
    const candidate = { ...reg, projects: { ...reg.projects, [id]: entry } };
    const botKeyEnv = sessionKeyEnv(entry, bot); // the bot's own key when the roster binds one
    if (!shared && !noMcp && tracked('.mcp.json')) {
      die(`.mcp.json is tracked in git, and this would write this machine's paths into it; nothing was changed. Either pass --shared (you then decide what to commit), or register the server for this machine only and pass --no-mcp:\n  claude mcp add --scope local ${MCP_NAME} -e SYNAPSE_HOME="${fwd(HOME)}" -- node "${clientScript()}" --project ${id} --developer ${bot} --key-env ${botKeyEnv}`);
    }
    if (!shared && tracked(settingsRel)) die(`${settingsRel} is tracked in git, and this would write this machine's paths into it; nothing was changed. Untrack it (git rm --cached ${settingsRel}) or pass --shared.`);
    const newCfg = cfg.defaultProject ? cfg : { ...cfg, defaultProject: id };
    const checkEnv = { ...process.env };
    for (const [k, v] of env) if (checkEnv[k] === undefined) checkEnv[k] = v;
    if (checkEnv[keyEnv] === undefined) checkEnv[keyEnv] = keyValue;
    const fatal = checkRegistry(candidate, withDefaults(newCfg), checkEnv).filter((f) => f.level === 'fatal');
    if (fatal.length) die(`the registry would not load after this change; nothing was changed:\n  ${fatal.map((f) => f.message).join('\n  ')}`);
    // Machine-local files git must not pick up: anchored lines in the work tree's exclude file. Shared: .gitignore.
    const machineLocal = shared ? ['.synapse/'] : ['.synapse/', settingsRel, ...(!noMcp && !tracked('.mcp.json') ? ['.mcp.json'] : [])];
    const toIgnore = g ? machineLocal.filter((rel) => !gitIgnored(dir, rel.endsWith('/') ? `${rel}config.json` : rel)) : [];
    const relTop = g ? fwd(path.relative(g.top, dir)) : '';
    const ignoreFile = g ? (shared ? path.join(dir, '.gitignore') : g.exclude) : null;
    const ignoreLines = toIgnore.map((rel) => (shared ? rel : `/${relTop ? `${relTop}/` : ''}${rel}`));

    const rec = m.projects[fileKey(dir)] ||= { created: [], dirsCreated: [], ignore: [], mcp: null, hooks: null };
    const writes = [{ file: P.projects, text: jsonText(candidate) }];
    if (newCfg !== cfg) writes.push({ file: P.config, text: jsonText(newCfg) });
    const newEnvKey = !env.get(keyEnv);
    if (newEnvKey) writes.push({ file: P.env, text: envTextWith(keyEnv, keyValue), mode: 0o600 });
    if (noMcp) rec.mcp = { manual: true, server: MCP_NAME };
    else {
      if (!fs.existsSync(mcpFile)) addOnce(rec.created, '.mcp.json');
      const written = mcpEntry(id, bot, botKeyEnv);
      writes.push({ file: mcpFile, text: jsonText({ ...mcp, mcpServers: { ...(mcp.mcpServers || {}), [MCP_NAME]: written } }) });
      rec.mcp = { file: '.mcp.json', server: MCP_NAME, hash: entryHash(written) };
    }
    if (!fs.existsSync(path.join(dir, '.synapse'))) addOnce(rec.dirsCreated, '.synapse');
    if (!fs.existsSync(localCfgFile)) addOnce(rec.created, '.synapse/config.json');
    writes.push({ file: localCfgFile, text: jsonText({ project: id, developer: bot, keyEnv: botKeyEnv }) });
    if (!fs.existsSync(path.join(dir, '.claude'))) addOnce(rec.dirsCreated, '.claude');
    if (!fs.existsSync(settingsFile)) addOnce(rec.created, settingsRel);
    writes.push({ file: settingsFile, text: jsonText(addHooks(stripped.settings)) });
    rec.hooks = { file: settingsRel, entries: recordedHooks() };
    const ign = ignoreFile && ignoreLines.length ? ignoreTextWith(ignoreFile, ignoreLines) : null;
    if (ign) {
      const createdFile = !fs.existsSync(ignoreFile);
      for (const line of ign.added) rec.ignore.push({ path: fwd(ignoreFile), line, createdFile });
      writes.push({ file: ignoreFile, text: ign.text });
    }
    // ── Writes: all of them, or none ──
    applyWrites(withManifest(m, writes, (f) => f === localCfgFile));
    if (newEnvKey) protectFile(P.env);
    console.log(`synapse add-project: ${id} (bot ${bot}) at ${dir}`);
    ok(`registry entry in ${P.projects}; key ${keyEnv} in ${P.env} (value not shown)`);
    if (botKeyEnv !== keyEnv) ok(`bot ${bot} has its own key in the roster: its sessions use ${botKeyEnv}`);
    if (noMcp) note(`--no-mcp: .mcp.json not written; register the "${MCP_NAME}" server for this machine yourself (--key-env ${botKeyEnv})`);
    else ok(`${mcpFile}: server "${MCP_NAME}"${shared ? '' : ' (machine-local: kept out of git)'}`);
    ok(localCfgFile);
    ok(`${settingsFile}: 4 Synapse hooks (exec form: node + script path, no shell)`);
    if (ign) ok(`${ignoreFile}: ${ign.added.join(', ')} ignored${shared ? '' : ' (this machine only)'}`);
    if (!g) note(`${dir} is not in a git repository; nothing was added to an ignore file`);
    else for (const rel of machineLocal) {
      const probe = rel.endsWith('/') ? `${rel}config.json` : rel;
      if (fs.existsSync(path.join(dir, probe)) && !gitIgnored(dir, probe)) warn(`${probe} is not ignored by git; keep it out of commits (it holds this machine's paths)`);
    }
    if (shared) note('--shared: .mcp.json and .claude/settings.json hold absolute paths into this Synapse home; commit them only if every user shares that layout.');
    console.log('\nNext:');
    console.log('  1. restart the bus so it loads the new project: synapse restart');
    console.log(`  2. [human] start Claude Code in ${dir} with:`);
    console.log(`       claude --dangerously-load-development-channels server:${MCP_NAME}`);
    console.log('     approve the project MCP server and the development-channels warning when asked.');
    console.log(`  3. synapse doctor --ready --project "${fwd(dir)}"`);
  });
}
const addOnce = (list, v) => { if (!list.includes(v)) list.push(v); };

// ─── The bus process ───
function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function serverEntry() {
  const installed = path.join(P.app, 'server', 'server.mjs');
  return fs.existsSync(installed) ? installed : path.join(SOURCE_ROOT, 'server', 'server.mjs');
}
function busUrl() {
  const cfg = fs.existsSync(P.config) ? readJson(P.config) : {};
  const s = cfg.server || {};
  const h = !s.host || s.host === '0.0.0.0' || s.host === '::' ? '127.0.0.1' : String(s.host).includes(':') ? `[${s.host}]` : s.host;
  return `http://${h}:${s.port || DEFAULT_PORT}`;
}
async function health(timeoutMs = 1500, base = busUrl()) {
  try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) }); return { url: `${base}/api/health`, body: await r.json() }; }
  catch (e) { return { url: `${base}/api/health`, error: e.cause ? e.cause.code || e.message : e.message }; }
}
// The running bus, proven: its owner file names a pid and an instance, and the bus on that port reports both.
async function verifiedBus() {
  let owner = null;
  try { owner = readJson(OWNER_FILE); } catch { owner = null; }
  if (!owner) return { state: 'none' };
  const h = await health(1500, `http://127.0.0.1:${owner.port}`);
  if (h.body && h.body.pid === owner.pid && h.body.instance === owner.instance) return { state: 'running', owner };
  if (!alive(owner.pid)) return { state: 'stale', owner };
  return { state: 'unverified', owner };
}
async function cmdStart() {
  const v = await verifiedBus();
  if (v.state === 'running') { console.log(`synapse: the bus is already running (pid ${v.owner.pid})`); return; }
  const env = { ...process.env, SYNAPSE_HOME: HOME };
  if (!args.flags.background) {
    const child = spawn(process.execPath, [serverEntry()], { env, stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  fs.mkdirSync(P.data, { recursive: true });
  const logFile = path.join(P.data, 'bus.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [serverEntry()], { env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await health(500);
    if (h.body && h.body.pid === child.pid) { console.log(`synapse: bus started (pid ${child.pid}) at ${busUrl()}; dashboard ${busUrl()}/; log ${logFile}`); return; }
    if (!alive(child.pid)) break;
  }
  die(`the bus did not come up; read ${logFile}`);
}
async function cmdStop({ quiet = false } = {}) {
  const v = await verifiedBus();
  if (v.state === 'none') { if (!quiet) console.log('synapse: the bus is not running'); return true; }
  if (v.state === 'stale') { try { fs.rmSync(OWNER_FILE); } catch {} if (!quiet) console.log('synapse: the bus is not running (removed a stale owner file)'); return true; }
  if (v.state === 'unverified') {
    console.error(`synapse: pid ${v.owner.pid} is alive but is not answering as this bus; not stopping it (it may be another program reusing the pid). Stop it yourself if it is the bus.`);
    return false;
  }
  process.kill(v.owner.pid, 'SIGTERM');
  for (let i = 0; i < 20 && alive(v.owner.pid); i++) await new Promise((r) => setTimeout(r, 250));
  if (alive(v.owner.pid)) die(`pid ${v.owner.pid} did not stop`);
  try { fs.rmSync(OWNER_FILE); } catch {}
  if (!quiet) console.log(`synapse: bus stopped (pid ${v.owner.pid})`);
  return true;
}

// ─── doctor ───
// Every check of every project runs first. Only when all of them passed does --ready start any MCP client, and then
// only the invocation this doctor builds itself.
async function cmdDoctor() {
  const ready = !!args.flags.ready;
  let failures = 0;
  const unverified = [];
  const probes = [];
  const fail = (m) => { failures++; bad(m); };
  console.log(`synapse doctor${ready ? ' --ready' : ''}: home ${HOME}`);
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 15)) ok(`node ${process.versions.node}`); else fail(`node ${process.versions.node}: need 22.15 or newer`);
  try { await import('node:sqlite'); ok('node:sqlite available'); } catch { fail('node:sqlite is not available in this Node'); }
  if (!fs.existsSync(MARKER)) { fail('no Synapse home here; run "synapse init"'); return finish(failures, unverified); }
  if (!peekManifest()) fail(`${MANIFEST} is missing or not a version ${MANIFEST_VERSION} install manifest`);
  if (fs.existsSync(path.join(P.app, 'client', 'index.js')) && fs.existsSync(path.join(P.app, 'node_modules', 'ws'))) ok(`app installed at ${P.app}`); else fail('the app is not installed in the home; run "synapse init"');
  const env = effectiveEnv(readEnv());
  const { config, registry, findings } = loadHomeConfig(P, env);
  for (const f of findings) {
    const blocking = f.level === 'fatal' || (ready && /no owner has a key yet/.test(f.message));
    (blocking ? fail : note)(f.message);
  }
  if (config && !findings.some((f) => f.level === 'fatal')) ok(`config valid: ${Object.keys(registry.projects).length} project(s), owners ${config.owners.join(', ')}`);
  if (fs.existsSync(P.env)) { const c = checkFileProtection(P.env); (c.ok === false ? fail : c.ok ? ok : note)(c.message); } else fail(`${P.env} is missing`);
  const h = await health();
  const busUp = !!(h.body && h.body.status === 'healthy');
  if (busUp) ok(`bus healthy at ${busUrl()} (pid ${h.body.pid}); dashboard ${busUrl()}/`);
  else (ready ? fail : note)(`bus not reachable at ${h.url} (${h.error || 'no answer'}); start it with "synapse start --background"`);
  // The Discord pack: the boot checks above already covered its config; here, what only the machine can tell.
  if (config && config.discord.enabled === true) {
    const tokenEnv = config.discord.tokenEnv || DEFAULT_DISCORD_TOKEN_ENV;
    if (env[tokenEnv]) ok(`discord: bot token set in ${tokenEnv} (value not shown)`); else fail(`discord: ${tokenEnv} is not set; run "synapse discord setup" in your own terminal`);
    const onDisk = readEnv().get(tokenEnv);
    if (process.env[tokenEnv] !== undefined && onDisk !== undefined && process.env[tokenEnv] !== onDisk) warn(`discord: ${tokenEnv} in this shell differs from the one in ${P.env}; a bus started from this shell would use the shell's`);
    const mod = discordModuleLoads();
    if (mod.ok) ok('discord: the discord.js package loads from the app'); else fail(`discord: discord.js ${mod.why} in ${P.app}; run "npm ci" in the Synapse source folder (optional dependencies included), then "synapse init" again`);
    const dp = config.discord.projects || {};
    const mapped = Object.values(dp).reduce((n, p) => n + Object.keys((p && p.channels) || {}).length, 0);
    (mapped ? ok : warn)(`discord: ${mapped} channel(s) mapped for ${Object.keys(dp).length} project(s)`);
    const deciders = Object.keys(config.people).filter((n) => (config.owners.includes(n) || (config.people[n].roles || []).some((r) => r === 'owner' || r === 'approver')) && config.people[n].accounts && config.people[n].accounts.discord);
    (deciders.length ? ok : warn)(`discord: ${deciders.length} owner(s) or approver(s) can answer on Discord${deciders.length ? ` (${deciders.join(', ')})` : ''}`);
    if (busUp) {
      if (h.body.humanChannel !== 'discord') fail('discord: the running bus has not loaded the Discord pack; run "synapse restart"');
      else if (h.body.humanChannelStatus && h.body.humanChannelStatus.connected === true) ok('discord: the bus is connected to Discord');
      else (ready ? fail : warn)(`discord: the bus is not connected to Discord (check the token, the Message Content intent and the bot's invite; the reason is in ${path.join(P.data, 'bus.log')})`);
    }
  } else if (config) note('discord: off ("synapse discord setup" turns it on)');
  if (busUp && registry) {
    for (const [id, p] of Object.entries(registry.projects)) {
      const r = await whoami(env[p.keyEnv], id);
      if (r.status === 200) ok(`project ${id}: key accepted by the bus`);
      else if (r.status === 400) fail(`project ${id}: the running bus does not know it; run "synapse restart"`);
      else fail(`project ${id}: key refused (${r.status || r.error}); run "synapse restart" if the key was just created`);
    }
  }
  const claudeVersion = claudeCliVersion();
  if (claudeVersion) ok(`claude ${claudeVersion}`); else note('the claude CLI is not on PATH (needed to run sessions, not for the bus)');
  const dirs = args.flags.project ? [path.resolve(String(args.flags.project))] : Object.values((registry && registry.projects) || {}).map((p) => p.root).filter(Boolean);
  for (const dir of dirs) failures += await checkProjectDir(dir, registry, { env, busUp, ready, unverified, probes });
  if (ready && probes.length) {
    console.log('MCP probes');
    for (const p of probes) {
      if (failures) { bad(`${p.dir}: MCP probe not run, because of the problems above (the doctor never starts a client while any check fails)`); failures++; continue; }
      const r = await probeMcp(p.args);
      if (r.ok) ok(`${p.dir}: the client starts and lists ${r.tools} tools`); else { bad(`${p.dir}: MCP probe failed: ${r.error}`); failures++; }
    }
  }
  return finish(failures, unverified);
}
// No shell with an argument list anywhere. A native claude(.exe) runs directly; on Windows an npm claude.cmd needs
// cmd.exe, so it gets one fixed command string that holds no path or other data.
function claudeCliVersion() {
  const opts = { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] };
  try { return execFileSync('claude', ['--version'], opts).trim(); } catch {}
  if (IS_WIN) { try { return execSync('claude --version', opts).trim(); } catch {} }
  return null;
}
async function whoami(key, project) {
  try {
    const r = await fetch(`${busUrl()}/api/whoami`, { headers: { 'X-Dev-Key': key || '', 'X-Dev-Project': project }, signal: AbortSignal.timeout(1500) });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  } catch (e) { return { status: 0, error: e.message }; }
}
async function checkProjectDir(dir, registry, { env, busUp, ready, unverified, probes }) {
  let f = 0;
  const fail = (m) => { f++; bad(m); };
  console.log(`project folder ${dir}`);
  let local;
  try { local = readJsonStrict(path.join(dir, '.synapse', 'config.json'), null); } catch (e) { fail(e.message); return f; }
  if (!local) { fail('.synapse/config.json is missing; run "synapse add-project"'); return f; }
  const reg = registry && registry.projects[local.project];
  if (!reg) { fail(`.synapse/config.json names project "${local.project}", which is not in projects.json`); return f; }
  ok(`.synapse/config.json: project ${local.project}, bot ${local.developer}`);
  if (!(reg.assertableBots || []).includes(local.developer)) fail(`bot "${local.developer}" is not in project ${local.project}'s assertableBots`);
  const keyEnv = sessionKeyEnv(reg, local.developer);
  const ownKey = keyEnv !== reg.keyEnv;
  if (local.keyEnv !== keyEnv) fail(`.synapse/config.json keyEnv ${local.keyEnv} should be ${keyEnv} (${ownKey ? 'the bot\'s own key in the roster' : 'the project key'}); run add-project again`);
  // The bot's sessions authenticate with that key as that bot.
  if (busUp) {
    const r = await whoami(env[keyEnv], local.project);
    const asWanted = r.status === 200 && r.body && (ownKey ? r.body.kind === 'bot' && r.body.name === local.developer : r.body.kind === 'project');
    if (asWanted) ok(`${keyEnv} authenticates ${ownKey ? `as bot ${local.developer}` : `for project ${local.project}`}`);
    else fail(`${keyEnv} does not authenticate ${ownKey ? `as bot ${local.developer}` : `for project ${local.project}`} (${r.status || r.error}); run "synapse restart" if the key is new`);
  }
  // Hooks: each of the four events exactly once, with the right matcher, type and argument vector, and an existing script.
  const found = [];
  for (const name of ['settings.local.json', 'settings.json']) {
    let s = {};
    try { s = readJsonStrict(path.join(dir, '.claude', name), {}); } catch (e) { fail(e.message); continue; }
    for (const [event, groups] of Object.entries(s.hooks || {})) for (const g of Array.isArray(groups) ? groups : []) for (const x of (g && g.hooks) || []) if (pointsIntoApp(x)) found.push({ name, event, matcher: g.matcher || null, hook: x });
  }
  for (const h of HOOKS) {
    const hits = found.filter((x) => x.event === h.event);
    const script = hookScript(h.script);
    if (hits.length === 0) { fail(`hook ${h.event}: missing; run "synapse add-project" again`); continue; }
    if (hits.length > 1) fail(`hook ${h.event}: ${hits.length} Synapse entries; there must be exactly one`);
    const x = hits[0];
    if ((x.matcher || null) !== h.matcher) fail(`hook ${h.event}: matcher "${x.matcher}" should be "${h.matcher}"`);
    const shapeOk = x.hook.type === 'command' && x.hook.command === 'node' && Array.isArray(x.hook.args) && x.hook.args.length === 1 && samePath(x.hook.args[0], script);
    if (!shapeOk) fail(`hook ${h.event}: should be { "type": "command", "command": "node", "args": ["${script}"] } (exec form)`);
    else if (!fs.existsSync(script)) fail(`hook ${h.event}: script ${script} is missing`);
    else if (hits.length === 1) ok(`hook ${h.event} -> ${h.script} (${x.name})`);
  }
  for (const x of found) if (!HOOKS.some((h) => h.event === x.event)) fail(`hook entry under ${x.event} is not one this installation writes`);
  // The MCP entry must be exactly what this installation writes.
  let mcp = {};
  try { mcp = readJsonStrict(path.join(dir, '.mcp.json'), {}); } catch (e) { fail(e.message); }
  const entry = mcp.mcpServers && mcp.mcpServers[MCP_NAME];
  const want = mcpEntry(local.project, local.developer, keyEnv);
  const rec = ((peekManifest() || { projects: {} }).projects || {})[fileKey(dir)];
  if (!entry && rec && rec.mcp && rec.mcp.manual) {
    note('MCP server registered outside .mcp.json (--no-mcp); not checked here');
    if (ready) unverified.push(`${dir}: the "${MCP_NAME}" MCP server you registered yourself (--no-mcp); run "claude mcp get ${MCP_NAME}" there`);
  } else if (!entry) fail(`.mcp.json has no "${MCP_NAME}" server`);
  else {
    const extra = Object.keys(entry).filter((k) => !['type', 'command', 'args', 'env'].includes(k));
    const envKeys = entry.env && typeof entry.env === 'object' ? Object.keys(entry.env) : [];
    const argsOk = Array.isArray(entry.args) && entry.args.length === want.args.length && entry.args.every((a, i) => (i === 0 ? samePath(a, want.args[0]) : a === want.args[i]));
    const before = f;
    if (entry.type !== 'stdio') fail(`.mcp.json ${MCP_NAME}: type is ${JSON.stringify(entry.type)}, expected "stdio"`);
    if (entry.command !== 'node') fail(`.mcp.json ${MCP_NAME}: command is "${entry.command}", expected "node"`);
    if (!argsOk) fail(`.mcp.json ${MCP_NAME}: args differ from [${want.args.join(' ')}]; run add-project again`);
    if (!(envKeys.length === 1 && envKeys[0] === 'SYNAPSE_HOME' && samePath(entry.env.SYNAPSE_HOME, HOME))) fail(`.mcp.json ${MCP_NAME}: env must be exactly { "SYNAPSE_HOME": "${fwd(HOME)}" }`);
    if (extra.length) fail(`.mcp.json ${MCP_NAME}: unexpected field(s) ${extra.join(', ')}`);
    if (!fs.existsSync(want.args[0])) fail(`client script ${want.args[0]} does not exist`);
    if (f === before) ok(`.mcp.json: ${MCP_NAME} -> ${want.args[0]}`);
    if (ready) probes.push({ dir, args: want.args });
  }
  // Machine-local files must stay out of git.
  if (gitInfo(dir)) {
    const localMode = rec && rec.hooks && rec.hooks.file === '.claude/settings.local.json';
    const rels = ['.synapse/config.json', ...(localMode ? ['.claude/settings.local.json'] : []), ...(localMode && rec.mcp && rec.mcp.file && !gitTracked(dir, '.mcp.json') ? ['.mcp.json'] : [])];
    for (const rel of rels) if (fs.existsSync(path.join(dir, rel)) && !gitIgnored(dir, rel)) warn(`${rel} is not ignored by git; keep it out of commits (it holds this machine's paths)`);
  }
  console.log(`  note  launch: claude --dangerously-load-development-channels server:${MCP_NAME}`);
  return f;
}
// Start the client as this installation would write it, with this doctor's own environment (no DEV_SYNC_* or
// NODE_OPTIONS from the caller), and ask it for its tools.
function probeMcp(clientArgs) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^DEV_SYNC_/.test(k) && k !== 'NODE_OPTIONS') env[k] = v;
  Object.assign(env, { SYNAPSE_HOME: HOME, DEV_SYNC_SEAT: 'doctor' });
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(process.execPath, clientArgs, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const finishProbe = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => finishProbe({ ok: false, error: 'no answer within 10 s' }), 10_000);
    let buf = '';
    child.on('error', (e) => finishProbe({ ok: false, error: e.message }));
    child.on('exit', (code) => finishProbe({ ok: false, error: `the client exited (${code})` }));
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2) {
          const tools = (msg.result && msg.result.tools) || [];
          finishProbe(tools.some((t) => t.name === 'dev_sync_checkin') ? { ok: true, tools: tools.length } : { ok: false, error: 'tools/list has no dev_sync_checkin' });
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synapse-doctor', version: '1' } } }) + '\n');
  });
}
function finish(failures, unverified = []) {
  if (unverified.length) { console.log('\nnot verified by the doctor (check these yourself):'); for (const u of unverified) console.log(`  - ${u}`); }
  console.log(failures ? `\nsynapse doctor: ${failures} problem(s)` : unverified.length ? `\nsynapse doctor: all automatic checks passed; ${unverified.length} item(s) above are not verified` : '\nsynapse doctor: all checks passed');
  process.exit(failures ? 1 : 0);
}

// ─── uninstall: only what the manifest recorded, and only while it is exactly what was written ───
async function cmdUninstall() {
  if (!fs.existsSync(MARKER)) die(`${HOME} has no Synapse home marker (.synapse-home); refusing to remove anything there`);
  const yes = !!args.flags.yes;
  let removeHome = false;
  console.log(`synapse uninstall${yes ? '' : ' (dry run; pass --yes to apply)'}: home ${HOME}`);
  const run = async () => {
    const m = readManifest();
    const problems = []; // a step that failed
    const byHand = []; // edited or unknown wiring that still runs this app: you remove it, then run uninstall again
    const kept = []; // edited files that do not run anything: kept for you
    const act = (msg, fn) => {
      console.log(`  ${yes ? 'remove' : 'would remove'} ${msg}`);
      if (!yes) return true;
      try { fn(); return true; } catch (e) { problems.push(`${msg}: ${e.message}`); console.log(`    failed: ${e.message}`); return false; }
    };
    // A whole file this CLI wrote: removed only while its content is what the manifest recorded.
    const removeIfUnchanged = (file) => {
      const k = fileKey(file);
      const fp = fingerprint(file);
      if (fp === null) { if (yes) delete m.files[k]; return; }
      if (fp !== m.files[k]) { kept.push(file); console.log(`  keep  ${file} (changed since Synapse wrote it)`); return; }
      if (act(file, () => fs.rmSync(file)) && yes) delete m.files[k];
    };
    if (yes) { const stopped = await cmdStop({ quiet: true }); if (!stopped) die('the bus could not be stopped safely; stop it, then run uninstall again'); }
    for (const [dirKey, rec] of Object.entries(m.projects)) {
      const dir = path.resolve(dirKey);
      const before = problems.length + byHand.length;
      if (!fs.existsSync(dir)) { console.log(`  skip  ${dir} (folder gone)`); if (yes) delete m.projects[dirKey]; continue; }
      if (rec.mcp && rec.mcp.file) {
        const file = path.join(dir, rec.mcp.file);
        let mcp = null;
        try { mcp = readJsonStrict(file, null); } catch (e) { problems.push(e.message); console.log(`  FAIL  ${e.message}`); }
        const entry = mcp && mcp.mcpServers && mcp.mcpServers[rec.mcp.server];
        if (entry && entryHash(entry) === rec.mcp.hash) {
          act(`server "${rec.mcp.server}" from ${file}`, () => {
            delete mcp.mcpServers[rec.mcp.server];
            const empty = Object.keys(mcp.mcpServers).length === 0 && Object.keys(mcp).length === 1;
            if (empty && rec.created.includes(rec.mcp.file)) fs.rmSync(file); else writeFileAtomic(file, jsonText(mcp));
          });
        } else if (entry) byHand.push(`the "${rec.mcp.server}" entry under "mcpServers" in ${file} (changed since Synapse wrote it)`);
      }
      if (rec.hooks && rec.hooks.file) {
        const file = path.join(dir, rec.hooks.file);
        let s = null;
        try { s = readJsonStrict(file, null); } catch (e) { problems.push(e.message); console.log(`  FAIL  ${e.message}`); }
        if (s) {
          // A record whose entry appears more than once across both settings files is ambiguous: none of those copies
          // is removed (all are listed for you), so every retry gives the same answer.
          const keyOf = (event, matcher, x) => `${event}|${matcher || ''}|${entryHash(x)}`;
          const counts = new Map();
          for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
            let t = null;
            try { t = name === rec.hooks.file ? s : readJsonStrict(path.join(dir, name), null); } catch {}
            for (const [event, groups] of Object.entries((t && t.hooks) || {})) for (const g of Array.isArray(groups) ? groups : []) for (const x of (g && Array.isArray(g.hooks) ? g.hooks : [])) { const k = keyOf(event, g.matcher, x); counts.set(k, (counts.get(k) || 0) + 1); }
          }
          const unambiguous = (rec.hooks.entries || []).filter((e) => (counts.get(`${e.event}|${e.matcher || ''}|${e.hash}`) || 0) <= 1);
          const r = stripRecordedHooks(s, unambiguous);
          for (const u of r.unknown) byHand.push(`the ${u.event} hook entry${u.matcher ? ` (matcher "${u.matcher}")` : ''} that runs ${fwd(P.app)}/hooks/... in ${file} (changed since Synapse wrote it)`);
          if (r.removed) act(`${r.removed} Synapse hook entr${r.removed === 1 ? 'y' : 'ies'} from ${file}`, () => {
            if (Object.keys(r.settings).length === 0 && rec.created.includes(rec.hooks.file)) fs.rmSync(file); else writeFileAtomic(file, jsonText(r.settings));
          });
        }
      }
      for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
        if (rec.hooks && rec.hooks.file === name) continue;
        const file = path.join(dir, name);
        let s = null;
        try { s = readJsonStrict(file, null); } catch (e) { problems.push(e.message); console.log(`  FAIL  ${e.message}`); }
        for (const u of s ? stripRecordedHooks(s, []).unknown : []) byHand.push(`the ${u.event} hook entry${u.matcher ? ` (matcher "${u.matcher}")` : ''} that runs ${fwd(P.app)}/hooks/... in ${file} (Synapse did not write it there)`);
      }
      if (rec.created.includes('.synapse/config.json')) removeIfUnchanged(path.join(dir, '.synapse', 'config.json'));
      for (const ig of rec.ignore || []) {
        const file = path.resolve(ig.path);
        if (!fs.existsSync(file)) continue;
        act(`the line "${ig.line}" from ${file}`, () => {
          removeIgnoreLine(file, ig.line);
          if (ig.createdFile && fs.readFileSync(file, 'utf8').trim() === '') fs.rmSync(file);
        });
      }
      if (yes) for (const d of rec.dirsCreated || []) rmdirIfEmpty(path.join(dir, d));
      if (yes && problems.length + byHand.length === before) delete m.projects[dirKey];
    }
    if (yes) writeFileAtomic(MANIFEST, jsonText(m));
    if (byHand.length) {
      console.log('\nRemove these by hand (they still run this Synapse app, but are not what Synapse wrote, so they were kept):');
      for (const b of byHand) console.log(`  - ${b}`);
    }
    if (problems.length || byHand.length) {
      console.log(`\nsynapse uninstall: the Synapse home, its app and the manifest are kept, so nothing is left pointing at removed scripts. ${problems.length ? 'Fix the failed step(s) above' : 'Remove the entries above'}, then run uninstall again.`);
      process.exit(1);
    }
    if (args.flags['keep-home']) { console.log(`  keep  ${HOME} (--keep-home)`); return; }
    // The app: each installed file that still matches; your own files inside it, and changed ones, stay.
    const appFiles = Object.entries((m.app && m.app.files) || {});
    let matching = 0;
    for (const [rel, want] of appFiles) {
      const p = path.join(P.app, rel);
      const fp = fingerprint(p);
      if (fp === null) { if (yes) delete m.app.files[rel]; continue; }
      if (fp !== want) { kept.push(p); console.log(`  keep  ${p} (changed since it was installed)`); continue; }
      matching++;
      if (yes) { try { fs.rmSync(p); delete m.app.files[rel]; } catch (e) { problems.push(`${p}: ${e.message}`); } }
    }
    console.log(`  ${yes ? 'remove' : 'would remove'} ${matching} installed app file(s) under ${P.app}`);
    if (yes) pruneListedDirs(P.app, appFiles.map(([rel]) => rel));
    for (const rel of m.runtime || []) { const p = path.join(HOME, rel); if (fs.existsSync(p)) act(p, () => fs.rmSync(p)); }
    for (const file of Object.keys(m.files)) { const p = path.resolve(file); if (inside(p, HOME)) removeIfUnchanged(p); }
    const seats = path.join(P.data, 'seats');
    if (yes) rmdirIfEmpty(seats);
    if (fs.existsSync(seats) && fs.readdirSync(seats).length) console.log(`  keep  ${seats} (session records MCP clients write and remove themselves; delete it by hand once no session is running)`);
    if (!yes) return;
    rmdirIfEmpty(P.data);
    const left = fs.readdirSync(HOME).filter((n) => !['install-manifest.json', '.synapse-home', '.install.lock'].includes(n));
    if (problems.length || left.length) {
      writeFileAtomic(MANIFEST, jsonText(m));
      if (left.length) console.log(`  keep  ${HOME}: it still holds ${left.join(', ')} (files Synapse did not write, or changed since); the manifest stays, so uninstall can run again`);
      if (problems.length) { console.log(`\nsynapse uninstall: ${problems.length} removal(s) failed; run uninstall again`); process.exit(1); }
      return;
    }
    fs.rmSync(MANIFEST, { force: true });
    fs.rmSync(MARKER, { force: true });
    removeHome = true;
  };
  if (yes) await withInstallLock(run); else await run();
  if (removeHome) rmdirIfEmpty(HOME);
  if (!yes) console.log('\nNothing was changed. Re-run with --yes to apply. [human] confirm first: removing the home deletes all keys and history.');
}

// ─── discord: the optional Discord pack ───
// One command turns it on: the bot token (read without echo, stored in <home>/.env like the bus keys), the people's
// Discord user ids and the channel mapping go into synapse.config.json, and the whole result must pass the same checks
// the bus runs at boot before anything is written. Ids are never printed.
const repeated = (name) => {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && i + 1 < argv.length) out.push(argv[++i]);
    else if (argv[i].startsWith(`--${name}=`)) out.push(argv[i].slice(name.length + 3));
  }
  return out;
};
// Loads discord.js from the installed app in a child process (exec form, no shell) and checks it exports a Client,
// without creating one or logging in. Resolving the path alone would pass a package that cannot load.
function discordModuleLoads() {
  let entry;
  try { entry = createRequire(path.join(P.app, 'package.json')).resolve('discord.js'); } catch { return { ok: false, why: 'not installed' }; }
  try {
    execFileSync(process.execPath, ['-e', 'const d = require(process.argv[1]); if (typeof d.Client !== "function") process.exit(3);', entry], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
    return { ok: true };
  } catch (e) { return { ok: false, why: e.status === 3 ? 'loads without a Client export' : 'installed but does not load' }; }
}
const DISCORD_INVITE = 'https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=68608';
async function cmdDiscord() {
  const sub = args._[1];
  if (sub !== 'setup' && sub !== 'disable') die('usage: synapse discord setup [--person <name>=<user id>]... [--channel <project>/<channel>=<channel id>]... [--cards <project>=<channel>] [--new-token] | synapse discord disable');
  if (!fs.existsSync(MARKER) || !fs.existsSync(P.config)) die('no Synapse home here; run "synapse init" first');
  if (sub === 'disable') {
    await withInstallLock(() => {
      const cfg = readJson(P.config);
      const discord = { ...(cfg.discord && typeof cfg.discord === 'object' ? cfg.discord : {}), enabled: false };
      applyWrites(withManifest(readManifest(), [{ file: P.config, text: jsonText({ ...cfg, discord }) }]));
    });
    console.log('synapse discord: off (mappings and token kept). Run "synapse restart" to apply.');
    return;
  }
  // The arguments, checked before anything is read or asked.
  const persons = repeated('person').map((spec) => {
    const m = /^([a-z][a-z0-9_-]{0,31})=(\d{17,20})$/.exec(spec);
    if (!m) die('--person takes <name>=<Discord user id> (17 to 20 digits); nothing was changed');
    return { name: m[1], id: m[2] };
  });
  const channelSpecs = repeated('channel').map((spec) => {
    const m = /^([a-z0-9][a-z0-9_-]{0,47})\/([a-z0-9_-]{1,32})=(\d{17,20})$/.exec(spec);
    if (!m) die('--channel takes <project>/<bus channel>=<Discord channel id>, for example my-app/code=<id>; nothing was changed');
    return { project: m[1], channel: m[2], id: m[3] };
  });
  const cardSpecs = repeated('cards').map((spec) => {
    const m = /^([a-z0-9][a-z0-9_-]{0,47})=([a-z0-9_-]{1,32})$/.exec(spec);
    if (!m) die('--cards takes <project>=<bus channel>; nothing was changed');
    return { project: m[1], channel: m[2] };
  });
  // The token is asked for before the install lock is taken, and only when there is none or a new one is wanted.
  const tokenEnvNow = (() => { try { const c = readJson(P.config); return (c.discord && c.discord.tokenEnv) || DEFAULT_DISCORD_TOKEN_ENV; } catch { return DEFAULT_DISCORD_TOKEN_ENV; } })();
  let token = null;
  if (args.flags['new-token'] || !readEnv().get(tokenEnvNow)) {
    console.log('[human] Paste the bot token from the Discord Developer Portal (your application > Bot > Reset Token). It is not shown and not printed.');
    token = (await readSecretLine('Discord bot token: ')).trim();
    const problem = discordTokenProblem(token);
    if (problem) die(`that does not look like a bot token (${problem}); nothing was changed`);
  }
  const mod = discordModuleLoads();
  if (!mod.ok) die(`discord.js ${mod.why} in ${P.app}. Run "npm ci" in the Synapse source folder (optional dependencies included), then "synapse init" again. Nothing was changed.`);
  let summary = null;
  await withInstallLock(() => {
    // Everything is read again under the lock, so a change made meanwhile is never overwritten by a stale copy.
    const m = readManifest();
    const cfg = readJson(P.config);
    const reg = readJson(P.projects);
    const env = readEnv();
    const discord = { enabled: false, ...(cfg.discord && typeof cfg.discord === 'object' ? cfg.discord : {}) };
    const tokenEnv = discord.tokenEnv || DEFAULT_DISCORD_TOKEN_ENV;
    if (tokenEnv !== tokenEnvNow) die('discord.tokenEnv changed while this command ran; run it again. Nothing was changed.');
    // Again under the lock: the app could have been swapped by another command since the first probe.
    const modNow = discordModuleLoads();
    if (!modNow.ok) die(`discord.js ${modNow.why} in ${P.app}. Run "npm ci" in the Synapse source folder (optional dependencies included), then "synapse init" again. Nothing was changed.`);
    // The bus takes a variable from its own environment before <home>/.env, so one set in this shell would win.
    if (process.env[tokenEnv] !== undefined && process.env[tokenEnv] !== (token || env.get(tokenEnv))) die(`${tokenEnv} is set in this shell's environment and would be used instead of the token in ${P.env} by a bus started from it; unset it, then run this again. Nothing was changed.`);
    const people = { ...(cfg.people || {}) };
    for (const p of persons) {
      if (!people[p.name]) die(`"${p.name}" is not in people; add them first (synapse set-human-key ${p.name} --role approver), then run this again. Nothing was changed.`);
      people[p.name] = { ...people[p.name], accounts: { ...(people[p.name].accounts || {}), discord: p.id } };
    }
    const projects = JSON.parse(JSON.stringify(discord.projects || {}));
    for (const c of channelSpecs) projects[c.project] = { ...(projects[c.project] || {}), channels: { ...((projects[c.project] && projects[c.project].channels) || {}), [c.channel]: c.id } };
    for (const c of cardSpecs) projects[c.project] = { ...(projects[c.project] || {}), cards: c.channel };
    const next = { ...cfg, people, discord: { ...discord, enabled: true, tokenEnv, projects } };
    // Every check the bus runs at boot, with the bus's environment order: the process first, then <home>/.env.
    const checkEnv = effectiveEnv(env, token ? { [tokenEnv]: token } : {});
    const findings = [...checkConfig(next), ...checkRegistry(reg, withDefaults(next), checkEnv), ...checkDiscord(next, reg, checkEnv)];
    const fatal = findings.filter((x) => x.level === 'fatal');
    if (fatal.length) die(`the bus would not start with this change; nothing was changed:\n  ${fatal.map((x) => x.message).join('\n  ')}`);
    const writes = [{ file: P.config, text: jsonText(next) }];
    if (token) writes.push({ file: P.env, text: envTextWith(tokenEnv, token), mode: 0o600 });
    applyWrites(withManifest(m, writes));
    if (token) protectFile(P.env);
    summary = {
      tokenEnv,
      mapped: Object.values(projects).reduce((n, p) => n + Object.keys((p && p.channels) || {}).length, 0),
      projects: Object.keys(projects).length,
      withIds: Object.values(people).filter((p) => p && p.accounts && p.accounts.discord).length,
      warnings: findings.filter((y) => y.level === 'warn').map((y) => y.message),
    };
  });
  console.log('synapse discord: on');
  ok(token ? `bot token stored in ${P.env} as ${summary.tokenEnv} (value not shown)` : `bot token: kept the one in ${P.env} (${summary.tokenEnv}); pass --new-token to replace it`);
  ok(`${summary.mapped} Discord channel(s) mapped for ${summary.projects} project(s); ${summary.withIds} person(s) with a Discord account id`);
  ok('discord.js loads from the app (not logged in; the connection is checked by "doctor --ready" after a restart)');
  for (const w of summary.warnings) warn(w);
  console.log('\nNext:');
  console.log(`  1. [human] invite the bot (once): ${DISCORD_INVITE}`);
  console.log('     (the Application ID is on the General Information page; 68608 = View Channels, Send Messages, Read Message History)');
  console.log('  2. synapse restart, then synapse doctor --ready');
}

function help() {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

const cmd = args._[0];
const commands = {
  init: cmdInit,
  'set-human-key': cmdSetHumanKey,
  'add-project': cmdAddProject,
  start: cmdStart,
  stop: async () => { if (!(await cmdStop())) process.exit(1); },
  restart: async () => { if (!(await cmdStop({ quiet: true }))) process.exit(1); args.flags.background = true; await cmdStart(); },
  doctor: cmdDoctor,
  uninstall: cmdUninstall,
  unlock: cmdUnlock,
  discord: cmdDiscord,
  help,
};
const run = commands[cmd];
if (!run) { help(); process.exit(cmd ? 1 : 0); }
await run();
