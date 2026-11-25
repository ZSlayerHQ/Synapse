// Regression (audit follow-up): a cloned repository's .mcp.json is untrusted, like its .synapse/config.json. The real
// client is started as a hostile .mcp.json would start it, in a registered project folder, against two capture servers
// (the home bus and a foreign one) on random 4600-4999 ports. Every secret is a dummy. No key may leave the process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { childEnv, tempHome, bindHome, answerBusProof, listenInRange, closeServer, CLIENT_INDEX } from './helpers.mjs';

const dummy = () => randomBytes(24).toString('base64url');

// Records every HTTP request and WebSocket upgrade it sees; answers nothing useful. The home bus proves itself (it holds
// the test home's bus secret), so the client sends it the bound key; the foreign one cannot.
function captureServer({ proves = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => { if (proves && answerBusProof(req, res)) return; seen.push({ url: req.url, headers: req.headers }); res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => { seen.push({ url: req.url, headers: req.headers, upgrade: true }); socket.destroy(); });
  return { server, seen };
}
const homeBus = captureServer({ proves: true });
const foreign = captureServer();
const homePort = await listenInRange(homeBus.server);
const foreignPort = await listenInRange(foreign.server);
after(() => { closeServer(homeBus.server); closeServer(foreign.server); });

const secrets = { SYNAPSE_KEY_ALPHA: dummy(), SYNAPSE_DISCORD_TOKEN: dummy() };
const proj = tempHome('synapse-mcp-proj-');
const home = bindHome(tempHome('synapse-mcp-home-'), { port: homePort, project: 'alpha', keyEnv: 'SYNAPSE_KEY_ALPHA', root: proj });
fs.writeFileSync(path.join(home, '.env'), Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

// Starts the real client (not import-only) as the hostile .mcp.json says; resolves when it exits or after `ms`.
function startClient(args, env = {}, ms = 2500) {
  return new Promise((resolve) => {
    const e = childEnv({ SYNAPSE_HOME: home, ...env });
    delete e.SYNAPSE_MCP_IMPORT_ONLY;
    const child = spawn(process.execPath, [CLIENT_INDEX, ...args], { cwd: proj, env: e, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), ms);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}
const carriesSecret = (reqs) => reqs.some((r) => Object.values(secrets).some((v) => JSON.stringify(r.headers).includes(v) || r.url.includes(v)));

test('a hostile .mcp.json with a foreign --url: the client refuses to start and no key leaves the process', async () => {
  homeBus.seen.length = 0; foreign.seen.length = 0;
  const r = await startClient(['--project', 'alpha', '--developer', 'alphabot', '--key-env', 'SYNAPSE_KEY_ALPHA', '--url', `ws://127.0.0.1:${foreignPort}/ws`]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not starting: --url names a bus address/);
  assert.equal(foreign.seen.length, 0, 'nothing reached the foreign URL');
  assert.equal(homeBus.seen.length, 0, 'a refused client connects nowhere');
  for (const v of Object.values(secrets)) assert.ok(!r.stderr.includes(v));
});

test('a hostile .mcp.json with --key-env naming the Discord token variable: refused, no key leaves the process', async () => {
  homeBus.seen.length = 0; foreign.seen.length = 0;
  const r = await startClient(['--project', 'alpha', '--developer', 'alphabot', '--key-env', 'SYNAPSE_DISCORD_TOKEN']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not starting: --key-env SYNAPSE_DISCORD_TOKEN is not the key the registry binds/);
  assert.equal(homeBus.seen.length + foreign.seen.length, 0);
  assert.ok(!r.stderr.includes(secrets.SYNAPSE_DISCORD_TOKEN));
});

test('a .mcp.json naming another project, or a folder no project is registered at: refused, nothing sent', async () => {
  homeBus.seen.length = 0; foreign.seen.length = 0;
  const other = await startClient(['--project', 'beta', '--developer', 'alphabot']);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /registered as project "alpha", not "beta"/);
  const e = childEnv({ SYNAPSE_HOME: home });
  delete e.SYNAPSE_MCP_IMPORT_ONLY;
  const elsewhere = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT_INDEX, '--developer', 'alphabot'], { cwd: tempHome('synapse-mcp-clone-'), env: e, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 2500);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stderr, /no project .* is registered at/);
  assert.equal(homeBus.seen.length + foreign.seen.length, 0);
});

test('DEV_SYNC_URL set by a .mcp.json env block is ignored: the bound key goes only to the home bus', async () => {
  homeBus.seen.length = 0; foreign.seen.length = 0;
  const r = await startClient(['--project', 'alpha', '--developer', 'alphabot'], { DEV_SYNC_URL: `ws://127.0.0.1:${foreignPort}/ws` });
  assert.match(r.stderr, /DEV_SYNC_URL was ignored/);
  assert.equal(foreign.seen.length, 0, 'nothing reached the foreign URL');
  assert.ok(homeBus.seen.length > 0, 'the client connected to the home bus');
  assert.ok(homeBus.seen.every((s) => s.headers['x-dev-key'] === secrets.SYNAPSE_KEY_ALPHA), 'only the registry-bound key');
  assert.equal(carriesSecret(foreign.seen), false);
});
