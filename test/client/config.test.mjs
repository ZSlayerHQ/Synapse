// How the client finds its home, bus and key: the installed layout, else SYNAPSE_HOME, else ~/.synapse; <home>/.env fills
// only unset variables; the bus only from synapse.config.json (--url, --http and DEV_SYNC_URL are ignored); the key only
// from the variable the home registry binds to the project registered at the working folder, sent only in X-Dev-Key.
// Child processes get a pinned environment (DEV_SYNC_SEAT, SYNAPSE_HOME) and talk only to a mock bus.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { pinEnv, childEnv, tempHome, bindHome, answerBusProof, listenInRange, closeServer, CLIENT_INDEX } from './helpers.mjs';

pinEnv();
const { resolveHome, wsUrlFromConfig, httpFromWs, parseEnvText, DEFAULT_PORT } = await import('../../client/index.js');

// A runner outside the test folder, so the test runner never picks it up and runs the client for real.
const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-client-runner-'));
const RUNNER = path.join(runnerDir, 'print-config.mjs');
fs.writeFileSync(RUNNER, [
  `const m = await import(${JSON.stringify(pathToFileURL(CLIENT_INDEX).href)});`,
  'const out = { ws: m.WS_URL, http: m.HTTP_URL, developer: m.DEVELOPER, project: m.PROJECT, home: m.SYNAPSE_HOME, keyEnv: m.KEY_ENV, refused: m.BINDING.refused };',
  "if (process.env.CALL_TOOL) out.result = await m.handleToolCall({ params: { name: process.env.CALL_TOOL, arguments: {} } });",
  'process.stdout.write(JSON.stringify(out));',
].join('\n'));

const run = (args = [], env = {}, { cwd } = {}) => {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd, env: childEnv({ SYNAPSE_MCP_IMPORT_ONLY: '1', ...env }), encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return { ...JSON.parse(r.stdout), stderr: r.stderr };
};
const runAsync = (args = [], env = {}, { cwd } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [RUNNER, ...args], { cwd, env: childEnv({ SYNAPSE_MCP_IMPORT_ONLY: '1', ...env }) });
  let out = ''; let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const timer = setTimeout(() => { child.kill(); reject(new Error('child timed out')); }, 15000);
  child.on('close', (code) => { clearTimeout(timer); if (code !== 0) return reject(new Error(err)); resolve({ ...JSON.parse(out), stderr: err }); });
});
const homeWith = ({ config, env } = {}) => {
  const home = tempHome('synapse-client-cfg-');
  if (config !== undefined) fs.writeFileSync(path.join(home, 'synapse.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  if (env !== undefined) fs.writeFileSync(path.join(home, '.env'), env);
  return home;
};

const keys = [];
const server = http.createServer((req, res) => {
  if (answerBusProof(req, res)) return;
  keys.push({ key: req.headers['x-dev-key'], url: req.url });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"locks":[]}');
});
const port = await listenInRange(server);
after(() => { closeServer(server); fs.rmSync(runnerDir, { recursive: true, force: true }); });

test('pure: the bus URL from synapse.config.json, with defaults', () => {
  assert.equal(DEFAULT_PORT, 4560);
  assert.equal(wsUrlFromConfig(null), 'ws://127.0.0.1:4560/ws');
  assert.equal(wsUrlFromConfig({}), 'ws://127.0.0.1:4560/ws');
  assert.equal(wsUrlFromConfig({ server: { host: 'bus.lan', port: 4999 } }), 'ws://bus.lan:4999/ws');
  assert.equal(wsUrlFromConfig({ server: { host: '0.0.0.0', port: '4700' } }), 'ws://127.0.0.1:4700/ws', 'a server bound to every interface is reached on loopback');
  assert.equal(wsUrlFromConfig({ server: { host: '::1' } }), 'ws://[::1]:4560/ws');
  for (const bad of [0, -1, 70000, 'x', 1.5, null]) assert.equal(wsUrlFromConfig({ server: { port: bad } }), 'ws://127.0.0.1:4560/ws', String(bad));
});

test('pure: the HTTP base is the WebSocket URL with its scheme swapped and the trailing /ws removed', () => {
  assert.equal(httpFromWs('ws://127.0.0.1:4560/ws'), 'http://127.0.0.1:4560');
  assert.equal(httpFromWs('wss://bus.example.test/ws'), 'https://bus.example.test');
  assert.equal(httpFromWs('ws://wsbus.lan:4600/ws'), 'http://wsbus.lan:4600', 'a host that starts with ws is left whole');
  assert.equal(httpFromWs('ws://host:4600/prefix/ws/'), 'http://host:4600/prefix');
});

test('pure: the home is the installed layout when it holds synapse.config.json, else SYNAPSE_HOME, else ~/.synapse', () => {
  const root = tempHome('synapse-client-layout-');
  const clientDir = path.join(root, 'app', 'client');
  fs.mkdirSync(clientDir, { recursive: true });
  const fakeHome = path.join(root, 'user');
  assert.equal(resolveHome({ env: {}, clientDir, homedir: fakeHome }), path.join(fakeHome, '.synapse'), 'no config two levels up');
  fs.writeFileSync(path.join(root, 'synapse.config.json'), '{}');
  assert.equal(resolveHome({ env: {}, clientDir, homedir: fakeHome }), root, 'the installed layout');
  assert.equal(resolveHome({ env: { SYNAPSE_HOME: path.join(root, 'elsewhere') }, clientDir, homedir: fakeHome }), root, 'an installed client ignores SYNAPSE_HOME, which a project .mcp.json can set');
  const source = path.join(root, 'src', 'client');
  assert.equal(resolveHome({ env: { SYNAPSE_HOME: path.join(root, 'elsewhere') }, clientDir: source, homedir: fakeHome }), path.join(root, 'elsewhere'), 'a source checkout uses SYNAPSE_HOME');
});

test('pure: .env lines are KEY=VALUE; comments, blanks and malformed lines are skipped; one layer of quotes comes off', () => {
  assert.deepEqual(parseEnvText('# c\n\nA=1\r\nexport B = "two words"\nC=\'x=y\'\nnot a line\n1BAD=2\nD='), [['A', '1'], ['B', 'two words'], ['C', 'x=y'], ['D', '']]);
});

test('a child reads its bus from <home>/synapse.config.json and fills unset variables from <home>/.env', () => {
  const home = homeWith({ config: { server: { host: 'bus.lan', port: 4777 } }, env: 'DEV_SYNC_DEVELOPER=fromfile\n# comment\nexport DEV_SYNC_PROJECT="proj1"\n' });
  const out = run([], { SYNAPSE_HOME: home });
  assert.equal(out.home, home);
  assert.equal(out.ws, 'ws://bus.lan:4777/ws');
  assert.equal(out.http, 'http://bus.lan:4777');
  assert.equal(out.developer, 'fromfile');
  assert.equal(out.project, 'proj1');
});

test('an explicit environment beats <home>/.env; --developer and --project still work beneath the env rules', () => {
  const home = homeWith({ env: 'DEV_SYNC_DEVELOPER=fromfile\n' });
  assert.equal(run([], { SYNAPSE_HOME: home, DEV_SYNC_DEVELOPER: 'fromenv' }).developer, 'fromenv');
  const plain = run(['--developer', 'argbot', '--project', 'p2'], { SYNAPSE_HOME: homeWith() });
  assert.equal(plain.developer, 'argbot');
  assert.equal(plain.project, 'p2');
  assert.equal(run(['--developer', 'argbot'], { SYNAPSE_HOME: homeWith(), DEV_SYNC_DEVELOPER: 'envbot' }).developer, 'envbot', 'the env beats the argument');
  assert.equal(run(['--project', 'argp'], { SYNAPSE_HOME: homeWith(), DEV_SYNC_PROJECT: 'envp' }).project, 'argp', 'the argument beats DEV_SYNC_PROJECT');
});

test('only the home config names the bus: DEV_SYNC_URL is ignored with a note, --url and --http refuse; the default is 127.0.0.1:4560', () => {
  const home = homeWith({ config: { server: { host: 'cfg.lan', port: 4801 } } });
  const out = run([], { SYNAPSE_HOME: home, DEV_SYNC_URL: 'ws://env.lan:4802/ws' });
  assert.equal(out.ws, 'ws://cfg.lan:4801/ws');
  assert.equal(out.http, 'http://cfg.lan:4801');
  assert.match(out.stderr, /DEV_SYNC_URL was ignored/);
  for (const flag of [['--url', 'ws://arg.lan:4803/ws'], ['--http', 'http://arg.lan:4803']]) {
    const r = run(flag, { SYNAPSE_HOME: home });
    assert.equal(r.ws, 'ws://cfg.lan:4801/ws', flag[0]);
    assert.match(r.refused, new RegExp(`${flag[0]} names a bus address`));
  }
  const none = run([], { SYNAPSE_HOME: homeWith() });
  assert.equal(none.ws, 'ws://127.0.0.1:4560/ws');
  assert.equal(none.http, 'http://127.0.0.1:4560');
  const broken = run([], { SYNAPSE_HOME: homeWith({ config: '{not json' }) });
  assert.equal(broken.ws, 'ws://127.0.0.1:4560/ws', 'a broken config falls back to the default');
});

test('seat suffix rules: a named seat is cleaned, auto is the pid, a dotted developer is left alone', () => {
  assert.equal(run(['--developer', 'bot'], { DEV_SYNC_SEAT: 'Rev!ew' }).developer, 'bot.revew');
  assert.match(run(['--developer', 'bot'], { DEV_SYNC_SEAT: 'auto' }).developer, /^bot\.\d+$/);
  assert.equal(run(['--developer', 'bot.fixed'], { DEV_SYNC_SEAT: 'x' }).developer, 'bot.fixed');
  assert.equal(run(['--developer', 'bot'], {}).developer, 'bot', 'a pinned empty seat adds nothing');
  assert.equal(run([], {}).developer, 'unknown');
});

// A project folder registered in a fresh home, with the mock bus in its config.
const boundProject = ({ keyEnv = 'MY_BUS_KEY', env } = {}) => {
  const dir = tempHome('synapse-client-proj-');
  const home = bindHome(homeWith({ env }), { port, project: 'proj1', keyEnv, root: dir });
  return { dir, home };
};

test('the key comes from the variable the registry binds (or <home>/.env), and only travels in X-Dev-Key', async () => {
  keys.length = 0;
  const a = boundProject();
  const env = await runAsync([], { SYNAPSE_HOME: a.home, MY_BUS_KEY: 'env-key', DEV_SYNC_KEY: 'other', CALL_TOOL: 'dev_sync_locks' }, { cwd: a.dir });
  assert.equal(env.keyEnv, 'MY_BUS_KEY');
  assert.equal(env.project, 'proj1', 'the project registered at the working folder');
  const b = boundProject({ env: 'MY_BUS_KEY=file-key\n' });
  await runAsync([], { SYNAPSE_HOME: b.home, CALL_TOOL: 'dev_sync_locks' }, { cwd: path.join(b.dir) });
  assert.deepEqual(keys.map((k) => k.key), ['env-key', 'file-key']);
  assert.ok(keys.every((k) => !/key/i.test(k.url)), 'never in the URL');
});

test('a --key-env the registry binds is accepted; a literal --key is ignored with a warning that does not echo it', async () => {
  keys.length = 0;
  const a = boundProject();
  const named = await runAsync(['--key-env', 'MY_BUS_KEY'], { SYNAPSE_HOME: a.home, MY_BUS_KEY: 'named-key', CALL_TOOL: 'dev_sync_locks' }, { cwd: a.dir });
  assert.equal(named.keyEnv, 'MY_BUS_KEY');
  const literal = await runAsync(['--key', 'literal-secret-value'], { SYNAPSE_HOME: a.home, CALL_TOOL: 'dev_sync_locks' }, { cwd: a.dir });
  assert.deepEqual(keys.map((k) => k.key), ['named-key', ''], 'the literal is never used');
  assert.match(literal.stderr, /--key is not supported and was ignored/);
  assert.doesNotMatch(literal.stderr, /literal-secret-value/);
});

test('values from <home>/.env are never written to stderr', () => {
  const home = homeWith({ env: 'DEV_SYNC_KEY=very-secret-value-123\nDEV_SYNC_DEVELOPER=quiet\n' });
  const out = run([], { SYNAPSE_HOME: home });
  assert.doesNotMatch(out.stderr, /very-secret-value-123/);
});
