// Reconnect replay (client/replay.js) against a mock bus: the cursor, the DM scoping, the resync notice and the failure cases.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenInRange, closeServer } from './helpers.mjs';
import { numericId, createSeenSet, replayOnReconnect } from '../../client/replay.js';

const requests = [];
let answer = () => ({ status: 200, body: { messages: [] } });
const server = http.createServer((req, res) => {
  requests.push({ url: new URL(req.url, 'http://x'), key: req.headers['x-dev-key'], project: req.headers['x-dev-project'] });
  const a = answer(req);
  if (a === 'hang') return;
  res.writeHead(a.status, { 'content-type': 'application/json' });
  res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
});
const port = await listenInRange(server);
const httpUrl = `http://127.0.0.1:${port}`;
after(() => closeServer(server));

const collect = () => {
  const delivered = []; const notices = [];
  return { delivered, notices, deliver: async (m) => { delivered.push(m); }, notice: async (t) => { notices.push(t); } };
};

test('numericId: strict digits after an optional msg- prefix', () => {
  assert.equal(numericId('msg-123'), 123);
  assert.equal(numericId('45'), 45);
  for (const bad of ['', null, undefined, 'msg-', 'msg-12a', 'abc', 'msg--1']) assert.equal(numericId(bad), null, String(bad));
});

test('createSeenSet: bounded, oldest evicted first, forget removes', () => {
  const s = createSeenSet(2);
  s.mark('a'); s.mark('b'); s.mark('c');
  assert.equal(s.has('a'), false);
  assert.equal(s.has('b') && s.has('c'), true);
  assert.equal(s.size, 2);
  s.forget('b');
  assert.equal(s.has('b'), false);
  s.mark(null);
  assert.equal(s.size, 1);
});

test('a cursor replays strictly after it, scoped to this seat, with the key and project headers; the server head wins', async () => {
  requests.length = 0;
  answer = () => ({ status: 200, body: { messages: [{ id: 'msg-5', content: 'a' }, { id: 'msg-6', content: 'b' }], cursor: 'msg-9' } });
  const c = collect();
  const cursor = await replayOnReconnect({ httpUrl, project: 'proj', key: 'k1', developer: 'bot.seat', sinceId: 'msg-4', deliver: c.deliver, notice: c.notice });
  assert.equal(cursor, 'msg-9');
  assert.deepEqual(c.delivered.map((m) => m.id), ['msg-5', 'msg-6']);
  assert.deepEqual(c.notices, []);
  const r = requests[0];
  assert.equal(r.url.pathname, '/api/messages');
  assert.equal(r.url.searchParams.get('since_id'), 'msg-4');
  assert.equal(r.url.searchParams.get('developer'), 'bot.seat');
  assert.equal(r.url.searchParams.has('replay'), false);
  assert.equal(r.key, 'k1');
  assert.equal(r.project, 'proj');
});

test('without a server head, the cursor is the last delivered id', async () => {
  answer = () => ({ status: 200, body: { messages: [{ id: 'msg-7' }, { id: 'msg-8' }] } });
  const c = collect();
  assert.equal(await replayOnReconnect({ httpUrl, key: 'k', sinceId: 'msg-6', deliver: c.deliver }), 'msg-8');
});

test('no cursor yet: asks for replay=1; a resync then seeds to head silently', async () => {
  requests.length = 0;
  answer = () => ({ status: 200, body: { resync_required: true, reason: 'missing', head_id: 'msg-20' } });
  const c = collect();
  const cursor = await replayOnReconnect({ httpUrl, key: 'k', developer: 'bot', sinceId: null, deliver: c.deliver, notice: c.notice });
  assert.equal(cursor, 'msg-20');
  assert.equal(requests[0].url.searchParams.get('replay'), '1');
  assert.equal(requests[0].url.searchParams.has('since_id'), false);
  assert.equal(requests[0].project, undefined, 'no project header without a project');
  assert.deepEqual(c.notices, [], 'no false alarm');
});

test('a held cursor the server rejects gives one notice and jumps to head; a null head holds the cursor but still warns', async () => {
  answer = () => ({ status: 200, body: { resync_required: true, reason: 'too_old', head_id: 'msg-30' } });
  const c = collect();
  assert.equal(await replayOnReconnect({ httpUrl, key: 'k', sinceId: 'msg-2', deliver: c.deliver, notice: c.notice }), 'msg-30');
  assert.equal(c.notices.length, 1);
  assert.match(c.notices[0], /gap too large to replay \(too_old\).*dev_msg_history/);
  answer = () => ({ status: 200, body: { resync_required: true, reason: 'evicted', head_id: null } });
  const d = collect();
  assert.equal(await replayOnReconnect({ httpUrl, key: 'k', sinceId: 'msg-2', deliver: d.deliver, notice: d.notice }), 'msg-2');
  assert.equal(d.notices.length, 1);
});

test('an unreachable bus or a non-JSON answer holds the cursor and never throws', async () => {
  answer = () => ({ status: 200, body: '{nope' });
  assert.equal(await replayOnReconnect({ httpUrl, key: 'k', sinceId: 'msg-3' }), 'msg-3');
  const closed = http.createServer();
  const freePort = await listenInRange(closed);
  await new Promise((r) => closed.close(r));
  assert.equal(await replayOnReconnect({ httpUrl: `http://127.0.0.1:${freePort}`, key: 'k', sinceId: 'msg-3' }), 'msg-3');
  assert.equal(await replayOnReconnect({ httpUrl, key: 'k', sinceId: 'msg-3', fetchImpl: async () => { throw new Error('down'); } }), 'msg-3');
});
