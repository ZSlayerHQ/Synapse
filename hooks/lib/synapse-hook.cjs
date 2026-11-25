/**
 * Shared helper for the Synapse Claude Code hooks: configuration, identity, the HTTP client, hook input and output.
 *
 * Project: the nearest <dir>/.synapse/config.json walking up from the hook's working directory ({ project, developer,
 * keyEnv, url? }; no secrets; written by `synapse add-project`). That folder is the project root for lock paths.
 * Identity: the seat the session's MCP client is using, read from <home>/data/seats/<hash of session_id>.json (the
 * client writes it), so a lock taken through the client and the hook's pre-edit check name the same seat. Without that
 * file: DEV_SYNC_DEVELOPER or the config's developer, plus a named DEV_SYNC_SEAT suffix.
 * Key: the environment variable named by keyEnv; when unset, <home>/.env, the same file the MCP client reads.
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

const TIMEOUT_MS = 2000;

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

function loadConfig({ cwd = process.cwd(), env = process.env, sessionId = null } = {}) {
  const root = findProjectRoot(cwd);
  const local = (root && readJson(path.join(root, '.synapse', 'config.json'))) || {};
  const home = resolveHome(env);
  const homeCfg = readJson(path.join(home, 'synapse.config.json')) || {};
  const server = homeCfg.server || {};
  const keyEnv = typeof local.keyEnv === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(local.keyEnv) ? local.keyEnv : 'DEV_SYNC_KEY';
  let key = env[keyEnv];
  if (!key) {
    try { key = parseEnvText(fs.readFileSync(path.join(home, '.env'), 'utf8'))[keyEnv]; } catch { key = undefined; }
  }
  const warnings = [];
  let developer = env.DEV_SYNC_DEVELOPER || local.developer || 'unknown';
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
  const url = (env.DEV_SYNC_URL && env.DEV_SYNC_URL.replace(/^ws(s?):/, 'http$1:').replace(/\/ws\/?$/, ''))
    || local.url
    || `http://${server.host || '127.0.0.1'}:${server.port || 4560}`;
  return { root, home, project: env.DEV_SYNC_PROJECT || local.project || null, developer, seatSource, keyEnv, key: key || '', url: url.replace(/\/+$/, ''), configured: !!local.project, warnings };
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
  // Resolves the parsed body, or { __fault } on a non-2xx status, timeout, transport error or bad JSON.
  function request(method, apiPath, body) {
    return new Promise((resolve) => {
      if (!config.project || !config.key) { resolve({ __fault: 'not_configured' }); return; }
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

module.exports = { init, loadConfig, client, emit, readHookInput, stripQuoted, rootRelative, parseEnvText, seatFileName, findProjectRoot };
