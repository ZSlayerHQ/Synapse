// Regression for the security audit (run-1), candidate (b): a file upload needs an authenticated sender, and the bus's
// reserved names are never a sender.
// Every bus here is in-process on a random port in 4600-4999.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../../server/lib/auth.mjs';
import { createPeople } from '../../server/lib/people.mjs';
import { startBus } from '../helpers/bus.mjs';

// ─── (b) A file upload needs an authenticated sender; reserved names are never a sender ───

test('files: an upload with no sender is refused, never shown as a reserved name', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] } } });
  try {
    const post = async (fields) => {
      const form = new FormData();
      form.append('file', new Blob(['hello']), 'note.txt');
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      const r = await fetch(`${fx.base}/api/message/file`, { method: 'POST', headers: { 'X-Dev-Key': fx.keys.alpha, 'X-Dev-Project': 'alpha' }, body: form });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    assert.equal((await post({ channel: 'code' })).status, 400, 'no sender');
    for (const n of ['dashboard', 'unknown', 'ask-bridge', 'synapse']) assert.equal((await post({ sender: n })).status, 403, n);
    assert.equal((await post({ sender: 'alphabot' })).status, 200);
    const msgs = (await fx.call('GET', '/api/messages?channel=code', { key: fx.keys.alpha, project: 'alpha' })).body.messages;
    assert.deepEqual(msgs.map((m) => m.sender), ['alphabot']);
  } finally { await fx.close(); }
});

test('auth (pure): a reserved name is refused even when a registry lists it as a bot', () => {
  const registry = { projects: { alpha: { keyEnv: 'K_A', assertableBots: ['dashboard', 'unknown', 'ask-bridge', 'alphabot'], roster: {} } } };
  const env = { K_A: 'a'.repeat(30) };
  const auth = createAuth({ registry, env, people: createPeople({ owners: [], people: {} }) });
  const req = { headers: { 'x-dev-key': env.K_A } };
  for (const n of ['dashboard', 'unknown', 'ask-bridge', 'dashboard.s1']) assert.equal(auth.bindIdentity('alpha', n, req), false, n);
  assert.equal(auth.bindIdentity('alpha', 'alphabot', req), true);
});
