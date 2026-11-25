/**
 * Shared helper for the Synapse Claude Code hooks: configuration, identity, the HTTP client, hook input and output.
 *
 * Project: the nearest <dir>/.synapse/config.json walking up from the hook's working directory ({ project, developer,
 * keyEnv }; no secrets; written by `synapse add-project`). That folder is the project root for lock paths.
 * Trust: that file is repository content (a branch, a clone or a vendored folder can carry one), so it only NAMES a
 * project and a bot. It is used only when the home registry (<home>/projects.json) holds that project with its root at
 * exactly that folder, and its keyEnv, if given, is the one the registry binds for that bot. Otherwise the hook sends
 * nothing and says why on stdout. A project config can never name a URL.
 * Identity: the seat the session's MCP client is using, read from <home>/data/seats/<hash of session_id>.json (the
 * client writes it), so a lock taken through the client and the hook's pre-edit check name the same seat. Without that
 * file: DEV_SYNC_DEVELOPER or the config's developer, plus a named DEV_SYNC_SEAT suffix.
 * Key: only the variable the registry binds (the bot's own roster keyEnv, else the project's), from the environment,
 * else <home>/.env. No other variable is ever read for a key.
 * URL: only the home config's server.host and server.port (<home>/synapse.config.json). DEV_SYNC_URL is not used here.
 * Proof of bus: before the first keyed request, the process on that port must answer a fresh nonce with an HMAC under the
 * home's bus secret (shared/bus-proof.cjs). A hook is one short process, so the proof is checked once per process and
 * never reused by the next one (which may meet a restarted bus); a failed proof sends no key and faults "bus_unproven".
 *
 * Output follows the Claude Code hook contract: context for Claude goes to stdout as JSON
 * ({ hookSpecificOutput: { hookEventName, additionalContext } }); stderr on exit 0 is never shown to Claude, so it is
 * used only for the exit-2 block message. Every request has a 2 second timeout; a down bus never blocks an edit.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { lockKey, caseInsensitiveAt } = require('../../shared/lock-key.cjs');
const busProof = require('../../shared/bus-proof.cjs');

const TIMEOUT_MS = 2000;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ownEntry = (obj, k) => (isObj(obj) && typeof k === 'string' && Object.hasOwn(obj, k) ? obj[k] : undefined);

// One folder, by the CLI's rule (add-project writes the root with forward slashes); case-insensitive where the OS is.
function samePath(a, b) {
  const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/');
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const eq = (x, y) => (ci ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (eq(norm(a), norm(b))) return true;
  try { return eq(norm(fs.realpathSync.native(String(a))), norm(fs.realpathSync.native(String(b)))); } catch { return false; }
}

// The bus address from the home config only: a project file never chooses where a key goes.
function homeBusUrl(server) {
  let host = typeof server.host === 'string' && server.host.trim() ? server.host.trim() : '127.0.0.1';
  if (host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  const port = Number.isInteger(server.port) && server.port > 0 && server.port < 65536 ? server.port : 4560;
  return `http://${host}:${port}`;
}

function findProjectRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.synapse', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveHome(env) {
  if (env.SYNAPSE_HOME) return path.resolve(env.SYNAPSE_HOME);
  // Installed layout: <home>/app/hooks/lib/synapse-hook.cjs
  const candidate = path.resolve(__dirname, '..', '..', '..');
  if (path.basename(path.resolve(__dirname, '..', '..')) === 'app' && fs.existsSync(path.join(candidate, 'synapse.config.json'))) return candidate;
  return path.join(os.homedir(), '.synapse');
}

function parseEnvText(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The seat file name rule, shared with the MCP client: the first 32 hex characters of sha256(session id).
function seatFileName(sessionId) {
  return `${crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32)}.json`;
}

// Checks a project config against the home registry. Returns { keyEnv } when the registry binds this folder to the
// named project and the config agrees with it, else { refused: <reason> }.
function bindToRegistry(local, root, home) {
  if (!isObj(local)) return { refused: '.synapse/config.json is not a JSON object' };
  if (Object.hasOwn(local, 'url')) return { refused: '.synapse/config.json names a bus URL; hooks use only the bus in the Synapse home config' };
  const project = local.project;
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) return { refused: '.synapse/config.json names no valid project' };
  const registry = readJson(path.join(home, 'projects.json'));
  const reg = ownEntry(registry && registry.projects, project);
  if (!isObj(reg)) return { refused: `project "${project}" is not in the Synapse home registry` };
  if (typeof reg.root !== 'string' || !reg.root || !samePath(reg.root, root)) return { refused: `the Synapse home registry binds project "${project}" to another folder` };
  const bot = typeof local.developer === 'string' ? local.developer : '';
  const own = ownEntry(reg.roster, bot);
  const keyEnv = (isObj(own) && typeof own.keyEnv === 'string' && own.keyEnv) || reg.keyEnv;
  if (typeof keyEnv !== 'string' || !ENV_NAME_RE.test(keyEnv)) return { refused: `the Synapse home registry has no key for project "${project}"` };
  if (local.keyEnv !== undefined && local.keyEnv !== keyEnv) return { refused: `.synapse/config.json keyEnv ${String(local.keyEnv).slice(0, 64)} disagrees with the Synapse home registry (${keyEnv})` };
  return { keyEnv };
}

function loadConfig({ cwd = process.cwd(), env = process.env, sessionId = null } = {}) {
  const root = findProjectRoot(cwd);
  const localRaw = root ? readJson(path.join(root, '.synapse', 'config.json')) : null;
  const local = isObj(localRaw) ? localRaw : {};
  const home = resolveHome(env);
  const homeCfg = readJson(path.join(home, 'synapse.config.json')) || {};
  const server = isObj(homeCfg.server) ? homeCfg.server : {};
  const binding = root ? bindToRegistry(localRaw, root, home) : { refused: null };
  const keyEnv = binding.keyEnv || null;
  let key = keyEnv ? env[keyEnv] : undefined;
  if (keyEnv && !key) {
    try { key = parseEnvText(fs.readFileSync(path.join(home, '.env'), 'utf8'))[keyEnv]; } catch { key = undefined; }
  }
  const warnings = [];
  let developer = env.DEV_SYNC_DEVELOPER || (typeof local.developer === 'string' && local.developer) || 'unknown';
  let seatSource = 'config';
  const seatFile = sessionId ? readJson(path.join(home, 'data', 'seats', seatFileName(sessionId))) : null;
  if (seatFile && typeof seatFile.developer === 'string' && seatFile.developer && (!seatFile.project || seatFile.project === local.project)) {
    developer = seatFile.developer;
    seatSource = 'client';
  } else {
    const seat = String(env.DEV_SYNC_SEAT || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
    if (seat === 'auto') {
      warnings.push(`DEV_SYNC_SEAT=auto: this hook could not find the session's seat, so it acts as "${developer}" and may not match the MCP client's seat; locks taken through the client could block this session's own edits. Use a named seat (DEV_SYNC_SEAT=<name>).`);
    } else if (seat && /^[a-z0-9]/.test(seat) && !developer.includes('.')) developer = `${developer}.${seat}`;
  }
  const configured = !!keyEnv;
  return { root, home, project: typeof local.project === 'string' ? local.project : null, developer, seatSource, keyEnv,
    key: configured && typeof key === 'string' ? key : '', url: homeBusUrl(server), configured, refused: binding.refused || null, warnings };
}

async function readHookInput() {
  let payload = null;
  let raw = '';
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    try { payload = JSON.parse(raw); } catch { payload = null; }
  }
  const input = (payload && payload.tool_input) || {};
  return {
    payload,
    event: (payload && payload.hook_event_name) || '',
    sessionId: (payload && payload.session_id) || null,
    toolName: (payload && payload.tool_name) || process.env.CLAUDE_TOOL_NAME || '',
    filePath: input.file_path || process.env.CLAUDE_FILE_PATH || '',
    command: input.command || process.env.CLAUDE_BASH_COMMAND || '',
    cwd: (payload && payload.cwd) || process.cwd(),
  };
}

// Read the hook input, then resolve the configuration for that session and folder.
async function init() {
  const input = await readHookInput();
  const config = loadConfig({ cwd: input.cwd, sessionId: input.sessionId });
  return { input, config, ...client(config) };
}

function client(config) {
  function requestOptions(method, apiPath, data) {
    const u = new URL(config.url + apiPath);
    const isHttps = u.protocol === 'https:';
    const headers = { 'Content-Type': 'application/json', 'X-Dev-Key': config.key };
    if (config.project) headers['X-Dev-Project'] = config.project;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    return { transport: isHttps ? https : http, opts: { hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method, timeout: TIMEOUT_MS, headers } };
  }
  // One proof per hook process (see the header). Its GET carries no key.
  let proof = null;
  function proven() {
    if (!proof) {
      const get = (url) => new Promise((resolve, reject) => {
        const u = new URL(url);
        const transport = u.protocol === 'https:' ? https : http;
        const req = transport.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', timeout: TIMEOUT_MS }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => { let parsed = null; try { parsed = JSON.parse(text); } catch {} resolve({ status: res.statusCode || 0, body: parsed }); });
        });
        req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('timeout'), { code: 'timeout' })); });
        req.on('error', reject);
        req.end();
      });
      proof = busProof.proveBus({ httpUrl: config.url, home: config.home, get });
    }
    return proof;
  }
  // Resolves the parsed body, or { __fault } on a non-2xx status, timeout, transport error, bad JSON or an unproven bus.
  async function request(method, apiPath, body) {
    if (!config.project || !config.key) return { __fault: 'not_configured' };
    const p = await proven();
    if (!p.ok) return { __fault: 'bus_unproven', reason: p.reason };
    return send(method, apiPath, body);
  }
  function send(method, apiPath, body) {
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : '';
      const { transport, opts } = requestOptions(method, apiPath, data);
      const req = transport.request(opts, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) { resolve({ __fault: `http_${status}` }); return; }
          if (!text) { resolve({}); return; }
          try { resolve(JSON.parse(text)); } catch { resolve({ __fault: 'invalid_json' }); }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ __fault: 'timeout' }); });
      req.on('error', (err) => resolve({ __fault: (err && err.code) || 'transport' }));
      if (data) req.write(data);
      req.end();
    });
  }
  return { request };
}

// Structured output for Claude: context for the model, an optional message for the person. Resolves once written.
function emit(event, { context, systemMessage } = {}) {
  const out = {};
  if (context) out.hookSpecificOutput = { hookEventName: event, additionalContext: context };
  if (systemMessage) out.systemMessage = systemMessage;
  if (!Object.keys(out).length) return Promise.resolve();
  return new Promise((resolve) => process.stdout.write(JSON.stringify(out) + '\n', () => resolve()));
}

// A project config the home registry does not back: the hook sent nothing, and says so (stdout JSON, exit 0).
// SessionEnd takes no additionalContext, so it gets the person-facing message only.
function emitRefusal(event, config) {
  if (!config || !config.refused) return Promise.resolve();
  const text = `Synapse hook did nothing: ${config.refused}. A project's .synapse/config.json is repository content, so it is used only when the Synapse home registry binds this folder to that project; run "synapse doctor" here.`;
  return emit(event, { context: event === 'SessionEnd' ? undefined : text, systemMessage: text });
}

// One field of a line of model context: control characters become visible escapes (\n, \r, \uXXXX) and the Unicode line
// and paragraph separators a space, so a bus field (an alert message, a seat's workingOn, a lock's file) can never start
// a line of its own and pose as another entry or another sender. Long fields are capped.
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
function inline(v, max = 1000) {
  let s = String(v === undefined || v === null ? '' : v);
  for (const sep of LINE_SEPARATORS) s = s.split(sep).join(' ');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? ' ' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Blank out quoted segments so prose inside a commit message cannot impersonate a command.
function stripQuoted(s) {
  return String(s).replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""').replace(/'(?:[^'\\]|\\[\s\S])*'/g, "''");
}

// The lock key the bus uses for this file (shared/lock-key.cjs): relative to the project root inside it, the full
// absolute path outside it. A relative tool path is relative to the hook's working folder.
function rootRelative(root, filePath) {
  if (!filePath) return '';
  return lockKey(root, path.resolve(String(filePath)), { caseInsensitive: caseInsensitiveAt(root) });
}

module.exports = { init, loadConfig, client, emit, emitRefusal, inline, readHookInput, stripQuoted, rootRelative, parseEnvText, seatFileName, findProjectRoot };
