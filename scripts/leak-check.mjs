#!/usr/bin/env node
// leak-check: refuse content that carries a secret, an owner-specific term or a token.
//
// Three checks:
//   (a) exact values from secret files on this machine (.env files, ~/.claude.json MCP env blocks,
//       ~/.cloudflare/*.env, $SYNAPSE_HOME/.env, plus any "@secrets <path>" named in the deny-list);
//   (b) terms from a deny-list kept OUTSIDE the repo (default ~/.synapse-leak-denylist.txt);
//   (c) generic token patterns (Discord bot tokens, sk-, GitHub tokens, AWS keys, webhook URLs, private keys).
//
// It never prints a secret value or a deny-list term: a hit names the file, the line, and the
// variable name or the deny-list entry number.
//
// Usage:
//   node scripts/leak-check.mjs                 scan the index (every tracked + staged file)  [default]
//   node scripts/leak-check.mjs --worktree      scan tracked + untracked-not-ignored files on disk
//   node scripts/leak-check.mjs --rev <rev>     scan the tree and message of one commit
//   node scripts/leak-check.mjs --history       scan every commit reachable from any ref
//   node scripts/leak-check.mjs --message <f>   scan a commit message file (commit-msg hook)
//   node scripts/leak-check.mjs --paths a b     scan the named files on disk (used by the tests)
//   --require-denylist   fail when the deny-list file is missing (the owner's pre-commit hook sets it)
//   --require-secrets    fail when no secret value could be loaded
//   --quiet              print only hits and the verdict
//
// Deny-list format, one entry per line:
//   term              case-insensitive substring
//   word:term         case-insensitive, whole word only (for short names)
//   re:pattern        case-insensitive regular expression
//   @secrets <path>   another KEY=VALUE secret file to load for check (a)
//   @allow-path <p>   skip check (b) for this repo path (exact match); (a) and (c) still apply
//   # comment
//
// Inline marker: a line containing "leak-check: allow-pattern" is exempt from check (c) only.
// Exit codes: 0 clean, 1 hits found, 2 setup error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const quiet = flag('--quiet');
const log = (...m) => { if (!quiet) console.log(...m); };

const MIN_SECRET_LEN = 10;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

// ---------- secret sources ----------

function parseEnvText(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out.push([m[1], v]);
  }
  return out;
}

function isSecretWorthy(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < MIN_SECRET_LEN) return false;
  if (/^(true|false|null|undefined|yes|no|on|off)$/i.test(s)) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?\/?$/i.test(s)) return false;
  if (/^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/ws)?\/?$/i.test(s)) return false;
  return true;
}

function loadSecrets(extraFiles) {
  const home = os.homedir();
  const secrets = []; // { value, name, source }
  const sources = []; // { source, count, missing }
  const add = (source, pairs) => {
    let n = 0;
    for (const [name, value] of pairs) {
      if (!isSecretWorthy(value)) continue;
      secrets.push({ value: value.trim(), name, source });
      n++;
    }
    sources.push({ source, count: n });
  };
  const envFile = (p) => {
    if (!fs.existsSync(p)) { sources.push({ source: path.basename(p), missing: true }); return; }
    try { add(path.basename(path.dirname(p)) + '/' + path.basename(p), parseEnvText(fs.readFileSync(p, 'utf8'))); }
    catch { sources.push({ source: path.basename(p), unreadable: true }); }
  };

  // ~/.claude.json: every mcpServers.*.env value, wherever the block sits.
  const cj = path.join(home, '.claude.json');
  if (fs.existsSync(cj)) {
    try {
      const pairs = [];
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (k === 'mcpServers' && v && typeof v === 'object') {
            for (const [srv, s] of Object.entries(v)) {
              if (s && s.env && typeof s.env === 'object') {
                for (const [ek, ev] of Object.entries(s.env)) pairs.push([`${srv}.${ek}`, String(ev)]);
              }
              if (s && s.headers && typeof s.headers === 'object') {
                for (const [hk, hv] of Object.entries(s.headers)) pairs.push([`${srv}.header.${hk}`, String(hv)]);
              }
            }
          } else walk(v);
        }
      };
      walk(JSON.parse(fs.readFileSync(cj, 'utf8')));
      add('.claude.json (mcpServers env)', pairs);
    } catch { sources.push({ source: '.claude.json', unreadable: true }); }
  }

  // ~/.cloudflare/*.env
  const cf = path.join(home, '.cloudflare');
  if (fs.existsSync(cf)) {
    for (const f of fs.readdirSync(cf)) if (f.endsWith('.env')) envFile(path.join(cf, f));
  }

  // An installed Synapse home.
  const sh = process.env.SYNAPSE_HOME || path.join(home, '.synapse');
  if (fs.existsSync(path.join(sh, '.env'))) envFile(path.join(sh, '.env'));

  for (const p of extraFiles) envFile(p);

  // Longest first, so a value that contains another reports under the longer one.
  secrets.sort((a, b) => b.value.length - a.value.length);
  return { secrets, sources };
}

// ---------- deny-list ----------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadDenylist() {
  const p = process.env.SYNAPSE_LEAK_DENYLIST || path.join(os.homedir(), '.synapse-leak-denylist.txt');
  if (!fs.existsSync(p)) return { found: false, path: p, terms: [], secretFiles: [], allowPaths: new Set() };
  const terms = [];
  const secretFiles = [];
  const allowPaths = new Set();
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const entry = i + 1;
    if (line.startsWith('@secrets ')) { secretFiles.push(line.slice(9).trim()); return; }
    if (line.startsWith('@allow-path ')) { allowPaths.add(line.slice(12).trim().replace(/\\/g, '/')); return; }
    let re;
    try {
      if (line.startsWith('re:')) re = new RegExp(line.slice(3), 'i');
      else if (line.startsWith('word:')) re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(line.slice(5))}(?![A-Za-z0-9])`, 'i');
      else re = new RegExp(escapeRe(line), 'i');
    } catch {
      console.error(`leak-check: deny-list entry ${entry} is not a valid pattern; skipped`);
      return;
    }
    terms.push({ entry, re });
  });
  return { found: true, path: p, terms, secretFiles, allowPaths };
}

// ---------- token patterns ----------

const PATTERNS = [
  ['discord-bot-token', /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/],
  ['discord-webhook-url', /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,}\/[A-Za-z0-9_-]{20,}/i],
  ['slack-webhook-url', /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/],
  ['sk-api-key', /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
];
const ALLOW_MARK = 'leak-check: allow-pattern';

// ---------- content sources ----------

function git(argv, opts = {}) {
  return execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function readBlobs(shas) {
  // git cat-file --batch: "<sha> blob <size>\n<content>\n"
  if (shas.length === 0) return new Map();
  const r = spawnSync('git', ['cat-file', '--batch'], { input: shas.join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('git cat-file failed');
  const buf = r.stdout;
  const out = new Map();
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(10, off);
    if (nl < 0) break;
    const header = buf.subarray(off, nl).toString('utf8');
    const [sha, type, sizeStr] = header.split(' ');
    if (type === 'missing') { off = nl + 1; continue; }
    const size = Number(sizeStr);
    out.set(sha, buf.subarray(nl + 1, nl + 1 + size));
    off = nl + 1 + size + 1;
  }
  return out;
}

function indexEntries() {
  // "<mode> <sha> <stage>\t<path>" NUL-separated
  const raw = git(['ls-files', '-s', '-z']);
  return raw.split('\0').filter(Boolean).map((l) => {
    const [meta, p] = l.split('\t');
    const [mode, sha] = meta.split(' ');
    return { path: p, sha, mode };
  }).filter((e) => e.mode !== '160000');
}

function treeEntries(rev) {
  const raw = git(['ls-tree', '-r', '-z', rev]);
  return raw.split('\0').filter(Boolean).map((l) => {
    const [meta, p] = l.split('\t');
    const [mode, type, sha] = meta.split(' ');
    return { path: p, sha, mode, type };
  }).filter((e) => e.type === 'blob');
}

// ---------- scanning ----------

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function scanText(label, buf, ctx, hits, repoPath = label) {
  if (buf.length > MAX_SCAN_BYTES) { hits.push({ where: label, what: `file larger than ${MAX_SCAN_BYTES} bytes, not scanned (review by hand)` }); return; }
  const binary = isBinary(buf);
  const text = buf.toString(binary ? 'latin1' : 'utf8');
  const lines = text.split(/\r?\n/);
  const allowB = ctx.allowPaths.has(String(repoPath).replace(/\\/g, '/'));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = binary ? `${label} (binary)` : `${label}:${i + 1}`;
    for (const s of ctx.secrets) {
      if (line.includes(s.value)) { hits.push({ where, what: `secret value of ${s.name} from ${s.source}` }); break; }
    }
    if (!binary && !allowB) {
      for (const t of ctx.terms) {
        if (t.re.test(line)) hits.push({ where, what: `deny-list entry ${t.entry}` });
      }
    }
    if (!line.includes(ALLOW_MARK)) {
      for (const [name, re] of PATTERNS) if (re.test(line)) hits.push({ where, what: `token pattern ${name}` });
    }
  }
}

function main() {
  const deny = loadDenylist();
  if (!deny.found && flag('--require-denylist')) {
    console.error(`leak-check: deny-list file not found (${path.basename(deny.path)} in the home folder, or SYNAPSE_LEAK_DENYLIST). Refusing.`);
    process.exit(2);
  }
  const { secrets, sources } = loadSecrets(deny.secretFiles);
  if (secrets.length === 0 && flag('--require-secrets')) {
    console.error('leak-check: no secret values could be loaded and --require-secrets is set. Refusing.');
    process.exit(2);
  }
  const ctx = { secrets, terms: deny.terms, allowPaths: deny.allowPaths };
  log(`leak-check: ${secrets.length} secret values from ${sources.filter((s) => !s.missing).length} sources` +
    `${sources.some((s) => s.missing) ? ` (${sources.filter((s) => s.missing).length} named source(s) missing)` : ''}; ` +
    `deny-list ${deny.found ? `${deny.terms.length} terms` : 'NOT FOUND (check (b) skipped)'}; ${PATTERNS.length} token patterns`);

  const hits = [];
  let scanned = 0;

  if (opt('--message')) {
    scanText('commit message', fs.readFileSync(opt('--message')), ctx, hits);
    scanned = 1;
  } else if (flag('--paths')) {
    const list = args.slice(args.indexOf('--paths') + 1).filter((a) => !a.startsWith('--'));
    for (const p of list) { scanText(p, fs.readFileSync(p), ctx, hits); scanned++; }
  } else if (flag('--worktree')) {
    const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    for (const f of [...new Set(files)]) {
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) continue;
      scanText(f, fs.readFileSync(f), ctx, hits); scanned++;
    }
  } else if (opt('--rev') || flag('--history')) {
    const revs = flag('--history') ? git(['rev-list', '--all']).split('\n').filter(Boolean) : [git(['rev-parse', opt('--rev')]).trim()];
    const seen = new Set();
    for (const rev of revs) {
      const short = rev.slice(0, 8);
      scanText(`${short} commit message`, Buffer.from(git(['log', '-1', '--format=%B', rev])), ctx, hits);
      const entries = treeEntries(rev).filter((e) => !seen.has(e.sha + e.path));
      entries.forEach((e) => seen.add(e.sha + e.path));
      const blobs = readBlobs([...new Set(entries.map((e) => e.sha))]);
      for (const e of entries) { scanText(`${short}:${e.path}`, blobs.get(e.sha) || Buffer.alloc(0), ctx, hits, e.path); scanned++; }
    }
  } else {
    const entries = indexEntries();
    const blobs = readBlobs([...new Set(entries.map((e) => e.sha))]);
    for (const e of entries) { scanText(e.path, blobs.get(e.sha) || Buffer.alloc(0), ctx, hits); scanned++; }
  }

  if (hits.length) {
    for (const h of hits) console.log(`  LEAK ${h.where}: ${h.what}`);
    console.log(`leak-check: FAIL, ${hits.length} hit(s) in ${scanned} file(s) scanned`);
    process.exit(1);
  }
  console.log(`leak-check: PASS, ${scanned} file(s) scanned`);
}

try {
  main();
} catch (err) {
  console.error(`leak-check: error: ${err.message}`);
  process.exit(2);
}
