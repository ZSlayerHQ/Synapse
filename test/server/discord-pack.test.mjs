// The Discord pack through the real core, with a stub transport in place of discord.js (never contacts Discord).
// Covers the relay both ways, cards and taps (unknown, no access, wrong channel or message, forged, replayed, stale,
// valid once), Other and Dismiss, notifications, redaction before clipping, log safety, a Discord-only answerer while
// disconnected, and the boot refusal without discord.js through the real server entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBus, makeHome } from '../helpers/bus.mjs';
import { createStubTransport, ids, interactionId, BOT_ID, fakeToken } from '../helpers/discord-stub.mjs';
import { createHumanChannel } from '../../server/packs/discord/index.mjs';
import { buildRelayText, buildCardMessage, errorCategory } from '../../server/packs/discord/text.mjs';
import { createRedactor } from '../../server/lib/redact.mjs';
import { DISCUSS_LABEL, DISMISS_LABEL } from '../../server/lib/ask-text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAMMA_CODE = '700000000000000204';
const GAM = '700000000000000104';
const stub = createStubTransport();
const logs = [];
const OWNER = { human: 'owner1', key: 'owner-key-0123456789' };
const fx = await startBus({
  projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] }, gamma: { bots: ['gammabot'] } },
  people: {
    owner1: { key: OWNER.key, projects: ['alpha', 'beta'], accounts: { discord: ids.owner } },
    appr: { roles: ['approver'], projects: ['beta'], accounts: { discord: ids.approverBeta } },
    pal: { roles: ['pingable'], projects: ['alpha'], accounts: { discord: ids.pingable } },
    gam: { roles: ['approver'], projects: ['gamma'], accounts: { discord: GAM } }, // no personal key: Discord only
  },
  config: { discord: { enabled: true, projects: {
    alpha: { channels: { code: ids.alphaCode, build: ids.alphaBuild } },
    beta: { channels: { code: ids.betaCode } },
    gamma: { channels: { code: GAMMA_CODE } },
  } } },
  extraEnv: { SYNAPSE_DISCORD_TOKEN: fakeToken() },
  channelImporter: async () => ({ createHumanChannel: (ctx) => createHumanChannel({ ...ctx, log: (l) => logs.push(l) }, { transport: stub }) }),
});
test.after(() => fx.close());
const A = { key: fx.keys.alpha, project: 'alpha' };
const B = { key: fx.keys.beta, project: 'beta' };
const G = { key: fx.keys.gamma, project: 'gamma' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const history = async (project = 'alpha') => (await fx.call('GET', `/api/messages?project=${project}&limit=200`, { ...OWNER, project })).body.messages;

async function card(question = 'Ship it?', options = ['Yes', 'No'], who = A, seat = 'alphabot') {
  stub.reset();
  const d = await fx.call('POST', '/api/ask/dispatch', { ...who, body: { question, options, askingSeat: seat } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.delivery, 'posted');
  const post = stub.posts.find((p) => stub.customIds(p).some((c) => c.startsWith(`ask|${d.body.askId}|`)));
  assert.ok(post, 'the card was posted with its buttons');
  return { askId: d.body.askId, post, answerers: d.body.answerers, labels: post.components.flatMap((r) => r.components.map((c) => c.label)) };
}
const pending = async (who = A, seat = 'alphabot') => (await fx.call('GET', `/api/ask/pending-answers?seat=${seat}`, who)).body.answers;
const ack = (askId, who = A, seat = 'alphabot') => fx.call('POST', `/api/ask/${askId}/ack`, { ...who, body: { seat } });

test('the pack is loaded behind the switch, started, and reports its connection in health', async () => {
  assert.equal(stub.started, 1);
  const h = await fx.call('GET', '/api/health');
  assert.equal(h.body.humanChannel, 'discord');
  assert.deepEqual(h.body.humanChannelStatus, { connected: true });
});

test('relay out: a mapped bus channel reaches its Discord channel, pings nobody, and carries no key', async () => {
  stub.reset();
  await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'build', content: `built ok; key ${fx.keys.alpha} @everyone` } });
  await sleep(20);
  assert.equal(stub.posts.length, 1);
  const p = stub.posts[0];
  assert.equal(p.channelId, ids.alphaBuild);
  assert.deepEqual(p.allowedMentions, { parse: [] });
  assert.match(p.content, /alphabot/);
  assert.ok(!p.content.includes(fx.keys.alpha), 'the project key was redacted');
  assert.match(p.content, /\[redacted\]/);
});

test('relay out: unmapped channels and project broadcasts stay on the bus', async () => {
  stub.reset();
  await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'qa', content: 'unmapped channel' } });
  await fx.call('POST', '/api/message', { ...B, body: { sender: 'betabot', channel: 'build', content: 'beta has no build mapping' } });
  await fx.call('POST', '/api/message/broadcast', { ...A, body: { sender: 'alphabot', content: 'to every bot of the project' } });
  await sleep(20);
  assert.deepEqual(stub.posts, [], 'nothing was mirrored');
});

test('relay out: a file is mirrored by name only, never with the inline preview of its content', async () => {
  stub.reset();
  const form = new FormData();
  form.append('channel', 'build');
  form.append('sender', 'alphabot');
  form.append('file', new Blob(['line one of a private log\nsecond line']), 'build.log');
  const up = await fetch(`${fx.base}/api/message/file`, { method: 'POST', headers: { 'X-Dev-Key': fx.keys.alpha, 'X-Dev-Project': 'alpha' }, body: form });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).relay, 'unconfirmed');
  await sleep(20);
  assert.equal(stub.posts.length, 1);
  assert.match(stub.posts[0].content, /build\.log/);
  assert.ok(!stub.posts[0].content.includes('private log'), 'the file content stays on the bus');
});

test('relay in: a mapped person is posted under their name and never echoed back; everyone else is refused and logged', async () => {
  stub.reset();
  logs.length = 0;
  await stub.message({ channelId: ids.alphaCode, authorId: ids.owner, content: 'hello from discord' });
  const mine = (await history()).find((m) => m.content === 'hello from discord');
  assert.ok(mine, 'posted to the bus');
  assert.deepEqual([mine.sender, mine.channel, mine.meta.via], ['owner1', 'code', 'discord']);
  await sleep(20);
  assert.equal(stub.posts.length, 0, 'not echoed back to Discord');
  await stub.message({ channelId: ids.alphaCode, authorId: ids.stranger, content: 'stranger here' });
  await stub.message({ channelId: ids.alphaCode, authorId: ids.approverBeta, content: 'approver of beta only' });
  await stub.message({ channelId: ids.alphaCode, authorId: ids.owner, content: 'from a bot account', authorIsBot: true });
  await stub.message({ channelId: ids.alphaCode, authorId: ids.owner, content: 'from a webhook', webhookId: '700000000000000900' });
  await stub.message({ channelId: ids.unmapped, authorId: ids.owner, content: 'unmapped discord channel' });
  const h = await history();
  for (const c of ['stranger here', 'approver of beta only', 'from a bot account', 'from a webhook', 'unmapped discord channel']) assert.ok(!h.some((m) => m.content === c), c);
  assert.ok(logs.some((l) => /refused a message .*unknown_account/.test(l)), 'the unknown account is logged');
  assert.ok(logs.some((l) => /refused a message .*not_allowed/.test(l)), 'the person without access is logged');
  assert.ok(!logs.some((l) => l.includes(ids.stranger) || l.includes(ids.approverBeta)), 'logs carry no Discord ids');
});

test('cards: buttons carry only the card id and an index; the answerers are mentioned and nobody else', async () => {
  const c = await card();
  assert.equal(c.post.channelId, ids.alphaCode);
  assert.deepEqual(c.labels.slice(-2), [DISCUSS_LABEL, DISMISS_LABEL], 'Other and Dismiss are on every card');
  assert.deepEqual(stub.customIds(c.post), c.labels.map((_, i) => `ask|${c.askId}|${i}`));
  assert.match(c.post.content, new RegExp(`<@${ids.owner}>`));
  assert.deepEqual(c.post.allowedMentions, { users: [ids.owner] });
});

test('taps: unknown id, no access, pingable only, foreign or other message, other channel, forged id, stale: all refused, the card stays open', async () => {
  const c = await card('Refusals?');
  const other = await card('Another card in the same channel?');
  const cid = `ask|${c.askId}|0`;
  const on = { channelId: ids.alphaCode, messageId: c.post.id };
  const cases = [
    [{ ...on, userId: ids.stranger, customId: cid }, /does not know your Discord account/],
    [{ ...on, userId: ids.approverBeta, customId: cid }, /not an owner or approver/],
    [{ ...on, userId: ids.pingable, customId: cid }, /not an owner or approver/],
    [{ ...on, userId: ids.owner, customId: cid, messageAuthorId: '700000000000000555' }, /not on a Synapse card/],
    [{ ...on, userId: ids.owner, customId: cid, messageId: other.post.id }, /not the card Synapse posted/],
    [{ ...on, userId: ids.owner, customId: cid, channelId: ids.alphaBuild }, /not the card Synapse posted/],
    [{ ...on, userId: ids.owner, customId: cid, channelId: ids.betaCode }, /not the card Synapse posted/],
    [{ ...on, userId: ids.owner, customId: cid, channelId: ids.unmapped }, /not on a Synapse card/],
    [{ ...on, userId: ids.owner, customId: `ask|${c.askId}|0|extra` }, /not on a Synapse card/],
    [{ ...on, userId: ids.owner, customId: `ask|${c.askId}|99` }, /not on a Synapse card/],
    [{ ...on, userId: ids.owner, customId: 'ask|not-a-uuid|0' }, /not on a Synapse card/],
    [{ ...on, userId: ids.owner, customId: cid, id: interactionId(60 * 60 * 1000) }, /too old/],
  ];
  stub.reset();
  for (const [tap, re] of cases) {
    stub.replies.length = 0;
    await stub.tap(tap);
    assert.equal(stub.replies.length, 1, JSON.stringify(tap));
    assert.match(stub.replies[0].text, re, JSON.stringify(tap));
  }
  assert.equal(stub.updates.length, 0, 'no card was closed');
  assert.equal((await pending()).filter((a) => a.askId === c.askId).length, 0, 'nothing was answered');
  const open = (await fx.call('GET', '/api/ask/open', OWNER)).body.cards;
  assert.ok(open.some((x) => x.askId === c.askId), 'the card is still open');
  await fx.call('POST', `/api/ask/${c.askId}/answer`, { ...OWNER, body: { label: DISMISS_LABEL } });
  await fx.call('POST', `/api/ask/${other.askId}/answer`, { ...OWNER, body: { label: DISMISS_LABEL } });
  await ack(c.askId); await ack(other.askId);
});

test('a valid tap answers exactly once; a replay of it and a second tap are refused', async () => {
  const c = await card('Once?', ['Alpha', 'Beta']);
  const first = await stub.tap({ userId: ids.owner, customId: `ask|${c.askId}|1`, channelId: ids.alphaCode, messageId: c.post.id });
  assert.equal(stub.updates.length, 1);
  assert.match(stub.updates[0].content, /Answered by owner1: Beta/);
  assert.deepEqual(stub.updates[0].components, []);
  assert.equal(stub.edits.length, 0, 'the tap updates the card itself; no second edit');
  const mine = (await pending()).filter((a) => a.askId === c.askId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].content, /Selected: Beta \| Answered by: owner1/);
  stub.replies.length = 0;
  await stub.tap({ id: first, userId: ids.owner, customId: `ask|${c.askId}|0`, channelId: ids.alphaCode, messageId: c.post.id });
  assert.equal(stub.replies.length, 0, 'the same interaction again is ignored outright');
  assert.equal(stub.updates.length, 1);
  await stub.tap({ userId: ids.owner, customId: `ask|${c.askId}|0`, channelId: ids.alphaCode, messageId: c.post.id });
  assert.match(stub.replies.at(-1).text, /already answered/);
  const after = (await pending()).filter((a) => a.askId === c.askId);
  assert.equal(after.length, 1);
  assert.match(after[0].content, /Selected: Beta/);
  await ack(c.askId);
});

test('Other (discuss) and Dismiss work from Discord', async () => {
  const other = await card('Discuss?', ['Go']);
  await stub.tap({ userId: ids.owner, customId: `ask|${other.askId}|${other.labels.indexOf(DISCUSS_LABEL)}`, channelId: ids.alphaCode, messageId: other.post.id });
  assert.match(stub.updates.at(-1).content, /Discussion[\s\S]*Reply in this channel/);
  const dismiss = await card('Dismiss?', ['Go']);
  await stub.tap({ userId: ids.owner, customId: `ask|${dismiss.askId}|${dismiss.labels.indexOf(DISMISS_LABEL)}`, channelId: ids.alphaCode, messageId: dismiss.post.id });
  assert.match(stub.updates.at(-1).content, /Dismissed by owner1: no decision/);
  const answers = await pending();
  assert.ok(answers.some((a) => a.askId === other.askId && a.content.includes(DISCUSS_LABEL)));
  assert.ok(answers.some((a) => a.askId === dismiss.askId && /closed with no decision/.test(a.content)));
  await stub.message({ channelId: ids.alphaCode, authorId: ids.owner, content: 'let us talk about it' });
  assert.ok((await history()).some((m) => m.content === 'let us talk about it' && m.sender === 'owner1'));
  for (const a of answers) await ack(a.askId);
});

test('an answer on the dashboard closes the Discord card too', async () => {
  const c = await card('Dashboard?', ['Ok']);
  assert.equal((await fx.call('POST', `/api/ask/${c.askId}/answer`, { ...OWNER, body: { label: 'Ok' } })).status, 200);
  await sleep(20);
  const e = stub.edits.find((x) => x.messageId === c.post.id);
  assert.ok(e, 'the card message was edited');
  assert.match(e.content, /Answered by owner1: Ok/);
  assert.deepEqual(e.components, []);
  await ack(c.askId);
});

test('redaction happens before clipping: a key cut by the 300-character limit leaves no prefix anywhere', async () => {
  const key = fx.keys.alpha;
  const question = `${'q'.repeat(290)}${key}`;
  const c = await card(question, ['Ok']);
  const prefix = key.slice(0, 8);
  assert.ok(!c.post.content.includes(prefix), 'the open card');
  assert.match(c.post.content, /\\\[redacted\\\]/, 'the marker, escaped like the rest of the bold question line');
  await fx.call('POST', `/api/ask/${c.askId}/answer`, { ...OWNER, body: { label: 'Ok' } });
  await sleep(20);
  const e = stub.edits.find((x) => x.messageId === c.post.id);
  assert.ok(e && !e.content.includes(prefix), 'the closed card, built from the stored question');
  await ack(c.askId);
  // Headings and names too: every field goes through the redactor before it is escaped or clipped.
  const redact = createRedactor([key]);
  const relay = buildRelayText({ sender: `x${key}`, channel: 'code', content: 'hi' }, { redact });
  assert.ok(!relay.includes(prefix));
  const built = buildCardMessage({ askId: '00000000-0000-4000-8000-000000000000', project: `p${key}`, askingSeat: `s${key}`, question: 'q', options: [`o${key}`], series: `${key}`, context: `${'c'.repeat(1990)}${key}` }, { redact });
  assert.ok(!JSON.stringify(built).includes(prefix), 'heading, origin, series, context and labels');
});

test('logs: an external error is logged as a fixed category, never its message', async () => {
  logs.length = 0;
  const err = new Error(`Unknown Channel ${ids.alphaCode} while using ${fx.keys.alpha}`);
  stub.failNext = err;
  await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'build', content: 'will fail' } });
  await sleep(20);
  const line = logs.find((l) => /relay failed/.test(l));
  assert.equal(line, '[discord] relay failed (other)');
  stub.failNext = Object.assign(new Error(`Missing Access ${ids.alphaCode}`), { code: 50001, status: 403 });
  const d = await fx.call('POST', '/api/ask/dispatch', { ...A, body: { question: 'Fails?', options: ['x'], askingSeat: 'alphabot' } });
  assert.equal(d.body.delivery, 'dashboard', 'a failed post leaves the card on the dashboard');
  assert.ok(logs.includes('[discord] a card could not be posted (code 50001); it waits on the dashboard'));
  assert.ok(!logs.some((l) => l.includes(ids.alphaCode) || l.includes(fx.keys.alpha)));
  assert.equal(errorCategory({ message: 'secret', name: 'Weird' }), 'other');
  assert.equal(errorCategory({ status: 429 }), 'http 429');
  await fx.call('POST', `/api/ask/${d.body.askId}/answer`, { ...OWNER, body: { label: 'x' } });
  await ack(d.body.askId);
});

test('notify: the tagged person is mentioned and only they can be pinged', async () => {
  stub.reset();
  const r = await fx.call('POST', '/api/notify', { ...A, body: { sender: 'alphabot', message: 'need you', tag: 'owner1', priority: 'action' } });
  assert.deepEqual([r.body.delivered, r.body.via], [true, 'discord']);
  assert.equal(stub.posts.length, 1);
  assert.match(stub.posts[0].content, new RegExp(`<@${ids.owner}>`));
  assert.deepEqual(stub.posts[0].allowedMentions, { users: [ids.owner] });
});

test('a Discord-only answerer: reachable while connected, not counted while disconnected', async () => {
  const c = await card('Gamma?', ['Go'], G, 'gammabot');
  assert.deepEqual(c.answerers, ['gam']);
  await stub.tap({ userId: GAM, customId: `ask|${c.askId}|0`, channelId: GAMMA_CODE, messageId: c.post.id });
  assert.match(stub.updates.at(-1).content, /Answered by gam: Go/);
  await ack(c.askId, G, 'gammabot');
  stub.isConnected = false;
  try {
    stub.reset();
    const d = await fx.call('POST', '/api/ask/dispatch', { ...G, body: { question: 'Offline?', options: ['x'], askingSeat: 'gammabot' } });
    assert.equal(d.status, 409, 'nobody can answer while Discord is away: nothing is parked');
    assert.equal(d.body.error, 'no_answerer');
    assert.equal(stub.posts.length, 0);
    assert.equal((await fx.call('GET', '/api/health')).body.humanChannelStatus.connected, false);
  } finally { stub.isConnected = true; }
});

test('the pack refuses to start without a token or without discord.js, with a clear message', async () => {
  const ctx = { config: { discord: { enabled: true, projects: {} }, people: {} }, log: () => {} };
  await assert.rejects(() => createHumanChannel({ ...ctx, secret: null }), /bot token is missing/);
  const missing = async () => { const e = new Error("Cannot find package 'discord.js'"); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; };
  await assert.rejects(() => createHumanChannel({ ...ctx, secret: fakeToken() }, { importer: missing }), /discord\.js package is not installed/);
});

test('the real server entry refuses to boot with Discord on and discord.js missing', () => {
  const home = makeHome({ people: { owner1: { key: OWNER.key, accounts: { discord: ids.owner } } }, config: { discord: { enabled: true, projects: { alpha: { channels: { code: ids.alphaCode } } } } }, extraEnv: { SYNAPSE_DISCORD_TOKEN: fakeToken() } }).home;
  try {
    const env = { ...process.env, SYNAPSE_HOME: home };
    for (const k of ['DEV_SYNC_SEAT', 'NODE_OPTIONS', 'SYNAPSE_DISCORD_TOKEN', 'SYNAPSE_PORT', 'SYNAPSE_HOST']) delete env[k];
    const blocker = path.join(HERE, 'fixtures', 'block-discord.mjs');
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(blocker).href, path.join(HERE, '..', '..', 'server', 'server.mjs')], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /discord\.js package is not installed/);
    assert.ok(!r.stderr.includes(fakeToken()), 'the token is not printed');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the real transport builds its discord.js client (intents, no pings) and logs in only through the injected client', async () => {
  const { createDiscordJsTransport } = await import('../../server/packs/discord/transport.mjs');
  const djs = await import('discord.js');
  const built = [];
  let logins = 0;
  class InertClient extends djs.Client {
    constructor(options) { super(options); built.push(options); }
    login() { logins++; return Promise.resolve('inert'); } // never touches the network
  }
  const t = await createDiscordJsTransport({ token: fakeToken(), log: () => {}, importer: async () => ({ ...djs, Client: InertClient }) });
  await t.start();
  assert.equal(built.length, 1, 'start() constructs exactly one client');
  const { GatewayIntentBits } = djs;
  assert.deepEqual(built[0].intents, [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]);
  assert.deepEqual(built[0].allowedMentions, { parse: [] });
  assert.equal(logins, 1);
  assert.equal(t.connected(), false, 'an inert login never becomes ready');
  assert.equal(t.botUserId(), null);
  await t.stop();
  assert.equal(BOT_ID.length, 18);
});
