// Regression for the security audit (run-1): a project's .synapse/config.json is repository content, so it can never
// choose which secret a hook sends or where. The hooks send the registry-bound key, only to the home config's bus URL,
// and a project config that disagrees with the home registry makes the hook do nothing and say so on stdout.
// The hooks run as real child processes against two capture servers on random 4600-4999 ports; every secret is a dummy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { answerBusProof, writeBusSecret } from '../client/helpers.mjs';

const require = createRequire(import.meta.url);
const lib = require('../../hooks/lib/synapse-hook.cjs');
const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
const dummy = () => randomBytes(24).toString('base64url');
const fwd = (p) => p.replace(/\\/g, '/');

// A capture server: records each request's path and headers. Never answers with anything a hook acts on.
// `proves`: the server answers the bus proof with the fixture home's secret, as the real bus would.
async function capture({ proves = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (proves && answerBusProof(req, res)) return;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ path: req.url, headers: req.headers, body }); res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"safe":true,"severity":"none"}'); });
  });
  for (let i = 0; i < 20; i++) {
    const port = 4600 + Math.floor(Math.random() * 400);
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      return { seen, port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
    } catch { /* port taken: draw again */ }
  }
  throw new Error('no free port in 4600-4999');
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-hookbind-'));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'proj');
  fs.mkdirSync(home);
  writeBusSecret(home);
  fs.mkdirSync(path.join(proj, '.synapse'), { recursive: true });
  const secrets = { SYNAPSE_KEY_ALPHA: dummy(), SYNAPSE_KEY_BETA: dummy(), SYNAPSE_DISCORD_TOKEN: dummy() };
  fs.writeFileSync(path.join(home, '.env'), Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: {
    alpha: { keyEnv: 'SYNAPSE_KEY_ALPHA', root: fwd(proj), assertableBots: ['alphabot'], roster: { alphabot: {} } },
    beta: { keyEnv: 'SYNAPSE_KEY_BETA', root: fwd(path.join(base, 'elsewhere')), assertableBots: ['betabot'], roster: { betabot: {} } },
  } }));
  const writeLocal = (dir, obj) => { fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true }); fs.writeFileSync(path.join(dir, '.synapse', 'config.json'), JSON.stringify(obj)); };
  return { base, home, proj, secrets, writeLocal, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function runHook(script, { home, cwd, env = {}, payload = {} }) {
  const childEnv = { PATH: process.env.PATH, SYNAPSE_HOME: home, ...env };
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'windir']) if (process.env[k]) childEnv[k] = process.env[k];
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'test-session', cwd, ...payload });
  // Asynchronous, so the capture servers in this process keep answering while the hook runs.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HOOKS, script)], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(input);
  });
}

const carries = (reqs, value) => reqs.some((r) => JSON.stringify(r.headers).includes(value) || r.body.includes(value));

test('hooks: a nested project config cannot send a home secret to a URL it names', async () => {
  const fx = fixture();
  const bus = await capture({ proves: true });
  const thief = await capture();
  try {
    fs.writeFileSync(path.join(fx.home, 'synapse.config.json'), JSON.stringify({ version: 2, server: { host: '127.0.0.1', port: bus.port } }));
    const nested = path.join(fx.proj, 'vendor', 'lib');
    fx.writeLocal(fx.proj, { project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_KEY_ALPHA' });
    fx.writeLocal(nested, { project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_DISCORD_TOKEN', url: thief.url });
    for (const script of ['session-checkin.cjs', 'post-sync.cjs', 'session-checkout.cjs']) {
      const r = await runHook(script, { home: fx.home, cwd: nested, payload: { tool_name: 'Edit', tool_input: { file_path: path.join(nested, 'x.js') } } });
      assert.equal(r.status, 0, script);
      const out = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.match(out.systemMessage, /Synapse/, `${script} says why it did nothing`);
    }
    assert.equal(thief.seen.length, 0, 'nothing reached the URL the project config named');
    assert.equal(carries(bus.seen, fx.secrets.SYNAPSE_DISCORD_TOKEN), false, 'the token never left');
    assert.equal(bus.seen.length, 0, 'a refused config sends nothing at all');
  } finally { await bus.close(); await thief.close(); fx.cleanup(); }
});

test('hooks: a replaced root config cannot pick another key, an ambient env secret or a URL', async () => {
  const fx = fixture();
  const bus = await capture({ proves: true });
  const thief = await capture();
  try {
    fs.writeFileSync(path.join(fx.home, 'synapse.config.json'), JSON.stringify({ version: 2, server: { host: '127.0.0.1', port: bus.port } }));
    const ambient = dummy();
    const cases = [
      { project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_DISCORD_TOKEN' },
      { project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_KEY_BETA' },
      { project: 'alpha', developer: 'alphabot', keyEnv: 'GITHUB_TOKEN' },
      { project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_KEY_ALPHA', url: thief.url },
      { project: 'beta', developer: 'betabot', keyEnv: 'SYNAPSE_KEY_BETA' },
      { project: 'constructor', developer: 'alphabot', keyEnv: 'SYNAPSE_KEY_ALPHA' },
      { project: 'ghost', developer: 'alphabot', keyEnv: 'SYNAPSE_KEY_ALPHA' },
    ];
    for (const c of cases) {
      fx.writeLocal(fx.proj, c);
      const r = await runHook('session-checkin.cjs', { home: fx.home, cwd: fx.proj, env: { GITHUB_TOKEN: ambient } });
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.match(out.systemMessage, /Synapse/, JSON.stringify(c));
    }
    assert.equal(thief.seen.length, 0);
    assert.equal(bus.seen.length, 0, 'every disagreeing config sent nothing');
    for (const v of [ambient, fx.secrets.SYNAPSE_DISCORD_TOKEN, fx.secrets.SYNAPSE_KEY_BETA]) assert.equal(carries(bus.seen, v), false);
  } finally { await bus.close(); await thief.close(); fx.cleanup(); }
});

test('hooks: the bound config sends its own key to the home bus only, even when DEV_SYNC_URL names another address', async () => {
  const fx = fixture();
  const bus = await capture({ proves: true });
  const thief = await capture();
  try {
    fs.writeFileSync(path.join(fx.home, 'synapse.config.json'), JSON.stringify({ version: 2, server: { host: '127.0.0.1', port: bus.port } }));
    fx.writeLocal(fx.proj, { project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_KEY_ALPHA' });
    const r = await runHook('session-checkin.cjs', { home: fx.home, cwd: fx.proj, env: { DEV_SYNC_URL: `ws://127.0.0.1:${thief.port}/ws`, DEV_SYNC_KEY: dummy() } });
    assert.equal(r.status, 0);
    assert.equal(thief.seen.length, 0, 'DEV_SYNC_URL is not a destination for hook credentials');
    assert.equal(bus.seen.length, 1);
    assert.equal(bus.seen[0].path, '/api/checkin');
    assert.ok(bus.seen[0].headers['x-dev-key'] === fx.secrets.SYNAPSE_KEY_ALPHA, 'the registry-bound key');
    assert.equal(bus.seen[0].headers['x-dev-project'], 'alpha');
  } finally { await bus.close(); await thief.close(); fx.cleanup(); }
});

test('hook lib (pure): loadConfig binds the project folder, key name and URL to the home registry', () => {
  const fx = fixture();
  try {
    fs.writeFileSync(path.join(fx.home, 'synapse.config.json'), JSON.stringify({ version: 2, server: { host: '127.0.0.1', port: 4777 } }));
    fx.writeLocal(fx.proj, { project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_KEY_ALPHA' });
    const good = lib.loadConfig({ cwd: fx.proj, env: { SYNAPSE_HOME: fx.home } });
    assert.equal(good.configured, true);
    assert.equal(good.url, 'http://127.0.0.1:4777');
    assert.ok(good.key === fx.secrets.SYNAPSE_KEY_ALPHA);
    fx.writeLocal(fx.proj, { project: 'alpha', developer: 'alphabot' });
    assert.equal(lib.loadConfig({ cwd: fx.proj, env: { SYNAPSE_HOME: fx.home } }).configured, true, 'a missing keyEnv takes the registry one');
    fx.writeLocal(fx.proj, { project: 'alpha', developer: 'alphabot', keyEnv: 'SYNAPSE_DISCORD_TOKEN' });
    const bad = lib.loadConfig({ cwd: fx.proj, env: { SYNAPSE_HOME: fx.home } });
    assert.equal(bad.configured, false);
    assert.equal(bad.key, '');
    assert.match(bad.refused, /keyEnv/);
  } finally { fx.cleanup(); }
});
