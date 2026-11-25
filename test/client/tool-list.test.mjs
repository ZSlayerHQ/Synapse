// The listed tools: none of the cut tools, the channel enums from the server's /api/channels (with the fallback set on any
// failure or a 2 s timeout), and the notify tags from /api/notify/tags. A mock bus answers on a random port in 4600-4999.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pinEnv, answerBusProof, listenInRange, closeServer } from './helpers.mjs';

const seen = [];
const mode = { channels: 'ok', channelsBody: { channels: ['code', 'ops', 'design'] }, tags: { tags: ['pat', 'sam'] } };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  if (answerBusProof(req, res)) return;
  const p = new URL(req.url, 'http://x').pathname;
  seen.push({ method: req.method, path: p, key: req.headers['x-dev-key'] });
  if (p === '/api/channels') {
    if (mode.channels === 'hang') return; // never answers
    if (mode.channels === 'error') return json(res, 500, { error: 'boom' });
    if (mode.channels === 'notjson') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{nope'); }
    return json(res, 200, mode.channelsBody);
  }
  if (p === '/api/notify/tags') return mode.tags ? json(res, 200, mode.tags) : json(res, 404, { error: 'no' });
  json(res, 404, { error: 'not here' });
});
const port = await listenInRange(server);
after(() => closeServer(server));

pinEnv({ DEV_SYNC_KEY: 'list-key' }, { port });
process.argv.push('--developer', 'listtest');
const { TOOLS, listTools, listingReset, buildTools, parseChannels, DEFAULT_CHANNELS } = await import('../../client/index.js');

const CUT = ['dev_service_list', 'dev_service_status', 'dev_service_restart', 'dev_job_update', 'dev_job_finish', 'dev_session_control', 'dev_bus_status'];
const KEPT = ['dev_msg_send', 'dev_msg_broadcast', 'dev_msg_history', 'dev_send_file', 'dev_get_file', 'dev_ask', 'dev_wake', 'dev_notify_human',
  'dev_report_error', 'dev_log', 'dev_sync_checkin', 'dev_sync_status', 'dev_task_create', 'dev_task_list', 'dev_task_update', 'dev_sync_will_edit',
  'dev_sync_did_edit', 'dev_sync_lock', 'dev_sync_unlock', 'dev_sync_locks', 'dev_sync_alert', 'dev_sync_activity', 'dev_onboarding_guide'];
const enumOf = (tools, name) => tools.find((t) => t.name === name).inputSchema.properties.channel.enum;
const FALLBACK = ['code', 'build', 'qa', 'reports', 'tasks', 'alerts'];

beforeEach(() => {
  listingReset();
  seen.length = 0;
  mode.channels = 'ok';
  mode.channelsBody = { channels: ['code', 'ops', 'design'] };
  mode.tags = { tags: ['pat', 'sam'] };
});

test('the tool list holds exactly the kept tools and none of the cut ones, statically and as listed', async () => {
  const { tools } = await listTools();
  for (const list of [TOOLS, tools]) {
    const names = list.map((t) => t.name);
    for (const cut of CUT) assert.ok(!names.includes(cut), `${cut} is cut`);
    assert.deepEqual([...names].sort(), [...KEPT].sort());
  }
});

test('every channel enum value is a configured channel or an extra: no channel only one deployment had', async () => {
  const { tools } = await listTools();
  for (const [list, set] of [[TOOLS, FALLBACK], [tools, ['code', 'ops', 'design']]]) {
    const allowed = new Set([...set, 'all', 'direct']);
    for (const t of list) {
      const ch = t.inputSchema.properties.channel;
      if (ch && ch.enum) for (const v of ch.enum) assert.ok(allowed.has(v), `${t.name}: ${v}`);
    }
  }
});

test('/api/channels drives every channel enum, with all (and direct for history) added', async () => {
  const { tools } = await listTools();
  assert.deepEqual(enumOf(tools, 'dev_msg_send'), ['code', 'ops', 'design', 'all']);
  assert.deepEqual(enumOf(tools, 'dev_msg_history'), ['code', 'ops', 'design', 'all', 'direct']);
  assert.deepEqual(enumOf(tools, 'dev_send_file'), ['code', 'ops', 'design', 'all']);
  const call = seen.find((s) => s.path === '/api/channels');
  assert.ok(call, 'the channels were asked for');
  assert.equal(call.method, 'GET');
  assert.equal(call.key, 'list-key', 'with the key header');
});

test('a fetched channel set is kept: the next listing does not ask again', async () => {
  await listTools();
  mode.channelsBody = { channels: ['other'] };
  const { tools } = await listTools();
  assert.deepEqual(enumOf(tools, 'dev_msg_send'), ['code', 'ops', 'design', 'all']);
  assert.equal(seen.filter((s) => s.path === '/api/channels').length, 1);
});

for (const [label, set] of [
  ['an HTTP 500', () => { mode.channels = 'error'; }],
  ['a body that is not JSON', () => { mode.channels = 'notjson'; }],
  ['a body without a channels array', () => { mode.channelsBody = { channels: 'code' }; }],
  ['an empty list', () => { mode.channelsBody = { channels: [] }; }],
  ['only reserved or invalid names', () => { mode.channelsBody = { channels: ['all', 'direct', 'has space', '', 7, null] }; }],
]) {
  test(`${label}: the fallback channel set, and the next listing asks again`, async () => {
    set();
    const { tools } = await listTools();
    assert.deepEqual(enumOf(tools, 'dev_msg_send'), [...FALLBACK, 'all']);
    assert.deepEqual(enumOf(tools, 'dev_msg_history'), [...FALLBACK, 'all', 'direct']);
    assert.deepEqual(enumOf(tools, 'dev_send_file'), [...FALLBACK, 'all']);
    mode.channels = 'ok';
    mode.channelsBody = { channels: ['code', 'ops'] };
    assert.deepEqual(enumOf((await listTools()).tools, 'dev_msg_send'), ['code', 'ops', 'all'], 'a later success is used');
  });
}

test('a server that never answers: the fallback set within the 2 s limit', { timeout: 6000 }, async () => {
  mode.channels = 'hang';
  const t0 = Date.now();
  const { tools } = await listTools();
  const took = Date.now() - t0;
  assert.deepEqual(enumOf(tools, 'dev_msg_send'), [...FALLBACK, 'all']);
  assert.ok(took >= 1900 && took < 3500, `bounded by the limit (${took} ms)`);
});

test('the notify tags come from /api/notify/tags, with all added; without them the generic wording', async () => {
  const notify = (await listTools()).tools.find((t) => t.name === 'dev_notify_human');
  assert.match(notify.description, /Valid tags for this project: pat, sam, all\.$/);
  assert.equal(notify.inputSchema.properties.tag.description, 'Human tag to notify. Valid for this project: pat, sam, all.');
  listingReset();
  mode.tags = null;
  const generic = (await listTools()).tools.find((t) => t.name === 'dev_notify_human');
  assert.match(generic.description, /vary by project \(the server rejects an unknown tag and lists the valid ones\)/);
  assert.doesNotMatch(generic.description, /\{\{TAGS\}\}/);
});

test('parseChannels: strings with a plain name only, no reserved name, no duplicate, order kept; null when nothing is left', () => {
  assert.deepEqual(parseChannels({ channels: ['code', 'ops', 'code', 'All', 'direct', 'bad name', 'x'.repeat(40), 'ok_2', 'a-b', 5] }), ['code', 'ops', 'ok_2', 'a-b']);
  assert.equal(parseChannels({ channels: ['all'] }), null);
  assert.equal(parseChannels({}), null);
  assert.equal(parseChannels(null), null);
  assert.equal(parseChannels({ channels: {} }), null);
});

test('buildTools is pure: it leaves TOOLS and the default set unchanged', () => {
  const before = JSON.stringify(TOOLS);
  const built = buildTools(['one'], 'pat, all');
  assert.deepEqual(enumOf(built, 'dev_msg_send'), ['one', 'all']);
  assert.equal(JSON.stringify(TOOLS), before);
  assert.deepEqual([...DEFAULT_CHANNELS], FALLBACK);
  assert.ok(Object.isFrozen(DEFAULT_CHANNELS));
});
