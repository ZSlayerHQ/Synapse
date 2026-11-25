// DM receipts through the real tool handlers: dev_msg_send surfaces a 200 body `error` and the receipt texts, and
// dev_msg_history uses the base-addressed DM rule, as a dotted seat. The client is pointed at a mock bus by its home config before
// import; the key travels in the X-Dev-Key header from DEV_SYNC_KEY.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pinEnv, answerBusProof, listenInRange, closeServer } from './helpers.mjs';

const keys = [];
const historyQueries = [];
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  if (answerBusProof(req, res)) return;
  const p = new URL(req.url, 'http://x').pathname;
  keys.push(req.headers['x-dev-key']);
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (p === '/api/message/direct') {
      const { to } = JSON.parse(raw || '{}');
      if (to === 'code') return json(res, { ok: true, id: 'msg-1', recipients: 0, recipientKind: 'channel_name', error: 'Not delivered: "code" is a channel, not a bot or person.' });
      if (to === 'reviewer') return json(res, { ok: true, id: 'msg-2', recipients: 2, recipientKind: 'connected' });
      if (to === 'pat') return json(res, { ok: true, id: 'msg-3', recipients: 0, recipientKind: 'human' });
      return json(res, { ok: true, id: 'msg-4' }); // a bus without receipt fields
    }
    if (p === '/api/messages') {
      historyQueries.push(new URL(req.url, 'http://x').searchParams);
      return json(res, { messages: [
        { id: 'msg-10', channel: 'direct', sender: 'x', to: 'receipttest', content: 'to my base', timestamp: '2026-11-11T10:00:00.000Z' },
        { id: 'msg-11', channel: 'direct', sender: 'x', to: 'receipttest.desk', content: 'to my exact seat', timestamp: '2026-11-11T10:00:01.000Z' },
        { id: 'msg-12', channel: 'direct', sender: 'x', to: 'receipttest.other', content: 'to a sibling seat', timestamp: '2026-11-11T10:00:02.000Z' },
        { id: 'msg-13', channel: 'direct', sender: 'receipttest.desk', to: 'y', content: 'my own send', timestamp: '2026-11-11T10:00:03.000Z' },
      ] });
    }
    json(res, { ok: true });
  });
});
const port = await listenInRange(server);
after(() => closeServer(server));

pinEnv({ DEV_SYNC_SEAT: 'desk', DEV_SYNC_KEY: 'receipt-key' }, { port });
process.argv.push('--developer', 'receipttest');
const { handleToolCall, DEVELOPER } = await import('../../client/index.js');
const call = (name, args = {}) => Promise.race([
  handleToolCall({ params: { name, arguments: args } }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('no answer within 5 s')), 5000)),
]);
const textOf = (out) => out.content.map((c) => c.text).join('\n');

test('the seat suffix comes from DEV_SYNC_SEAT', () => {
  assert.equal(DEVELOPER, 'receipttest.desk');
});

test('a 200 body error is an MCP error result carrying the bus sentence', async () => {
  const out = await call('dev_msg_send', { to: 'code', content: 'abc' });
  assert.equal(out.isError, true);
  assert.equal(textOf(out), 'Not delivered: "code" is a channel, not a bot or person.');
});

test('connected and human texts; a bus without receipt fields gets the plain text', async () => {
  assert.equal(textOf(await call('dev_msg_send', { to: 'reviewer', content: 'abc' })), 'Sent to reviewer (3 chars): reached 2 live connections.');
  assert.match(textOf(await call('dev_msg_send', { to: 'pat', content: 'abc' })), /whether they have seen it is not confirmed/);
  const old = await call('dev_msg_send', { to: 'someone', content: 'abc' });
  assert.equal(textOf(old), 'Sent to someone (3 chars)');
  assert.ok(!old.isError);
});

test('history as a dotted seat: base-addressed, exact and own DMs; never a sibling seat\'s', async () => {
  const out = textOf(await call('dev_msg_history', { channel: 'direct', limit: 20, full: true }));
  assert.match(out, /to my base/);
  assert.match(out, /to my exact seat/);
  assert.match(out, /my own send/);
  assert.doesNotMatch(out, /to a sibling seat/);
  // The bus returns direct messages only for the identity in ?developer=, so the read names this seat.
  assert.equal(historyQueries.at(-1).get('developer'), 'receipttest.desk');
});

test('every request carried the key from the environment in X-Dev-Key', () => {
  assert.ok(keys.length > 0);
  assert.ok(keys.every((k) => k === 'receipt-key'), JSON.stringify(keys));
});
