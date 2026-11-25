// The core redacts every field it hands to a pack from the FULL text, before any of its own caps. A key placed so a
// core cap would cut it in two must not reach the pack, not even as a prefix. The bus's own copies stay as written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBus } from '../helpers/bus.mjs';
import { fakeToken } from '../helpers/discord-stub.mjs';

const seen = { cards: [], closed: [], relays: [], notifies: [] };
const OWNER = { human: 'owner1', key: 'owner-key-0123456789' };
const fx = await startBus({
  people: { owner1: { key: OWNER.key, accounts: { discord: '700000000000000101' } } },
  config: { discord: { enabled: true } },
  extraEnv: { SYNAPSE_DISCORD_TOKEN: fakeToken() },
  channelImporter: async () => ({
    createHumanChannel: async () => ({
      name: 'recorder', providers: ['discord'], reaches: () => true,
      async deliverAsk(card) { seen.cards.push(card); return { delivery: 'posted' }; },
      askClosed(a) { seen.closed.push(a); },
      relayMessage(m) { seen.relays.push(m); },
      async notify(n) { seen.notifies.push(n); return { delivered: false, via: 'recorder' }; },
    }),
  }),
});
test.after(() => fx.close());
const A = { key: fx.keys.alpha, project: 'alpha' };
const KEY = fx.keys.alpha;
const PREFIX = KEY.slice(0, 8);
// The key starts 8 characters before `cap`, so a cap applied first would keep exactly its first 8 characters.
const straddle = (cap, pad) => `${pad.repeat(cap - 8)}${KEY}`;
const leaks = (v) => JSON.stringify(v).includes(PREFIX);

test('dispatch: series (24), question and context (4000), recommendation (1000) and option labels (200) reach the pack redacted', async () => {
  const body = {
    question: straddle(4000, 'q'), series: straddle(24, 's'), context: straddle(4000, 'c'), recommendation: straddle(1000, 'r'),
    options: [straddle(200, 'o'), 'Plain'], askingSeat: 'alphabot',
  };
  const d = await fx.call('POST', '/api/ask/dispatch', { ...A, body });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const card = seen.cards.at(-1);
  for (const field of ['question', 'series', 'context', 'recommendation']) {
    assert.equal(typeof card[field], 'string', field);
    assert.ok(!card[field].includes(PREFIX), `${field}: no prefix of the key`);
    // The marker sits where the key began, so the cap that follows redaction may shorten it; never a key character.
    assert.ok(card[field].includes('[redact'), `${field}: the key was redacted, not dropped by the cap`);
  }
  assert.ok(!leaks(card.options), 'option labels');
  assert.equal(card.options[1], 'Plain', 'the options keep their order');
  // The bus's own copy (what decides the card) is the original, capped as before.
  const open = (await fx.call('GET', '/api/ask/open', OWNER)).body.cards.find((c) => c.askId === d.body.askId);
  assert.equal(open.options[0], body.options[0].slice(0, 200));
  assert.equal(open.series, body.series.slice(0, 24));
  // Answering with the stored label: the pack is told the label as it was shown, never the capped original.
  const r = await fx.call('POST', `/api/ask/${d.body.askId}/answer`, { ...OWNER, body: { label: body.options[0].slice(0, 200) } });
  assert.equal(r.status, 200);
  const closed = seen.closed.find((c) => c.askId === d.body.askId);
  assert.ok(closed && !leaks(closed), 'askClosed');
  const ans = (await fx.call('GET', '/api/ask/pending-answers?seat=alphabot', A)).body.answers.find((a) => a.askId === d.body.askId);
  assert.ok(ans.content.includes(PREFIX), 'the asking seat (on this machine) gets the original selection');
});

test('relay: message content capped at 8000 reaches the pack redacted; the bus keeps the original', async () => {
  const content = straddle(8000, 'm');
  await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'code', content } });
  const m = seen.relays.at(-1);
  assert.ok(m && !leaks(m), 'relayed message');
  assert.ok(m.content.includes('[redact'), 'the marker, possibly shortened by the cap after redaction');
  const stored = (await fx.call('GET', '/api/messages?channel=code&limit=5', A)).body.messages.find((x) => x.id === m.id);
  assert.equal(stored.content, content.slice(0, 8000), 'the stored copy is unchanged');
});

test('notify: the message capped at 8000 reaches the pack redacted', async () => {
  const r = await fx.call('POST', '/api/notify', { ...A, body: { sender: 'alphabot', message: straddle(8000, 'n'), tag: 'owner1' } });
  assert.equal(r.status, 200);
  const n = seen.notifies.at(-1);
  assert.ok(n && !leaks(n), 'notify');
  assert.ok(n.message.includes('[redact'), 'the marker, possibly shortened by the cap after redaction');
});
