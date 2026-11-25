// Regression (audit follow-up): a task created or updated without a named actor is attributed to the authenticated
// principal (the person, the bot of a per-bot key, or the project key), never to a reserved name such as 'dashboard'.
// Every bus here is in-process on a random port in 4600-4999.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBus } from '../helpers/bus.mjs';

const OWNER = { human: 'owner1', key: 'owner-key-0123456789' };

test('tasks: no createdBy or updatedBy means the authenticated principal, never a reserved name', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot', 'keyed'], botKeys: { keyed: true } } }, people: { owner1: { key: OWNER.key } } });
  try {
    const A = { key: fx.keys.alpha, project: 'alpha' };
    const KEYED = { key: fx.keys['alpha/keyed'], project: 'alpha' };
    const byProject = (await fx.call('POST', '/api/tasks', { ...A, body: { title: 'p' } })).body.task;
    const byBot = (await fx.call('POST', '/api/tasks', { ...KEYED, body: { title: 'b' } })).body.task;
    const byPerson = (await fx.call('POST', '/api/tasks', { human: OWNER.human, key: OWNER.key, project: 'alpha', body: { title: 'h' } })).body.task;
    assert.equal(byProject.createdBy, 'project:alpha');
    assert.equal(byBot.createdBy, 'keyed');
    assert.equal(byPerson.createdBy, 'owner1');
    await fx.call('PATCH', `/api/tasks/${byProject.id}`, { ...A, body: { status: 'done' } });
    const msgs = (await fx.call('GET', '/api/messages?channel=tasks', A)).body.messages;
    const done = msgs.find((m) => /Completed: p$/.test(m.content));
    assert.equal(done.sender, 'project:alpha');
    const reserved = new Set(['dashboard', 'unknown', 'ask-bridge', 'synapse']);
    assert.ok(![byProject, byBot, byPerson].some((t) => reserved.has(t.createdBy)));
    assert.ok(!msgs.some((m) => reserved.has(m.sender) && /Completed: p$/.test(m.content)));
  } finally { await fx.close(); }
});
