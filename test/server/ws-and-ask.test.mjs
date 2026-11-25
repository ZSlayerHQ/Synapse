// WebSocket auth and delivery, and the decision-card loop: a bot asks, a configured person answers on the dashboard
// API, the answer arrives at the asking seat. Real bus, random port.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBus } from '../helpers/bus.mjs';

const OWNER = { human: 'owner1', key: 'owner-key-0123456789' };
const fx = await startBus({
  projects: { alpha: { bots: ['alphabot', 'helper'] }, beta: { bots: ['betabot'] } },
  people: { owner1: { key: OWNER.key }, watcher: { key: 'watcher-key-0123456789', roles: ['pingable'] }, approver1: { key: 'approver-key-0123456789', roles: ['approver'], projects: ['beta'] } },
});
test.after(() => fx.close());

function connect({ developer, project = 'alpha', key = fx.keys[project], query = '', headers } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${fx.wsUrl}?developer=${developer}&project=${project}${query}`, { headers: headers || (key === null ? {} : { 'X-Dev-Key': key }) });
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    ws.on('open', () => setTimeout(() => resolve({ ws, frames, code: null }), 50));
    ws.on('close', (code) => resolve({ ws, frames, code }));
    ws.on('error', () => {});
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('WS: header auth connects; key in URL, empty, duplicate or missing closes 4001', async () => {
  const ok = await connect({ developer: 'alphabot' });
  assert.equal(ok.code, null);
  assert.equal(ok.frames[0].event, 'connected');
  ok.ws.close();
  assert.equal((await connect({ developer: 'alphabot', query: `&key=${fx.keys.alpha}` })).code, 4001, 'a key in the URL is refused even with a valid header');
  assert.equal((await connect({ developer: 'alphabot', key: null, query: `&key=${fx.keys.alpha}` })).code, 4001, 'query-only key refused (v2)');
  assert.equal((await connect({ developer: 'alphabot', headers: { 'X-Dev-Key': '' } })).code, 4001);
  assert.equal((await connect({ developer: 'alphabot', headers: { 'X-Dev-Key': `${fx.keys.alpha}, ${fx.keys.alpha}` } })).code, 4001);
  assert.equal((await connect({ developer: 'alphabot', key: null })).code, 4001);
  assert.equal((await connect({ developer: 'alphabot', key: fx.keys.beta })).code, 4001, 'another project\'s key');
});

test('WS: unknown project 4002, foreign identity 4003', async () => {
  assert.equal((await connect({ developer: 'alphabot', project: 'nosuch', key: fx.keys.alpha })).code, 4002);
  assert.equal((await connect({ developer: 'betabot', project: 'alpha' })).code, 4003);
  assert.equal((await connect({ developer: 'owner1', project: 'alpha' })).code, 4003, 'a project key cannot connect as a person');
});

test('WS: delivery is walled per project, never echoes, and direct messages reach seats', async () => {
  const a = await connect({ developer: 'alphabot' });
  const h = await connect({ developer: 'helper.s1' });
  const b = await connect({ developer: 'betabot', project: 'beta' });
  await fx.call('POST', '/api/message', { key: fx.keys.alpha, project: 'alpha', body: { sender: 'alphabot', channel: 'code', content: 'hello-alpha' } });
  await fx.call('POST', '/api/message/direct', { key: fx.keys.alpha, project: 'alpha', body: { from: 'alphabot', to: 'helper', content: 'dm-to-helper' } });
  await wait(150);
  const text = (c) => JSON.stringify(c.frames);
  assert.ok(text(h).includes('hello-alpha'));
  assert.ok(text(h).includes('dm-to-helper'), 'a base-addressed DM reaches the seat');
  assert.ok(!text(a).includes('hello-alpha'), 'no echo to the sender');
  assert.ok(!text(b).includes('hello-alpha') && !text(b).includes('dm-to-helper'), 'project wall');
  for (const c of [a, h, b]) c.ws.close();
});

test('direct receipt tells an offline or unknown target apart', async () => {
  const r = await fx.call('POST', '/api/message/direct', { key: fx.keys.alpha, project: 'alpha', body: { from: 'alphabot', to: 'nobody-here', content: 'x' } });
  assert.equal(r.body.recipientKind, 'unrecognized');
  const k = await fx.call('POST', '/api/message/direct', { key: fx.keys.alpha, project: 'alpha', body: { from: 'alphabot', to: 'helper', content: 'x' } });
  assert.equal(k.body.recipientKind, 'known_offline');
});

test('cards: a bot asks, the owner sees it, keys that are not people cannot answer, the answer reaches the seat', async () => {
  const seat = await connect({ developer: 'alphabot.s1' });
  const d = await fx.call('POST', '/api/ask/dispatch', { key: fx.keys.alpha, project: 'alpha', body: { question: 'Ship it?', options: ['Yes', 'No'], askingSeat: 'alphabot.s1', context: 'why' } });
  assert.equal(d.status, 200);
  assert.equal(d.body.delivery, 'dashboard');
  const askId = d.body.askId;
  const open = await fx.call('GET', '/api/ask/open', OWNER);
  const card = open.body.cards.find((c) => c.askId === askId);
  assert.ok(card, 'the owner sees the card');
  assert.deepEqual(card.options.slice(0, 2), ['Yes', 'No']);
  assert.equal(card.canAnswer, true);
  // Refusals: a project key, a bot key, an unknown person, a person who is not an answerer here.
  assert.equal((await fx.call('POST', `/api/ask/${askId}/answer`, { key: fx.keys.alpha, project: 'alpha', body: { label: 'Yes' } })).status, 403);
  assert.equal((await fx.call('POST', `/api/ask/${askId}/answer`, { human: 'stranger', key: OWNER.key, body: { label: 'Yes' } })).status, 401);
  assert.equal((await fx.call('POST', `/api/ask/${askId}/answer`, { human: 'watcher', key: 'watcher-key-0123456789', body: { label: 'Yes' } })).status, 403, 'pingable is not an answerer');
  assert.equal((await fx.call('POST', `/api/ask/${askId}/answer`, { human: 'approver1', key: 'approver-key-0123456789', project: 'beta', body: { label: 'Yes' } })).status, 403, 'an approver of another project');
  assert.equal((await fx.call('POST', `/api/ask/${askId}/answer`, { ...OWNER, body: { label: 'Maybe' } })).status, 400, 'an unoffered label');
  const ans = await fx.call('POST', `/api/ask/${askId}/answer`, { ...OWNER, body: { label: 'Yes' } });
  assert.equal(ans.status, 200);
  assert.equal(ans.body.delivered, true);
  await wait(100);
  const line = seat.frames.find((f) => f.event === 'message' && f.id === `askans-${askId}`);
  assert.ok(line, 'the asking seat got the answer');
  assert.match(line.content, /Selected: Yes \| Answered by: owner1/);
  assert.equal((await fx.call('POST', `/api/ask/${askId}/answer`, { ...OWNER, body: { label: 'No' } })).status, 409, 'answered once only');
  seat.ws.close();
});

test('cards: an answer stays in the outbox until the seat acks it, and is offered again until then', async () => {
  const d = await fx.call('POST', '/api/ask/dispatch', { key: fx.keys.alpha, project: 'alpha', body: { question: 'Later?', options: ['A'], askingSeat: 'alphabot.s2' } });
  const ans = await fx.call('POST', `/api/ask/${d.body.askId}/answer`, { ...OWNER, body: { label: 'A' } });
  assert.equal(ans.body.delivered, false);
  const pending = () => fx.call('GET', '/api/ask/pending-answers?seat=alphabot.s2', { key: fx.keys.alpha, project: 'alpha' });
  const claim = await pending();
  assert.equal(claim.body.answers.length, 1);
  assert.equal(claim.body.answers[0].id, `askans-${d.body.askId}`);
  assert.equal((await pending()).body.answers.length, 1, 'a lost response loses nothing: listing does not consume');
  assert.equal((await fx.call('POST', `/api/ask/${d.body.askId}/ack`, { key: fx.keys.alpha, project: 'alpha', body: { seat: 'helper' } })).body.acked, false, 'another seat cannot ack it');
  assert.equal((await fx.call('POST', `/api/ask/${d.body.askId}/ack`, { key: fx.keys.alpha, project: 'alpha', body: { seat: 'alphabot.s2' } })).body.acked, true);
  assert.equal((await pending()).body.answers.length, 0);
  assert.equal((await fx.call('POST', `/api/ask/${d.body.askId}/ack`, { key: fx.keys.alpha, project: 'alpha', body: { seat: 'alphabot.s2' } })).body.acked, false, 'acked once');
  assert.equal((await fx.call('GET', '/api/ask/pending-answers?seat=betabot', { key: fx.keys.alpha, project: 'alpha' })).status, 403, 'cannot claim for a foreign seat');
});

test('cards: askingSeat must be assertable; a project with no answerer refuses before parking', async () => {
  assert.equal((await fx.call('POST', '/api/ask/dispatch', { key: fx.keys.alpha, project: 'alpha', body: { question: 'q', options: ['a'], askingSeat: 'betabot' } })).status, 403);
  const solo = await startBus({ projects: { gamma: { bots: ['gbot'] } }, people: { owner1: { key: OWNER.key, projects: ['delta'] } }, config: {} });
  try {
    const r = await solo.call('POST', '/api/ask/dispatch', { key: solo.keys.gamma, project: 'gamma', body: { question: 'q', options: ['a'], askingSeat: 'gbot' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'no_answerer');
  } finally { await solo.close(); }
});

test('notify: tags are validated against people; nothing is claimed as delivered without a push channel', async () => {
  const tags = await fx.call('GET', '/api/notify/tags', { key: fx.keys.alpha, project: 'alpha' });
  assert.deepEqual(tags.body.tags.sort(), ['owner1', 'watcher']);
  assert.equal((await fx.call('POST', '/api/notify', { key: fx.keys.alpha, project: 'alpha', body: { sender: 'alphabot', message: 'm', tag: 'approver1' } })).status, 400, 'approver1 is not in alpha');
  const r = await fx.call('POST', '/api/notify', { key: fx.keys.alpha, project: 'alpha', body: { sender: 'alphabot', message: 'need you', tag: 'owner1', priority: 'action' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.delivered, false);
  assert.equal(r.body.via, 'dashboard');
  const n = await fx.call('GET', '/api/notifications', OWNER);
  assert.ok(n.body.notifications.some((x) => x.message === 'need you'));
  assert.equal((await fx.call('GET', '/api/notifications', { key: fx.keys.alpha, project: 'alpha' })).status, 403);
});

test('a person posts only as themselves', async () => {
  assert.equal((await fx.call('POST', '/api/message', { ...OWNER, body: { sender: 'alphabot', channel: 'code', content: 'x' } })).status, 403);
  const r = await fx.call('POST', '/api/message', { ...OWNER, body: { channel: 'code', content: 'from a person' } });
  assert.equal(r.status, 200);
  const m = await fx.call('GET', '/api/messages?channel=code', { key: fx.keys.alpha, project: 'alpha' });
  assert.ok(m.body.messages.some((x) => x.sender === 'owner1' && x.content === 'from a person'));
});

test('replay after reconnect: in order, and a lost cursor asks for a resync', async () => {
  const head = (await fx.call('POST', '/api/message', { key: fx.keys.alpha, project: 'alpha', body: { sender: 'alphabot', channel: 'code', content: 'r0' } })).body.id;
  await fx.call('POST', '/api/message', { key: fx.keys.alpha, project: 'alpha', body: { sender: 'alphabot', channel: 'code', content: 'r1' } });
  await fx.call('POST', '/api/message', { key: fx.keys.alpha, project: 'alpha', body: { sender: 'alphabot', channel: 'code', content: 'r2' } });
  const r = await fx.call('GET', `/api/messages?since_id=${head}&developer=helper`, { key: fx.keys.alpha, project: 'alpha' });
  assert.deepEqual(r.body.messages.map((m) => m.content), ['r1', 'r2']);
  const lost = await fx.call('GET', '/api/messages?since_id=garbage&developer=helper', { key: fx.keys.alpha, project: 'alpha' });
  assert.equal(lost.body.resync_required, true);
  assert.equal((await fx.call('GET', `/api/messages?since_id=${head}&developer=betabot`, { key: fx.keys.alpha, project: 'alpha' })).status, 403);
});
