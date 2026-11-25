'use strict';
// The one lock-key policy, used by the bus (server/server.mjs) and the hooks (hooks/lib/synapse-hook.cjs), so a lock taken
// through one is seen by the other. Pure string work plus one cached file-system probe for case sensitivity.
//
// lockKey(root, file, { caseInsensitive }) -> the canonical path of `file`:
//   - separators become "/"; ".", "" and ".." segments are resolved lexically (a symlink is not followed);
//   - a relative `file` is relative to `root`;
//   - a file inside `root` (compared whole segment by whole segment) becomes its path relative to `root`;
//   - any other file keeps its full absolute path ("C:/x/y", "//server/share/x", "/x/y"), never just its basename;
//   - with no root, a relative path stays relative (normalized; a leading ".." is kept).
// The key keeps the spelling it was given; caseInsensitive only changes how the root is matched. foldKey() gives the
// identity two spellings share. lockKey is idempotent: lockKey(root, lockKey(root, f)) === lockKey(root, f).
//
// caseInsensitiveAt(root) asks the project's own folder: it compares <root>/.synapse with <root>/.SYNAPSE. Without that
// folder it falls back to the OS default (Windows and macOS insensitive). A subfolder with its own case setting is not
// detected.
const fs = require('node:fs');
const path = require('node:path');

const toSlash = (p) => String(p).replace(/\\/g, '/');

// The absolute prefix of a slash path, or null when the path is relative.
function splitAbs(p) {
  let m = /^([A-Za-z]):(\/|$)/.exec(p);
  if (m) return { prefix: `${m[1].toUpperCase()}:`, rest: p.slice(2) };
  m = /^\/\/([^/]+)\/([^/]+)/.exec(p);
  if (m) return { prefix: `//${m[1]}/${m[2]}`, rest: p.slice(m[0].length) };
  if (p.startsWith('/')) return { prefix: '', rest: p };
  return null;
}

// Resolve "." and ".." lexically. Absolute: ".." stops at the top. Relative: a leading ".." is kept.
function resolveSegments(segments, absolute) {
  const out = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(s);
  }
  return out;
}

function lockKey(root, file, { caseInsensitive = false } = {}) {
  const raw = toSlash(file == null ? '' : file);
  if (!raw) return '';
  const same = caseInsensitive ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  const r = root ? splitAbs(toSlash(root)) : null;
  const abs = splitAbs(raw);
  if (!abs && !r) return resolveSegments(raw.split('/'), false).join('/') || '.';
  const prefix = abs ? abs.prefix : r.prefix;
  const parts = abs ? resolveSegments(abs.rest.split('/'), true) : resolveSegments([...r.rest.split('/'), ...raw.split('/')], true);
  if (r) {
    const rootParts = resolveSegments(r.rest.split('/'), true);
    const inside = same(prefix, r.prefix) && rootParts.length <= parts.length && rootParts.every((s, i) => same(s, parts[i]));
    if (inside) return parts.slice(rootParts.length).join('/') || '.';
  }
  return `${prefix}/${parts.join('/')}`;
}

const foldKey = (key, caseInsensitive) => (caseInsensitive ? String(key).toLowerCase() : String(key));

const OS_DEFAULT_CI = process.platform === 'win32' || process.platform === 'darwin';
const caseCache = new Map();
function caseInsensitiveAt(root) {
  if (!root) return OS_DEFAULT_CI;
  const k = String(root);
  if (caseCache.has(k)) return caseCache.get(k);
  let ci = OS_DEFAULT_CI;
  try {
    const a = fs.statSync(path.join(k, '.synapse'), { bigint: true });
    try {
      const b = fs.statSync(path.join(k, '.SYNAPSE'), { bigint: true });
      ci = a.ino === b.ino && a.dev === b.dev;
    } catch { ci = false; }
  } catch { /* no .synapse folder: the OS default */ }
  caseCache.set(k, ci);
  return ci;
}

module.exports = { lockKey, foldKey, caseInsensitiveAt, splitAbs };
