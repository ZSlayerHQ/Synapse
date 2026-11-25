// DM receipts, client side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinEnv } from './helpers.mjs';

pinEnv();
const { directSentText, isMyDm, makeApi } = await import('../../client/index.js');

test('connected: names the connection count, singular and plural', () => {
  assert.equal(directSentText('reviewer', 5, { ok: true, id: 'msg-1', recipients: 1, recipientKind: 'connected' }),
    'Sent to reviewer (5 chars): reached 1 live connection.');
  assert.equal(directSentText('reviewer', 5, { ok: true, id: 'msg-1', recipients: 2, recipientKind: 'connected' }),
    'Sent to reviewer (5 chars): reached 2 live connections.');
});

test('human: stored for the person, read on the dashboard (Discord only as the optional pack), not confirmed seen', () => {
  assert.equal(directSentText('pat', 3, { ok: true, id: 'msg-1', recipients: 0, recipientKind: 'human' }),
    'Sent to pat (3 chars): stored for that person, who reads it on the dashboard (or on Discord when that pack is enabled); whether they have seen it is not confirmed.');
});

test('a bus without recipientKind gets the plain text', () => {
  assert.equal(directSentText('reviewer', 5, { ok: true, id: 'msg-1' }), 'Sent to reviewer (5 chars)');
  assert.equal(directSentText('reviewer', 5, null), 'Sent to reviewer (5 chars)');
});

test('a 200 body carrying error reaches the caller as an error', async () => {
  const sentence = 'Not delivered: "code" is a channel, not a bot or person. To post in #code, send again with channel "code" and no "to".';
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true, id: 'msg-9', recipients: 0, recipientKind: 'channel_name', error: sentence }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  const api = makeApi({ httpUrl: 'http://bus.invalid', headers: () => ({}), defaultTimeoutMs: 5000, fetchImpl });
  const result = await api('POST', '/api/message/direct', { from: 'a', to: 'code', content: 'x' });
  assert.equal(result.error, sentence);
});

test('isMyDm: own sends, exact-seat and base-addressed incoming; never a sibling seat', () => {
  const seat = 'agentx.desk';
  assert.equal(isMyDm({ sender: seat, to: 'x' }, seat), true);
  assert.equal(isMyDm({ sender: 'x', to: seat }, seat), true);
  assert.equal(isMyDm({ sender: 'x', to: 'agentx' }, seat), true);
  assert.equal(isMyDm({ sender: 'x', to: 'agentx.other' }, seat), false);
  assert.equal(isMyDm({ sender: 'x', to: 'someone' }, seat), false);
  // A malformed seat has no base, as on the server: no base-addressed DMs.
  assert.equal(isMyDm({ sender: 'x', to: 'agentx' }, 'agentx.-bad'), false);
  assert.equal(isMyDm({ sender: 'x', to: 'agentx' }, 'agentx.a.b'), false);
  // An undotted identity matches exactly.
  assert.equal(isMyDm({ sender: 'x', to: 'agentx' }, 'agentx'), true);
  assert.equal(isMyDm({ sender: 'x', to: 'agentx.desk' }, 'agentx'), false);
});
