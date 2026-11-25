// Fail-closed project walls and the lock / pre-edit flow, against a real bus on a random port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBus } from '../helpers/bus.mjs';

const fx = await startBus({ projects: { alpha: { bots: ['alphabot', 'helper'], sharedFiles: ['package.json'] }, beta: { bots: ['betabot'] } } });
test.after(() => fx.close());
const A = { key: fx.keys.alpha, project: 'alpha' };
const B = { key: fx.keys.beta, project: 'beta' };

test('the bus never binds port 4100', () => assert.notEqual(fx.bus.port, 4100));

test('health is open and carries no project data', async () => {
  const r = await fx.call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'healthy');
  assert.deepEqual(r.body.humanChannelStatus, {}, 'the dashboard channel reports no connection state');
  assert.deepEqual(Object.keys(r.body).sort(), ['busUptime', 'humanChannel', 'humanChannelStatus', 'instance', 'pid', 'status', 'uptime', 'version']);
});

test('auth: no key 401, wrong key 401, another project\'s key 401, unknown project 400', async () => {
  assert.equal((await fx.call('GET', '/api/status', { project: 'alpha' })).status, 401);
  assert.equal((await fx.call('GET', '/api/status', { key: 'x'.repeat(32), project: 'alpha' })).status, 401);
  assert.equal((await fx.call('GET', '/api/status', { key: fx.keys.beta, project: 'alpha' })).status, 401);
  assert.equal((await fx.call('GET', '/api/status', { key: fx.keys.alpha, project: 'nosuch' })).status, 400);
});

test('identity gate: a project key cannot post as another project\'s bot, a person or the system sender', async () => {
  for (const sender of ['betabot', 'owner1', 'synapse', 'dashboard']) {
    const r = await fx.call('POST', '/api/message', { ...A, body: { sender, channel: 'code', content: 'hi' } });
    assert.equal(r.status, 403, sender);
  }
  assert.equal((await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'code', content: 'hi' } })).status, 200);
});

test('unknown channels are refused', async () => {
  const r = await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'nope', content: 'x' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown_channel');
});

test('messages, activity, tasks and locks are walled per project', async () => {
  await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'code', content: 'alpha-secret' } });
  await fx.call('POST', '/api/tasks', { ...A, body: { title: 'alpha task', createdBy: 'alphabot' } });
  await fx.call('POST', '/api/lock', { ...A, body: { developer: 'alphabot', file: 'src/a.js' } });
  const msgs = await fx.call('GET', '/api/messages', B);
  assert.ok(!JSON.stringify(msgs.body).includes('alpha-secret'));
  const tasks = await fx.call('GET', '/api/tasks', B);
  assert.equal(tasks.body.tasks.length, 0);
  const locks = await fx.call('GET', '/api/locks', B);
  assert.equal(locks.body.locks.length, 0);
  const act = await fx.call('GET', '/api/activity', B);
  assert.ok(act.body.entries.every((e) => e.project === 'beta'));
  const aTask = (await fx.call('GET', '/api/tasks', A)).body.tasks[0];
  assert.equal((await fx.call('GET', `/api/tasks/${aTask.id}`, B)).status, 404, 'cross-project ids read as missing');
  assert.equal((await fx.call('GET', '/api/projects/alpha/roster', B)).status, 403);
});

test('lock, conflict, pre-edit block, release', async () => {
  const f = 'src/locked.js';
  assert.equal((await fx.call('POST', '/api/lock', { ...A, body: { developer: 'alphabot', file: f, reason: 'refactor' } })).body.ok, true);
  const conflict = await fx.call('POST', '/api/lock', { ...A, body: { developer: 'helper', file: f } });
  assert.equal(conflict.body.conflict, true);
  assert.equal(conflict.body.lockedBy, 'alphabot');
  const blocked = await fx.call('POST', '/api/will-edit', { ...A, body: { developer: 'helper', file: f } });
  assert.equal(blocked.body.safe, false);
  assert.equal(blocked.body.severity, 'blocked');
  const own = await fx.call('POST', '/api/will-edit', { ...A, body: { developer: 'alphabot', file: f } });
  assert.equal(own.body.safe, true);
  // The same relative path in another project is a different file.
  const other = await fx.call('POST', '/api/will-edit', { ...B, body: { developer: 'betabot', file: f } });
  assert.equal(other.body.safe, true);
  // A non-holder's unlock is a no-op.
  await fx.call('DELETE', '/api/lock', { ...A, body: { developer: 'helper', file: f } });
  assert.equal((await fx.call('POST', '/api/will-edit', { ...A, body: { developer: 'helper', file: f } })).body.safe, false);
  await fx.call('DELETE', '/api/lock', { ...A, body: { developer: 'alphabot', file: f } });
  assert.equal((await fx.call('POST', '/api/will-edit', { ...A, body: { developer: 'helper', file: f } })).body.safe, true);
});

test('recent-edit warning and shared-file caution', async () => {
  await fx.call('POST', '/api/did-edit', { ...A, body: { developer: 'alphabot', file: 'src/hot.js' } });
  const w = await fx.call('POST', '/api/will-edit', { ...A, body: { developer: 'helper', file: 'src/hot.js' } });
  assert.equal(w.body.severity, 'warning');
  const c = await fx.call('POST', '/api/will-edit', { ...A, body: { developer: 'helper', file: 'package.json' } });
  assert.equal(c.body.severity, 'caution');
});

test('checkout releases the developer\'s locks in its own project only', async () => {
  await fx.call('POST', '/api/lock', { ...A, body: { developer: 'helper', file: 'x1.js' } });
  const r = await fx.call('POST', '/api/checkout', { ...A, body: { developer: 'helper' } });
  assert.equal(r.body.locksReleased, 1);
});

test('alerts are walled and acked per project', async () => {
  await fx.call('POST', '/api/alert', { ...A, body: { from: 'alphabot', to: 'helper', message: 'look' } });
  assert.equal((await fx.call('GET', '/api/alerts/helper', B)).body.alerts.length, 0);
  assert.equal((await fx.call('GET', '/api/alerts/helper', A)).body.alerts.length, 1);
});

test('a person can only read projects they are allowed in', async () => {
  const scoped = await startBus({ projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] } }, people: { owner1: { key: 'owner-key-0123456789' }, guest: { key: 'guest-key-0123456789', projects: ['beta'] } } });
  try {
    await scoped.call('POST', '/api/message', { key: scoped.keys.alpha, project: 'alpha', body: { sender: 'alphabot', channel: 'code', content: 'alpha-only' } });
    const g = await scoped.call('GET', '/api/messages', { human: 'guest', key: 'guest-key-0123456789' });
    assert.equal(g.status, 200);
    assert.ok(!JSON.stringify(g.body).includes('alpha-only'));
    assert.equal((await scoped.call('GET', '/api/messages', { human: 'guest', key: 'guest-key-0123456789', project: 'alpha' })).status, 403);
    const o = await scoped.call('GET', '/api/messages', { human: 'owner1', key: 'owner-key-0123456789' });
    assert.ok(JSON.stringify(o.body).includes('alpha-only'));
    assert.equal((await scoped.call('GET', '/api/messages', { human: 'stranger', key: 'guest-key-0123456789' })).status, 401, 'an unknown person is refused');
    assert.equal((await scoped.call('GET', '/api/messages', { human: 'guest', key: 'owner-key-0123456789' })).status, 401, 'another person\'s key');
  } finally { await scoped.close(); }
});
