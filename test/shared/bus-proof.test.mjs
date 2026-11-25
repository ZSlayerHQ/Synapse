// Regression for audit run-2 finding 1: keys go only to a process that proves it is this install's bus. An impostor on
// the configured port (a plain listener, or one answering proofs under another secret) receives no key from the MCP
// client, the hooks or `synapse doctor`. Every server here is on a random 4600-4999 port; every secret is a dummy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startBus } from '../helpers/bus.mjs';
import { childEnv, tempHome, bindHome, answerBusProof, listenInRange, closeServer, CLIENT_INDEX } from '../client/helpers.mjs';

const require = createRequire(import.meta.url);
const busProof = require('../../shared/bus-proof.cjs');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OTHER_SECRET = 'cd'.repeat(32);

// An impostor: answers health as healthy, the bus proof under the wrong secret (or not at all), and 200 {} to the rest.
async function impostor({ answersProof = true } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (answersProof && answerBusProof(req, res, { secret: OTHER_SECRET })) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.startsWith('/api/health') ? JSON.stringify({ status: 'healthy', pid: 1 }) : '{}');
  });
  server.on('upgrade', (req, socket) => { seen.push({ url: req.url, headers: req.headers, upgrade: true }); socket.destroy(); });
  const port = await listenInRange(server);
  return { seen, port, close: () => closeServer(server) };
}
const sawKey = (seen, key) => seen.some((s) => JSON.stringify(s.headers).includes(key));
function run(cmd, args, { cwd, env, input, ms = 15000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), ms);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input !== undefined) child.stdin.end(input);
  });
}

test('the bus answers a nonce with an HMAC under its private secret, and never returns the secret or an instance in health', async () => {
  const fx = await startBus();
  try {
    const secret = busProof.readSecret(fx.home);
    assert.match(secret, /^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(busProof.secretPath(fx.home)).mode & 0o777, 0o600);
    const nonce = busProof.newNonce();
    const r = await fetch(`${fx.base}/api/bus-proof?nonce=${nonce}`);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(busProof.verifyAnswer(secret, nonce, body), true);
    assert.equal(busProof.verifyAnswer(secret, busProof.newNonce(), body), false, 'a proof is bound to its nonce');
    assert.ok(!JSON.stringify(body).includes(secret));
    assert.equal((await fetch(`${fx.base}/api/bus-proof?nonce=short`)).status, 400);
    const health = await (await fetch(`${fx.base}/api/health`)).json();
    assert.equal('instance' in health, false);
  } finally { await fx.close(); }
});

test('the MCP client sends no key to a process that cannot prove it is the bus', async () => {
  for (const answersProof of [true, false]) {
    const imp = await impostor({ answersProof });
    const proj = tempHome('synapse-proof-proj-');
    const home = bindHome(tempHome('synapse-proof-home-'), { port: imp.port, project: 'alpha', keyEnv: 'SYNAPSE_KEY_ALPHA', root: proj });
    const key = crypto.randomBytes(24).toString('base64url');
    try {
      const env = childEnv({ SYNAPSE_HOME: home, SYNAPSE_KEY_ALPHA: key, DEV_SYNC_RECONNECT_MS: '300' });
      delete env.SYNAPSE_MCP_IMPORT_ONLY;
      const r = await run(process.execPath, [CLIENT_INDEX, '--project', 'alpha', '--developer', 'alphabot'], { cwd: proj, env, ms: 2500 });
      assert.ok(imp.seen.some((s) => s.url.startsWith('/api/bus-proof')), 'the client asked for a proof');
      assert.equal(sawKey(imp.seen, key), false, `no key reached the impostor (answersProof=${answersProof})`);
      assert.match(r.stderr, /no key sent: /);
    } finally { await imp.close(); }
  }
});

test('the hooks send no key to a process that cannot prove it is the bus, and say so', async () => {
  const imp = await impostor();
  const proj = tempHome('synapse-proof-hproj-');
  const home = bindHome(tempHome('synapse-proof-hhome-'), { port: imp.port, project: 'alpha', keyEnv: 'SYNAPSE_KEY_ALPHA', root: proj });
  fs.mkdirSync(path.join(proj, '.synapse'));
  fs.writeFileSync(path.join(proj, '.synapse', 'config.json'), JSON.stringify({ project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_KEY_ALPHA' }));
  const key = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(path.join(home, '.env'), `SYNAPSE_KEY_ALPHA=${key}\n`);
  try {
    const env = { PATH: process.env.PATH, SYNAPSE_HOME: home };
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'windir']) if (process.env[k]) env[k] = process.env[k];
    const checkin = await run(process.execPath, [path.join(REPO, 'hooks', 'session-checkin.cjs')], { env, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', cwd: proj }) });
    const post = await run(process.execPath, [path.join(REPO, 'hooks', 'post-sync.cjs')], { env, input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', cwd: proj, tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'a.js') } }) });
    assert.equal(sawKey(imp.seen, key), false, 'no key reached the impostor');
    assert.match(JSON.parse(checkin.stdout.trim()).hookSpecificOutput.additionalContext, /bus_unproven.*did not prove it is this Synapse bus.*no key was sent/);
    assert.match(JSON.parse(post.stdout.trim()).systemMessage, /no key was sent/);
  } finally { await imp.close(); }
});

test('synapse doctor sends no key to a process that cannot prove it is the bus, and fails on it', async () => {
  const imp = await impostor();
  const home = tempHome('synapse-proof-dhome-');
  const proj = tempHome('synapse-proof-dproj-');
  const key = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(path.join(home, '.synapse-home'), '');
  fs.writeFileSync(path.join(home, 'synapse.config.json'), JSON.stringify({ version: 2, server: { host: '127.0.0.1', port: imp.port }, people: { owner1: {} }, owners: ['owner1'] }));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { alpha: { keyEnv: 'SYNAPSE_KEY_ALPHA', root: proj.replace(/\\/g, '/'), assertableBots: ['alphabot'] } } }));
  fs.writeFileSync(path.join(home, '.env'), `SYNAPSE_KEY_ALPHA=${key}\n`, { mode: 0o600 });
  fs.mkdirSync(path.join(proj, '.synapse'));
  fs.writeFileSync(path.join(proj, '.synapse', 'config.json'), JSON.stringify({ project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_KEY_ALPHA' }));
  try {
    const env = childEnv({ SYNAPSE_HOME: home });
    delete env.SYNAPSE_KEY_ALPHA;
    const r = await run(process.execPath, [path.join(REPO, 'bin', 'synapse.mjs'), 'doctor', '--home', home], { env, ms: 30000 });
    assert.match(r.stdout, /bus identity NOT proven/);
    assert.equal(sawKey(imp.seen, key), false, 'no key reached the impostor');
    assert.notEqual(r.code, 0);
  } finally { await imp.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true }); }
});
