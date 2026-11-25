// The dev_ask answer outbox and the hooks' seat file. First the pieces in-process (makeAskOutbox with a stubbed bus, the seat
// file helpers on a temp home), then the real client spawned over stdio against a real bus that is stopped and started again
// on the same home and port: an answer given while the client is disconnected reaches the session after it reconnects, and
// the outbox is empty afterwards. Buses bind 127.0.0.1 on a random port in 4600-4999; the child's seat and home are pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pinEnv, childEnv, tempHome, CLIENT_INDEX } from './helpers.mjs';
import { makeHome, randomPort, FORBIDDEN_PORT } from '../helpers/bus.mjs';
import { createBus } from '../../server/server.mjs';

pinEnv();
const { makeAskOutbox, askIdOfAnswer, seatFileName, seatFilePath, writeSeatFile, removeSeatFile } = await import('../../client/index.js');

// ─── The outbox, with a stubbed bus ───

// A stub bus: `pending` is the outbox the GET returns; `ackOk(askId)` decides each ack's answer. Records every call.
function stubBus({ pending = [], ackOk = () => true } = {}) {
  const calls = [];
  const api = async (method, p, body) => {
    calls.push([method, p, body]);
    if (method === 'GET' && p.startsWith('/api/ask/pending-answers?')) return { answers: pending.map((askId) => ({ askId, id: `askans-${askId}`, content: `answer ${askId}` })) };
    const m = /^\/api\/ask\/([^/]+)\/ack$/.exec(p);
    if (method === 'POST' && m) return ackOk(decodeURIComponent(m[1])) ? { ok: true, acked: true } : { error: 'Synapse unreachable: down' };
    return { error: 'unexpected call' };
  };
  const acks = () => calls.filter(([m, p]) => m === 'POST' && p.endsWith('/ack')).map(([, p, b]) => [decodeURIComponent(p.split('/')[3]), b.seat]);
  return { api, calls, acks };
}

test('sync: each pending answer is injected once, acked with the full seat after its injection, and an already injected one is only acked', async () => {
  const bus = stubBus({ pending: ['a1', 'a2'] });
  const order = [];
  const inject = async (a) => { order.push(`inject ${a.askId}`); return true; };
  const box = makeAskOutbox({ api: async (...x) => { if (x[0] === 'POST') order.push(`ack ${x[1].split('/')[3]}`); return bus.api(...x); }, seat: 'alphabot.rc', inject });
  assert.deepEqual(await box.sync(), { acked: 2 });
  assert.deepEqual(order, ['inject a1', 'ack a1', 'inject a2', 'ack a2'], 'an ack only after its injection');
  assert.deepEqual(bus.acks(), [['a1', 'alphabot.rc'], ['a2', 'alphabot.rc']]);
  assert.equal(bus.calls[0][1], '/api/ask/pending-answers?seat=alphabot.rc');
  // The next connect lists them again (say the acks were lost): no second injection, only the acks.
  order.length = 0;
  await box.sync();
  assert.deepEqual(order, ['ack a1', 'ack a2']);
});

test('sync: an injection that throws or does not resolve true is never acked, and is injected again at the next connect', async () => {
  const bus = stubBus({ pending: ['t1', 'f1'] });
  let fail = true;
  const injected = [];
  const box = makeAskOutbox({ api: bus.api, seat: 's', inject: async (a) => {
    if (fail && a.askId === 't1') throw new Error('emit failed');
    if (fail && a.askId === 'f1') return false;
    injected.push(a.askId); return true;
  } });
  assert.deepEqual(await box.sync(), { acked: 0 });
  assert.deepEqual(bus.acks(), [], 'nothing acked');
  fail = false;
  await box.sync();
  assert.deepEqual(injected, ['t1', 'f1']);
  assert.deepEqual(bus.acks().map(([id]) => id), ['t1', 'f1']);
});

test('a failed ack is not retried in a loop: the next connect acks it again without injecting it twice', async () => {
  let up = false;
  const bus = stubBus({ pending: ['k1'], ackOk: () => up });
  let injections = 0;
  const box = makeAskOutbox({ api: bus.api, seat: 's', inject: async () => { injections++; return true; } });
  assert.deepEqual(await box.sync(), { acked: 0 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bus.acks().length, 1, 'one ack attempt, no retry until the next connect');
  up = true;
  assert.deepEqual(await box.sync(), { acked: 1 });
  assert.equal(injections, 1, 'injected once');
  assert.equal(bus.acks().length, 2);
});

test('a live answer: noteInjected acks it, and a later sync does not inject it again; a failed outbox read injects and acks nothing', async () => {
  const bus = stubBus({ pending: ['live1'] });
  let injections = 0;
  const box = makeAskOutbox({ api: bus.api, seat: 'alphabot', inject: async () => { injections++; return true; } });
  assert.equal(await box.noteInjected('live1'), true);
  await box.sync();
  assert.equal(injections, 0);
  assert.deepEqual(bus.acks(), [['live1', 'alphabot'], ['live1', 'alphabot']]);
  const down = makeAskOutbox({ api: async () => ({ error: 'Synapse unreachable: x' }), seat: 's', inject: async () => { injections++; return true; } });
  assert.deepEqual(await down.sync(), { error: 'Synapse unreachable: x' });
  assert.equal(injections, 0);
});

test('sync waits for the host to be ready: nothing is read, injected or acked before ready() resolves', async () => {
  const bus = stubBus({ pending: ['r1'] });
  let open;
  const gate = new Promise((r) => { open = r; });
  const injected = [];
  const box = makeAskOutbox({ api: bus.api, seat: 's', ready: () => gate, inject: async (a) => { injected.push(a.askId); return true; } });
  const run = box.sync();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bus.calls.length, 0, 'no outbox read before the host is ready');
  open();
  assert.deepEqual(await run, { acked: 1 });
  assert.deepEqual(injected, ['r1']);
});

test('sync drains a backlog page by page, and retries a failed injection after each bounded delay, then stops', async () => {
  const { OUTBOX_PAGE } = await import('../../client/index.js');
  // The stub serves at most one page of what is still unacked, as the server does.
  const left = Array.from({ length: OUTBOX_PAGE + 5 }, (_, i) => `p${i}`);
  const calls = [];
  const api = async (method, p) => {
    calls.push(method);
    if (method === 'GET') return { answers: left.slice(0, OUTBOX_PAGE).map((askId) => ({ askId, content: askId })) };
    const id = decodeURIComponent(p.split('/')[3]);
    left.splice(left.indexOf(id), 1);
    return { ok: true, acked: true };
  };
  const paged = makeAskOutbox({ api, seat: 's', inject: async () => true });
  assert.deepEqual(await paged.sync(), { acked: OUTBOX_PAGE + 5 });
  assert.equal(left.length, 0, 'the whole backlog in one sync');
  assert.equal(calls.filter((m) => m === 'GET').length, 2);

  const bus = stubBus({ pending: ['x1'] });
  let tries = 0;
  const slept = [];
  const flaky = makeAskOutbox({ api: bus.api, seat: 's', retryDelaysMs: [5, 10], sleep: async (ms) => { slept.push(ms); }, inject: async () => ++tries >= 3 });
  assert.deepEqual(await flaky.sync(), { acked: 1 }, 'the third try injects it');
  assert.deepEqual(slept, [5, 10]);
  const never = makeAskOutbox({ api: stubBus({ pending: ['y1'] }).api, seat: 's', retryDelaysMs: [1, 1], sleep: async () => {}, inject: async () => false });
  let n = 0;
  const counting = makeAskOutbox({ api: stubBus({ pending: ['y2'] }).api, seat: 's', retryDelaysMs: [1, 1], sleep: async () => {}, inject: async () => { n++; return false; } });
  assert.deepEqual(await never.sync(), { acked: 0 });
  await counting.sync();
  assert.equal(n, 3, 'one try plus one per delay, then it waits for the next connect');
});

test('askIdOfAnswer: only a dev_ask frame with an askans- id', () => {
  assert.equal(askIdOfAnswer({ source: 'dev_ask', id: 'askans-9f' }), '9f');
  assert.equal(askIdOfAnswer({ source: 'dev_ask', id: 'msg-3' }), null);
  assert.equal(askIdOfAnswer({ source: 'user', id: 'askans-9f' }), null);
  assert.equal(askIdOfAnswer({ source: 'dev_ask', id: 'askans-' }), null);
  assert.equal(askIdOfAnswer(null), null);
});

// ─── The seat file ───

test('seatFileName: the first 32 hex characters of the session id\'s sha256, plus .json', () => {
  const id = '3f1c2a9e-0000-4b4b-9c9c-123456789abc';
  assert.equal(seatFileName(id), `${crypto.createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`);
  assert.match(seatFileName(id), /^[0-9a-f]{32}\.json$/);
  assert.notEqual(seatFileName(id), seatFileName(`${id}x`));
  assert.equal(seatFilePath('/h', id), path.join('/h', 'data', 'seats', seatFileName(id)));
});

test('writeSeatFile makes the folder and writes the seat; removeSeatFile removes only this process\'s file; failures never throw', () => {
  const home = tempHome();
  try {
    const file = writeSeatFile({ home, sessionId: 'sess-1', developer: 'alphabot.rc', project: 'alpha', pid: 4242, now: () => new Date(Date.UTC(2026, 10, 25)) });
    assert.equal(file, seatFilePath(home, 'sess-1'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { developer: 'alphabot.rc', project: 'alpha', pid: 4242, updatedAt: '2026-11-25T00:00:00.000Z' });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], 'no temp file left');
    removeSeatFile(file, 9999);
    assert.ok(fs.existsSync(file), 'another process\'s file stays');
    removeSeatFile(file, 4242);
    assert.ok(!fs.existsSync(file));
    assert.equal(JSON.parse(fs.readFileSync(writeSeatFile({ home, sessionId: 'sess-2', developer: 'b' }), 'utf8')).project, null);
    assert.equal(writeSeatFile({ home, sessionId: '', developer: 'b' }), null, 'no session id, no file');
    assert.equal(writeSeatFile({ home, sessionId: undefined, developer: 'b' }), null);
    const notADir = path.join(home, 'plain-file');
    fs.writeFileSync(notADir, 'x');
    assert.equal(writeSeatFile({ home: notADir, sessionId: 's', developer: 'b' }), null, 'a failed write returns null');
    removeSeatFile(path.join(home, 'missing.json'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ─── The real client across a bus restart ───

const OWNER = { name: 'owner1', key: 'owner-key-0123456789' }; // makeHome's default owner
const SESSION_ID = 'reconnect-outbox-test-session';
const RECONNECT_MS = 2500;

async function busOn(home, port) {
  assert.notEqual(port, FORBIDDEN_PORT);
  const bus = await createBus({ home, env: {}, port, host: '127.0.0.1', log: () => {} });
  try { await bus.start(); } catch (e) { await bus.stop(); throw e; }
  return bus;
}

// A line-delimited JSON-RPC peer over the child's stdio, with a wait on stderr text.
function rpcPeer(child) {
  let out = '';
  let err = '';
  let nextId = 1;
  const pending = new Map();
  const notes = [];
  const waiters = new Set();
  const poke = () => { for (const w of waiters) w(); };
  child.stdout.on('data', (d) => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i).trim();
      out = out.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else if (msg.method) notes.push(msg);
    }
    poke();
  });
  child.stderr.on('data', (d) => { err += d; poke(); });
  const until = (pred, ms, what) => new Promise((resolve, reject) => {
    const check = () => { const v = pred(); if (v) { waiters.delete(check); clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timed out after ${ms} ms waiting for ${what}; client stderr:\n${err}`)); }, ms);
    waiters.add(check);
    check();
  });
  return {
    notes,
    stderr: () => err,
    request: (method, params) => new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    }),
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`),
    until,
    stderrAfter: (mark, text, ms) => until(() => err.indexOf(text, mark) >= 0, ms, `"${text}" on stderr`),
  };
}

test('the real client: a card answered while it is disconnected arrives after the reconnect, is acked, and leaves the outbox empty', { timeout: 60000 }, async () => {
  // The client binds to the project registered at its working folder and to the bus in the home config.
  const projDir = tempHome('synapse-reconnect-proj-');
  const fx = makeHome({ projects: { alpha: { bots: ['alphabot'], root: projDir.replace(/\\/g, '/') } } });
  let bus = null;
  let port = 0;
  for (let i = 0; i < 8 && !bus; i++) {
    port = randomPort();
    try { bus = await busOn(fx.home, port); } catch (e) { if (i === 7) throw e; }
  }
  const SEAT = 'alphabot.rc';
  const cfgFile = path.join(fx.home, 'synapse.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), server: { host: '127.0.0.1', port } }));
  const child = spawn(process.execPath, [CLIENT_INDEX, '--project', 'alpha', '--developer', 'alphabot', '--key-env', 'SYNAPSE_KEY_ALPHA'], {
    cwd: projDir,
    env: childEnv({ SYNAPSE_HOME: fx.home, DEV_SYNC_SEAT: 'rc', SYNAPSE_KEY_ALPHA: fx.keys.alpha, DEV_SYNC_RECONNECT_MS: String(RECONNECT_MS), CLAUDE_CODE_SESSION_ID: SESSION_ID }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const peer = rpcPeer(child);
  const base = () => `http://127.0.0.1:${port}`;
  const pendingAnswers = async () => {
    const r = await fetch(`${base()}/api/ask/pending-answers?seat=${SEAT}`, { headers: { 'X-Dev-Key': fx.keys.alpha, 'X-Dev-Project': 'alpha' } });
    assert.equal(r.status, 200);
    return (await r.json()).answers;
  };
  try {
    const init = await peer.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reconnect-test', version: '0' } });
    assert.ok(init.result && init.result.capabilities.experimental['claude/channel'], JSON.stringify(init));
    peer.notify('notifications/initialized');
    await peer.stderrAfter(0, `Connected as "${SEAT}" [project=alpha]`, 10000);

    // The seat file the hooks read: the full seat, the project and this client's pid.
    const seatFile = seatFilePath(fx.home, SESSION_ID);
    const seat = JSON.parse(fs.readFileSync(seatFile, 'utf8'));
    assert.deepEqual([seat.developer, seat.project, seat.pid], [SEAT, 'alpha', child.pid]);
    assert.ok(Number.isFinite(Date.parse(seat.updatedAt)));

    const asked = await peer.request('tools/call', { name: 'dev_ask', arguments: { question: 'Ship it?', options: ['Yes', 'No'] } });
    const askText = asked.result.content[0].text;
    const askId = (/askId ([0-9a-f-]{36})/.exec(askText) || [])[1];
    assert.ok(askId, askText);
    assert.ok(askText.includes(`on the Synapse dashboard at http://127.0.0.1:${port}/ (askId ${askId})`), askText);

    // Stop the bus; the client sees the close and schedules one reconnect RECONNECT_MS later.
    const mark = peer.stderr().length;
    await bus.stop();
    bus = null;
    await peer.stderrAfter(mark, 'Disconnected', 10000);
    const disconnectedAt = Date.now();

    // A new bus on the same home and port (the ask store persists in <home>/data); the owner answers before the client is back.
    bus = await busOn(fx.home, port);
    const r = await fetch(`${base()}/api/ask/${askId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Synapse-Human': OWNER.name, 'X-Dev-Key': OWNER.key }, body: JSON.stringify({ label: 'Yes' }) });
    const answered = await r.json();
    assert.equal(r.status, 200, JSON.stringify(answered));
    assert.ok(Date.now() - disconnectedAt < RECONNECT_MS, 'the answer was given before the client could reconnect');
    assert.equal(answered.delivered, false, 'no live socket took it: it waits in the outbox');
    assert.equal((await pendingAnswers()).length, 1, 'one answer in the outbox');

    // After the reconnect the answer reaches the session as a channel notification...
    const note = await peer.until(() => peer.notes.find((n) => n.method === 'notifications/claude/channel' && n.params.meta.message_id === `askans-${askId}`), 15000, 'the answer notification');
    assert.match(note.params.content, /Selected: Yes/);
    assert.equal(note.params.meta.chat_id, 'direct');
    // ...and the client acks it, so the outbox empties.
    let left = null;
    for (let i = 0; i < 50; i++) {
      left = await pendingAnswers();
      if (!left.length) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(left.length, 0, 'the outbox is empty after the ack');
    assert.equal(peer.notes.filter((n) => n.params && n.params.meta && n.params.meta.message_id === `askans-${askId}`).length, 1, 'injected once');

    // A clean exit (the host closes stdin) removes the seat file.
    child.stdin.end();
    const how = await Promise.race([exited, new Promise((res) => setTimeout(() => res('still running'), 10000))]);
    assert.deepEqual(how, { code: 0, signal: null });
    assert.ok(!fs.existsSync(seatFile), 'the seat file is removed on a clean exit');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (bus) await bus.stop();
    fs.rmSync(fx.home, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});
