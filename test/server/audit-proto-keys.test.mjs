// Regression for the security audit (run-1), finding 1: inherited names never resolve as a project, a person, a bot or a
// lookup entry, and an empty key never authenticates.
// Every bus here is in-process on a random port in 4600-4999.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createAuth } from '../../server/lib/auth.mjs';
import { createPeople } from '../../server/lib/people.mjs';
import { checkConfig, checkRegistry, withDefaults } from '../../server/lib/config.mjs';
import { startBus } from '../helpers/bus.mjs';

const PROTO_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
const OWNER = { human: 'owner1', key: 'owner-key-0123456789' };

function rawRequest(fx, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.bus.port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body: json, headers: res.headers }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function wsClose(url, key) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { 'X-Dev-Key': key } });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

// ─── 1. Inherited names never resolve as a project, a person, a bot or a lookup entry; an empty key never authenticates ───

test('auth: an inherited project name with an empty or missing key is refused as an unknown project', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] } } });
  try {
    for (const name of PROTO_NAMES) {
      const empty = await rawRequest(fx, { path: '/api/whoami', headers: { 'X-Dev-Key': '', 'X-Dev-Project': name } });
      assert.equal(empty.status, 400, `${name} with an empty key`);
      const missing = await rawRequest(fx, { path: '/api/whoami', headers: { 'X-Dev-Project': name } });
      assert.equal(missing.status, 400, `${name} with no key`);
    }
    assert.equal((await rawRequest(fx, { path: '/api/whoami', headers: { 'X-Dev-Key': '', 'X-Dev-Project': 'alpha' } })).status, 401, 'an empty key on a real project');
    assert.equal((await rawRequest(fx, { path: '/api/whoami', headers: { 'X-Dev-Key': '' } })).status, 401, 'an empty key on the default project');
    assert.equal((await rawRequest(fx, { path: '/api/whoami', headers: { 'X-Dev-Key': fx.keys.alpha, 'X-Dev-Project': 'Alpha' } })).status, 400, 'an id outside the id pattern');
  } finally { await fx.close(); }
});

test('auth: keyless task writes through an inherited project name cannot evict another project\'s task', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] } } });
  try {
    const B = { key: fx.keys.beta, project: 'beta' };
    assert.equal((await fx.call('POST', '/api/tasks', { ...B, body: { title: 'beta task', createdBy: 'betabot' } })).status, 200);
    const body = JSON.stringify({ title: 'flood' });
    for (let i = 0; i < 5; i++) {
      const r = await rawRequest(fx, { method: 'POST', path: '/api/tasks', headers: { 'X-Dev-Key': '', 'X-Dev-Project': '__proto__', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
      assert.equal(r.status, 400);
    }
    assert.equal((await fx.call('GET', '/api/tasks', B)).body.tasks.length, 1);
  } finally { await fx.close(); }
});

test('auth: a person cannot name an inherited project, and the roster route does not resolve one', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] } }, people: { owner1: { key: OWNER.key } } });
  try {
    for (const name of PROTO_NAMES) {
      assert.equal((await fx.call('GET', '/api/whoami', { human: OWNER.human, key: OWNER.key, project: name })).status, 400, name);
      assert.equal((await fx.call('GET', `/api/projects/${name}/roster`, { key: fx.keys.alpha, project: 'alpha' })).status, 404, name);
    }
    assert.equal((await fx.call('GET', '/api/messages?project=constructor', { human: OWNER.human, key: OWNER.key })).status, 400);
  } finally { await fx.close(); }
});

test('auth: the WebSocket refuses an inherited project name as unknown', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] } } });
  try {
    for (const name of ['constructor', '__proto__', 'toString']) {
      assert.equal(await wsClose(`${fx.wsUrl}?project=${encodeURIComponent(name)}&developer=alphabot`, fx.keys.alpha), 4002, name);
    }
  } finally { await fx.close(); }
});

test('tasks: an inherited status name posts no status line', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] } } });
  try {
    const A = { key: fx.keys.alpha, project: 'alpha' };
    const t = (await fx.call('POST', '/api/tasks', { ...A, body: { title: 'x', createdBy: 'alphabot' } })).body.task;
    await fx.call('PATCH', `/api/tasks/${t.id}`, { ...A, body: { status: 'constructor', updatedBy: 'alphabot' } });
    const msgs = (await fx.call('GET', '/api/messages?channel=tasks', A)).body.messages;
    assert.equal(msgs.filter((m) => /native code/.test(m.content)).length, 0);
  } finally { await fx.close(); }
});

test('auth (pure): inherited names never resolve to a project, a roster entry or a project key', () => {
  const registry = { projects: { alpha: { keyEnv: 'K_A', assertableBots: ['alphabot'], roster: {} } } };
  const env = { K_A: 'a'.repeat(30) };
  const auth = createAuth({ registry, env, people: createPeople({ owners: [], people: {} }) });
  for (const name of PROTO_NAMES) {
    assert.equal(auth.projectKey(name), null, name);
    assert.equal(auth.matchBotKey(name, 'x'), null, name);
    assert.equal(auth.bindIdentity(name, 'alphabot', { headers: { 'x-dev-key': env.K_A } }), false, name);
    assert.equal(auth.bindSecondaryActor('alpha', name, null, ''), false, name);
  }
});

test('people (pure): an inherited account kind never maps to a person or makes one reachable', () => {
  const people = createPeople({ owners: ['olive'], people: { olive: { accounts: { fake: 'id-1' } } } });
  assert.equal(people.byExternalId('constructor', String(Object)), null);
  assert.equal(people.byExternalId('toString', String(Object.prototype.toString)), null);
  assert.deepEqual(people.reachableAnswerersFor('alpha', { providers: ['constructor'] }), []);
  assert.equal(people.exists('constructor'), false);
});

test('config (pure): an inherited name is never a known project, and reserved names are refused for bots and people', () => {
  const env = { K_A: 'a'.repeat(30) };
  const registry = { projects: { alpha: { keyEnv: 'K_A', assertableBots: ['alphabot'] } } };
  const cfg = { version: 2, people: { olive: {} }, owners: ['olive'] };
  for (const name of ['constructor', 'toString']) {
    const f = checkRegistry(registry, withDefaults({ ...cfg, defaultProject: name }), env);
    assert.ok(f.some((x) => x.level === 'fatal' && /defaultProject/.test(x.message)), name);
  }
  for (const bot of ['dashboard', 'unknown', 'ask-bridge']) {
    const f = checkRegistry({ projects: { alpha: { keyEnv: 'K_A', assertableBots: [bot] } } }, withDefaults(cfg), env);
    assert.ok(f.some((x) => x.level === 'fatal' && x.message.includes(bot)), bot);
  }
  for (const person of ['dashboard', 'unknown', 'synapse']) {
    const f = checkConfig({ version: 2, people: { [person]: {}, olive: {} }, owners: ['olive'] });
    assert.ok(f.some((x) => x.level === 'fatal' && x.message.includes(person)), person);
  }
});
