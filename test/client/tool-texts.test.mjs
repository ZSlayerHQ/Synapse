// Tool descriptions, server instructions and check-in results of the MCP client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinEnv } from './helpers.mjs';

pinEnv();
const { TOOLS, formatCheckin, SERVER_INSTRUCTIONS, DEFAULT_CHANNELS } = await import('../../client/index.js');

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const allText = (t) => [t.description, ...Object.values(t.inputSchema?.properties || {}).map((p) => p.description || '')].join('\n');

test('no tool text carries an em dash', () => {
  for (const t of TOOLS) assert.equal(/—/.test(allText(t)), false, `em dash in ${t.name}`);
});

test('no tool text shouts', () => {
  for (const t of TOOLS) {
    for (const w of ['ONE', 'NOT', 'NON-BLOCKING', 'INSTEAD', 'LIVE', 'THIS', 'THROUGH', 'HEADLINE']) {
      assert.equal(new RegExp(`\\b${w}\\b`).test(allText(t)), false, `${w} in ${t.name}`);
    }
  }
});

test('dev_msg_send: channel is the default list plus all, to says never a channel name, cross-tool pointers kept', () => {
  const p = byName.dev_msg_send.inputSchema.properties;
  assert.deepEqual(p.channel.enum, ['code', 'build', 'qa', 'reports', 'tasks', 'alerts', 'all']);
  assert.deepEqual([...DEFAULT_CHANNELS], ['code', 'build', 'qa', 'reports', 'tasks', 'alerts']);
  assert.match(p.to.description, /Never a channel name/);
  assert.doesNotMatch(allText(byName.dev_msg_send), /broadcast\./);
  for (const tool of ['dev_wake', 'dev_sync_alert']) assert.ok(byName.dev_msg_send.description.includes(tool), tool);
});

test('closed lists are enums and bounded numbers', () => {
  const hist = byName.dev_msg_history.inputSchema.properties;
  assert.deepEqual(hist.channel.enum, ['code', 'build', 'qa', 'reports', 'tasks', 'alerts', 'all', 'direct']);
  assert.deepEqual([hist.limit.type, hist.limit.minimum, hist.limit.maximum], ['integer', 1, 200]);
  assert.match(hist.since.description, /strictly after/);
  for (const name of ['dev_task_create', 'dev_task_update']) {
    const p = byName[name].inputSchema.properties;
    assert.deepEqual([p.priority.type, p.priority.minimum, p.priority.maximum], ['integer', 1, 4], name);
    assert.deepEqual(p.type.enum, ['backend', 'frontend', 'fullstack', 'qa', 'research'], name);
  }
  assert.deepEqual(byName.dev_task_update.inputSchema.properties.status.enum, ['pending', 'in-progress', 'blocked', 'review', 'done']);
  assert.deepEqual(byName.dev_task_list.inputSchema.properties.status.enum, ['pending', 'in-progress', 'blocked', 'review', 'done']);
  assert.deepEqual(byName.dev_send_file.inputSchema.properties.channel.enum, ['code', 'build', 'qa', 'reports', 'tasks', 'alerts', 'all']);
});

test('no tool names a project-specific file; dev_sync_locks does not claim to be read-only', () => {
  for (const t of TOOLS) assert.doesNotMatch(allText(t), /CURRENT-ISSUES|PRIORITIES\.md|SESSION-STATE/, t.name);
  assert.doesNotMatch(byName.dev_sync_locks.description, /Read-only/);
  assert.match(byName.dev_sync_locks.description, /clears locks that have already expired/);
});

test('dev_report_error and dev_log say only the dashboard shows them and nobody is pinged', () => {
  assert.match(byName.dev_report_error.description, /keeps the latest 200 reports in memory and loses them on a bus restart; a short excerpt also enters the activity feed. Nobody is pinged/);
  assert.doesNotMatch(byName.dev_wake.description, /will not see this/);
  assert.match(byName.dev_wake.description, /no live delivery was confirmed/);
  assert.match(byName.dev_log.description, /Only the dashboard shows them and nobody is pinged/);
});

test('dev_ask: the texts say a configured human answers on the dashboard, Discord only as the optional pack; the expiry sentence and series line are kept', () => {
  const ask = byName.dev_ask;
  const p = ask.inputSchema.properties;
  assert.equal(p.question.description, 'The decision itself, one short sentence, shown as the card\'s headline (cut at 300 characters). Background goes in context.');
  assert.equal(p.context.description, 'The background the human needs to decide from the card alone, often on a phone and without your session\'s context: what happened, what each option does and what it changes, the key evidence, any constraint. Explain any ID, name or shorthand you use, or leave it out. Markdown renders (bold, bullets, short paragraphs). The card shows roughly the first 1,500 characters (about 1,000 when your question and recommendation are long); the rest is cut.');
  assert.equal(p.recommendation.description, 'Which option you advise and the one-line reason (cut at 500 characters).');
  assert.equal(ask.description, 'Ask a human one decision, shown as a card with buttons. A configured human answers it on the Synapse dashboard (or on Discord when that optional pack is enabled). It does not block: use it instead of AskUserQuestion for every decision, so the session never freezes. It returns at once, and its result says whether the card posted and pinged a human and what to do next (usually: end your turn); the answer arrives later as a channel message naming the askId. A card stays open until a person answers it; an answer that arrives while this session is offline is delivered when it reconnects. Keep `question` to one short sentence, because it is the card headline and a long one renders as a wall of text. Put background in `context` and your advised pick in `recommendation`; each renders as its own card section.');
  assert.ok(ask.description.includes('A card stays open until a person answers it; an answer that arrives while this session is offline is delivered when it reconnects.'), 'the expiry sentence, word for word');
  assert.equal(p.series.description, 'Optional series label when this decision is part of a batch, e.g. "1 of 3", rendered in the card title so the human sees the batch shape. Batch convention: send each decision as its own card with a series label (never a prose digest); each card pings on its own, so add a dev_notify_human only when a card\'s result says nobody was mentioned or its post is unconfirmed.');
  assert.doesNotMatch(allText(ask), /keep under ~1000|1000 chars|rendered as a card with tappable buttons in Discord/, 'no older limit and no Discord promise');
  assert.deepEqual(ask.inputSchema.required, ['question', 'options']);
});

test('Discord appears only as an optional pack in the tool descriptions', () => {
  for (const t of TOOLS) {
    for (const sentence of t.description.split(/(?<=\.)\s+/)) {
      if (!/Discord/.test(sentence) || /reported on its own line/.test(sentence)) continue;
      assert.match(sentence, /when (that|the) optional (Discord )?pack is enabled|optional Discord pack/, `${t.name}: ${sentence}`);
    }
  }
});

test('server instructions: backfill advice, the launch flag for the "synapse" server key, the notify rules', () => {
  assert.match(SERVER_INSTRUCTIONS, /dev_msg_history backfills/);
  assert.ok(SERVER_INSTRUCTIONS.includes('claude --dangerously-load-development-channels server:synapse'));
  assert.match(SERVER_INSTRUCTIONS, /DEV_SYNC_SEAT=<name>/);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /server:dev-sync-channel/);
});

test('check-in lists seats with a live socket and counts the rest', () => {
  const out = formatCheckin({
    otherDevelopers: [
      { name: 'a', status: 'active', workingOn: 'receipts' },
      { name: 'b.1', status: 'offline' }, { name: 'b.2', status: 'offline' },
    ],
    pendingAlerts: [{ priority: 'info', from: 'c', message: 'hi' }],
    activeLocks: [{ file: 'x.js', developer: 'a' }],
  }, 'me', ['a']);
  assert.match(out, /^Checked in as "me"\./);
  assert.match(out, /\na: active: receipts/);
  assert.doesNotMatch(out, /b\.1|b\.2/);
  assert.match(out, /2 other seats with no live connection \(dev_sync_status lists them\)\./);
  assert.match(out, /1 pending alert\(s\):\n {2}\[info\] c: hi/);
  assert.match(out, /x\.js, locked by a \(editing\)/);
  assert.equal(/—/.test(out), false);
});

test('check-in: a seat with a live socket is listed even when its record says offline (checkout without disconnect)', () => {
  const out = formatCheckin({ otherDevelopers: [{ name: 'peer', status: 'offline', workingOn: 'still here' }] }, 'me', ['peer']);
  assert.match(out, /\npeer: offline: still here/);
  assert.doesNotMatch(out, /No other developers online/);
});

test('check-in without the socket list lists everyone', () => {
  const out = formatCheckin({ otherDevelopers: [{ name: 'b', status: 'offline' }, { name: 'c', status: 'offline' }] }, 'me', null);
  assert.match(out, /\nb: offline/);
  assert.match(out, /\nc: offline/);
  assert.doesNotMatch(out, /no live connection/);
});

test('check-in with nobody live says so, one away seat is singular, and pending alerts still show', () => {
  const out = formatCheckin({ otherDevelopers: [{ name: 'b', status: 'offline' }], pendingAlerts: [{ priority: 'urgent', from: 'z', message: 'handoff' }] }, 'me', []);
  assert.match(out, /No other developers online\./);
  assert.match(out, /1 other seat with no live connection/);
  assert.match(out, /\[urgent\] z: handoff/);
  assert.match(formatCheckin({}, 'me', []), /No other developers online\./);
});
