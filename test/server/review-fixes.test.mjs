// Fixes from the batch-1 outside review: ingress checks, write authorization, seat-private history, per-project
// retention, canonical lock keys, the per-bot key fixture, reachable answerers, and the pack boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { startBus } from '../helpers/bus.mjs';
import { fakeToken } from '../helpers/discord-stub.mjs';

const OWNER = { human: 'owner1', key: 'owner-key-0123456789' };
const GUEST = { human: 'guest', key: 'guest-key-0123456789' };
let packCtx = null;
const fx = await startBus({
  projects: { alpha: { bots: ['alphabot', 'helper', 'keyed'], botKeys: { keyed: true } }, beta: { bots: ['betabot'] } },
  people: {
    owner1: { key: OWNER.key, accounts: { fake: 'acct-owner', other: 'acct-owner-other' } },
    guest: { key: GUEST.key, roles: ['approver'], projects: ['beta'], accounts: { fake: 'acct-guest' } },
  },
  config: { discord: { enabled: true } },
  extraEnv: { SYNAPSE_DISCORD_TOKEN: fakeToken() },
  channelImporter: async () => ({ createHumanChannel: async (ctx) => { packCtx = ctx; return { name: 'fakepack', providers: ['fake'] }; } }),
});
test.after(() => fx.close());
const A = { key: fx.keys.alpha, project: 'alpha' };
const KEYED = { key: fx.keys['alpha/keyed'], project: 'alpha' };

function rawRequest({ method = 'GET', path: p = '/api/health', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.bus.port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('ingress: a foreign Host header is refused (DNS-rebinding guard); the own loopback host works', async () => {
  assert.equal((await rawRequest({ headers: { host: 'attacker.example:80' } })).status, 421);
  assert.equal((await rawRequest({ headers: { host: `localhost:${fx.bus.port}` } })).status, 200);
});

test('ingress: only a bodyless GET or HEAD health probe skips auth', async () => {
  assert.equal((await rawRequest({ method: 'HEAD' })).status, 200);
  const withBody = await rawRequest({ method: 'GET', headers: { 'content-type': 'application/json', 'content-length': '2' }, body: '{}' });
  assert.equal(withBody.status, 401);
});

test('ingress: an unauthenticated body is never parsed (401, not a parse error)', async () => {
  const r = await fx.call('POST', '/api/message', { raw: '{not json', project: 'alpha' });
  assert.equal(r.status, 401);
  const authed = await fx.call('POST', '/api/message', { ...A, raw: '{not json' });
  assert.equal(authed.status, 400, 'an authenticated caller gets the parse error');
});

test('per-bot key: it may act only as its own bot, and cannot answer cards', async () => {
  assert.equal((await fx.call('POST', '/api/message', { ...KEYED, body: { sender: 'keyed', channel: 'code', content: 'k' } })).status, 200);
  assert.equal((await fx.call('POST', '/api/message', { ...KEYED, body: { sender: 'alphabot', channel: 'code', content: 'k' } })).status, 403);
  assert.equal((await fx.call('POST', '/api/message', { ...A, body: { sender: 'keyed', channel: 'code', content: 'k' } })).status, 403, 'the project key cannot speak for a keyed bot');
  const d = await fx.call('POST', '/api/ask/dispatch', { ...KEYED, body: { question: 'q?', options: ['a'], askingSeat: 'keyed' } });
  assert.equal(d.status, 200);
  assert.equal((await fx.call('POST', `/api/ask/${d.body.askId}/answer`, { ...KEYED, body: { label: 'a' } })).status, 403);
  assert.match(d.body.dashboardUrl, new RegExp(`^http://127\\.0\\.0\\.1:${fx.bus.port}/$`), 'the real dashboard URL');
});

test('writes are authorized against the resource\'s project', async () => {
  const t = (await fx.call('POST', '/api/tasks', { ...A, body: { title: 'alpha only', createdBy: 'alphabot' } })).body.task;
  assert.equal((await fx.call('PATCH', `/api/tasks/${t.id}`, { ...GUEST, project: 'beta', body: { status: 'done' } })).status, 404, 'a person outside alpha');
  assert.equal((await fx.call('DELETE', `/api/tasks/${t.id}`, { key: fx.keys.beta, project: 'beta' })).status, 404, 'another project\'s key');
  assert.equal((await fx.call('PATCH', `/api/tasks/${t.id}`, { ...OWNER, project: 'alpha', body: { status: 'in-progress' } })).status, 200, 'a person allowed in alpha');
});

test('history: direct messages are seat-private on the server', async () => {
  await fx.call('POST', '/api/message/direct', { ...A, body: { from: 'alphabot', to: 'helper', content: 'private-to-helper' } });
  const has = (r) => JSON.stringify(r.body).includes('private-to-helper');
  assert.equal(has(await fx.call('GET', '/api/messages', A)), false, 'no developer claim, no DMs');
  assert.equal(has(await fx.call('GET', '/api/messages?developer=helper', A)), true);
  assert.equal(has(await fx.call('GET', '/api/messages?developer=helper.s1', A)), true, 'a seat sees DMs to its base bot');
  assert.equal(has(await fx.call('GET', '/api/messages?developer=betabot', A)), false);
  assert.equal((await fx.call('GET', '/api/messages?developer=helper', KEYED)).status, 403, 'a per-bot key cannot claim another bot');
  assert.equal(has(await fx.call('GET', '/api/messages', OWNER)), false, 'a person sees only their own DMs');
});

test('retention is per project: a busy project cannot evict a quiet one, and a lagging cursor gets a resync', async () => {
  const quiet = (await fx.call('POST', '/api/message', { key: fx.keys.beta, project: 'beta', body: { sender: 'betabot', channel: 'code', content: 'quiet-beta' } })).body.id;
  const first = (await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'build', content: 'flood-0' } })).body.id;
  for (let i = 1; i <= 205; i++) await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'build', content: `flood-${i}` } });
  const beta = await fx.call('GET', '/api/messages?limit=200', { key: fx.keys.beta, project: 'beta' });
  assert.ok(beta.body.messages.some((m) => m.id === quiet), 'the quiet project kept its message');
  const lag = await fx.call('GET', `/api/messages?since_id=${first}&developer=helper`, A);
  assert.equal(lag.body.resync_required, true);
});

test('cards: an answerer without a personal key is not reachable, and nothing is parked', async () => {
  const nokey = await startBus({ projects: { gamma: { bots: ['gbot'] } }, people: { owner1: {} } });
  try {
    const r = await nokey.call('POST', '/api/ask/dispatch', { key: nokey.keys.gamma, project: 'gamma', body: { question: 'q', options: ['a'], askingSeat: 'gbot' } });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /personal key/);
  } finally { await nokey.close(); }
});

test('pack boundary: frozen views without key hashes; answers resolve a verified account to one person and the card\'s project', async () => {
  assert.ok(packCtx, 'the pack was loaded behind the config switch');
  assert.ok(Object.isFrozen(packCtx) && Object.isFrozen(packCtx.config) && Object.isFrozen(packCtx.people));
  assert.ok(!JSON.stringify(packCtx.config).includes('scrypt$'), 'no key hashes reach the pack');
  assert.equal(typeof packCtx.answerAsk, 'undefined', 'no name-based answer callback');
  const d = await fx.call('POST', '/api/ask/dispatch', { ...A, body: { question: 'Pack?', options: ['Go'], askingSeat: 'alphabot' } });
  assert.equal(d.body.delivery, 'unknown', 'the fake pack posts nothing');
  assert.equal(packCtx.answerAskByAccount({ provider: 'fake', accountId: 'nobody', askId: d.body.askId, label: 'Go' }).status, 403);
  assert.equal(packCtx.answerAskByAccount({ provider: 'other', accountId: 'acct-owner', askId: d.body.askId, label: 'Go' }).status, 403, 'wrong provider');
  // The owner has a valid mapping under a second provider the pack did not declare: refused, for answers and posts.
  const undeclared = packCtx.answerAskByAccount({ provider: 'other', accountId: 'acct-owner-other', askId: d.body.askId, label: 'Go' });
  assert.deepEqual([undeclared.status, undeclared.error], [403, 'undeclared_provider']);
  assert.equal(packCtx.postAsPerson({ provider: 'other', accountId: 'acct-owner-other', project: 'alpha', channel: 'code', content: 'x' }).error, 'undeclared_provider');
  assert.equal(packCtx.answerAskByAccount({ provider: 'fake', accountId: 'acct-guest', askId: d.body.askId, label: 'Go' }).status, 403, 'an approver of another project');
  const wrong = packCtx.answerAskByAccount({ provider: 'fake', accountId: 'acct-owner', askId: d.body.askId, optionIndex: 0, project: 'beta' });
  assert.deepEqual([wrong.status, wrong.error], [403, 'wrong_project'], "a tap from another project's surface");
  assert.equal(packCtx.answerAskByAccount({ provider: 'fake', accountId: 'acct-owner', askId: d.body.askId, optionIndex: 9, project: 'alpha' }).error, 'not_offered');
  const ok = packCtx.answerAskByAccount({ provider: 'fake', accountId: 'acct-owner', askId: d.body.askId, optionIndex: 0, project: 'alpha' });
  assert.deepEqual([ok.ok, ok.label, ok.answeredBy], [true, 'Go', 'owner1'], 'the label comes from the parked card by index');
  assert.equal(packCtx.postAsPerson({ provider: 'fake', accountId: 'acct-guest', project: 'alpha', channel: 'code', content: 'x' }).error, 'not_allowed');
  assert.equal(packCtx.postAsPerson({ provider: 'fake', accountId: 'acct-owner', project: 'alpha', channel: 'code', content: 'from the pack' }).ok, true);
});

test('WS: a seat that reconnects is offered its unacked answer again', async () => {
  const d = await fx.call('POST', '/api/ask/dispatch', { ...A, body: { question: 'Reconnect?', options: ['Y'], askingSeat: 'helper.rc' } });
  const ws1 = new WebSocket(`${fx.wsUrl}?developer=helper.rc&project=alpha`, { headers: { 'X-Dev-Key': fx.keys.alpha } });
  const got1 = [];
  ws1.on('message', (m) => got1.push(JSON.parse(String(m))));
  await new Promise((r) => ws1.on('open', r));
  await fx.call('POST', `/api/ask/${d.body.askId}/answer`, { ...OWNER, body: { label: 'Y' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(got1.some((f) => f.id === `askans-${d.body.askId}`), 'live delivery');
  ws1.terminate(); // the session dies before it acks
  const again = await fx.call('GET', '/api/ask/pending-answers?seat=helper.rc', A);
  assert.equal(again.body.answers.length, 1, 'still offered after a live send that was never acked');
  await fx.call('POST', `/api/ask/${d.body.askId}/ack`, { ...A, body: { seat: 'helper.rc' } });
  assert.equal((await fx.call('GET', '/api/ask/pending-answers?seat=helper.rc', A)).body.answers.length, 0);
});
