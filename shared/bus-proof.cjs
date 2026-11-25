'use strict';
/**
 * Proof of bus: before a client, a hook or the CLI sends a key, the process on the bus port must show it holds this
 * install's bus secret. Another local account can bind the port while the bus is down; it cannot read the secret.
 *
 *   secret  <home>/data/bus-secret: 64 hex characters, written once by the bus (0600, in the 0700 data folder) and
 *           reused across restarts. No route ever returns it.
 *   ask     GET /api/bus-proof?nonce=<64 hex>, with no key: a fresh random nonce per check.
 *   answer  { pid, instance, proof } where proof = HMAC-SHA256(secret, "synapse-bus-proof-v1\n<nonce>\n<pid>\n<instance>").
 *   verify  the caller recomputes the HMAC from the same file and compares in constant time; only then does it send a key.
 *
 * The pid and instance are bound into the proof, so the CLI can trust them to decide which process to stop.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SECRET_NAME = 'bus-secret';
const SECRET_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{64}$/;
const secretPath = (home) => path.join(home, 'data', SECRET_NAME);

// A secret file is used only when it is a regular file (never a link) and, on POSIX, owned by this user with no group or
// other access. Returns the secret, or null with nothing thrown.
function readSecretFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
      if (st.mode & 0o077) return null;
    }
    const s = fs.readFileSync(file, 'utf8').trim();
    return SECRET_RE.test(s) ? s : null;
  } catch { return null; }
}
const readSecret = (home) => readSecretFile(secretPath(home));

// The bus side: reuse the secret, or create it (exclusive create, 0600). A file that is there but unusable (a link, another
// owner, open permissions, bad content) stops the bus rather than being trusted or silently replaced.
function ensureSecret(dataDir) {
  const file = path.join(dataDir, SECRET_NAME);
  let exists = false;
  try { fs.lstatSync(file); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (exists) {
    const s = readSecretFile(file);
    if (!s) throw new Error(`${file} is not a private regular file holding a bus secret (a link, another owner, group or other access, or bad content); remove it and start the bus again`);
    return s;
  }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${s}\n`, { flag: 'wx', mode: 0o600 });
  return s;
}

const newNonce = () => crypto.randomBytes(32).toString('hex');
const proofFor = (secret, nonce, pid, instance) => crypto.createHmac('sha256', secret).update(`synapse-bus-proof-v1\n${nonce}\n${pid}\n${instance}`).digest('hex');

function verifyAnswer(secret, nonce, body) {
  if (!secret || !body || typeof body !== 'object') return false;
  const { proof, pid, instance } = body;
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof) || !Number.isInteger(pid) || typeof instance !== 'string' || !instance || instance.length > 64) return false;
  const want = Buffer.from(proofFor(secret, nonce, pid, instance), 'hex');
  return crypto.timingSafeEqual(want, Buffer.from(proof, 'hex'));
}

// The caller side. `get(url)` resolves { status, body } (the body parsed JSON, or null) and must send no key.
// Resolves { ok: true, pid, instance } or { ok: false, reason }.
async function proveBus({ httpUrl, home, get }) {
  const secret = readSecret(home);
  if (!secret) return { ok: false, reason: `no usable bus secret at ${secretPath(home)} (the bus writes it at its first start)` };
  const nonce = newNonce();
  let r;
  try { r = await get(`${String(httpUrl).replace(/\/+$/, '')}/api/bus-proof?nonce=${nonce}`); } catch (e) { return { ok: false, reason: `the bus did not answer (${(e && e.code) || 'error'})` }; }
  if (!r || r.status !== 200 || !verifyAnswer(secret, nonce, r.body)) return { ok: false, reason: 'the process on the bus port did not prove it is this Synapse bus' };
  return { ok: true, pid: r.body.pid, instance: r.body.instance };
}

module.exports = { SECRET_NAME, NONCE_RE, secretPath, readSecret, ensureSecret, newNonce, proofFor, verifyAnswer, proveBus };
