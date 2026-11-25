// Identity binding (ported from the live bind-identity suite, plus the v2 rules; super-scope keys are not part of v2).
// Pure: no server is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, seatBase } from '../../server/lib/auth.mjs';
import { createPeople } from '../../server/lib/people.mjs';

const registry = {
  projects: {
    alpha: { keyEnv: 'K_ALPHA', assertableBots: ['alphabot', 'helper', 'keyed'], roster: { keyed: { keyEnv: 'K_ALPHA_KEYED' } } },
    beta: { keyEnv: 'K_BETA', assertableBots: ['betabot'] },
  },
};
const env = { K_ALPHA: 'a'.repeat(30), K_BETA: 'b'.repeat(30), K_ALPHA_KEYED: 'k'.repeat(30) };
const people = createPeople({ owners: ['olive'], people: { olive: {}, sam: { roles: ['approver'], projects: ['beta'] } } });
const auth = createAuth({ registry, env, people });
const projectReq = (key = env.K_ALPHA) => ({ headers: { 'x-dev-key': key } });

test('a project key may assert its own bots and seats of them', () => {
  assert.equal(auth.bindIdentity('alpha', 'alphabot', projectReq()), true);
  assert.equal(auth.bindIdentity('alpha', 'alphabot.left', projectReq()), true);
  assert.equal(auth.bindIdentity('alpha', 'betabot', projectReq()), false, 'a bot of another project');
});

test('a project key never asserts a person (v2: people sign in as themselves)', () => {
  assert.equal(auth.bindIdentity('alpha', 'olive', projectReq()), false);
  assert.equal(auth.bindIdentity('alpha', 'sam', projectReq()), false);
});

test('client-asserted pseudo-emitters are rejected', () => {
  for (const n of ['synapse', 'dashboard', 'unknown', 'ask-bridge']) assert.equal(auth.bindIdentity('alpha', n, projectReq()), false, n);
});

test('a bot with its own keyEnv binds only with that key', () => {
  assert.equal(auth.bindIdentity('alpha', 'keyed', projectReq()), false, 'project key cannot speak for a keyed bot');
  assert.equal(auth.bindIdentity('alpha', 'keyed', projectReq(env.K_ALPHA_KEYED)), true);
  assert.equal(auth.bindIdentity('alpha', 'keyed.s1', projectReq(env.K_ALPHA_KEYED)), true, 'a seat inherits the base key rule');
});

test('a per-bot principal may assert only itself (or a seat of itself)', () => {
  const req = { botPrincipal: 'keyed', headers: { 'x-dev-key': env.K_ALPHA_KEYED } };
  assert.equal(auth.bindIdentity('alpha', 'keyed', req), true);
  assert.equal(auth.bindIdentity('alpha', 'keyed.x', req), true);
  assert.equal(auth.bindIdentity('alpha', 'alphabot', req), false, 'not a sibling bot');
  assert.equal(auth.bindIdentity('alpha', 'olive', req), false, 'not a person');
});

test('a person may assert only their own name, only where allowed', () => {
  assert.equal(auth.bindIdentity('alpha', 'olive', { humanPrincipal: 'olive' }), true);
  assert.equal(auth.bindIdentity('alpha', 'alphabot', { humanPrincipal: 'olive' }), false);
  assert.equal(auth.bindIdentity('beta', 'sam', { humanPrincipal: 'sam' }), true);
  assert.equal(auth.bindIdentity('alpha', 'sam', { humanPrincipal: 'sam' }), false, 'sam is scoped to beta');
  assert.equal(auth.bindIdentity('alpha', 'olive', { humanPrincipal: 'sam' }), false, 'not another person');
});

test('matchBotKey / projectKey never match garbage, and there is no global fallback key', () => {
  assert.equal(auth.matchBotKey('alpha', 'nope'), null);
  assert.equal(auth.matchBotKey('alpha', undefined), null);
  assert.equal(auth.matchBotKey('alpha', env.K_ALPHA), null);
  assert.equal(auth.matchBotKey('alpha', env.K_ALPHA_KEYED), 'keyed');
  assert.equal(auth.projectKey('nosuch'), null);
  const bare = createAuth({ registry: { projects: { solo: { assertableBots: [] } } }, env: { DEV_SYNC_KEY: 'x'.repeat(30) }, people });
  assert.equal(bare.projectKey('solo'), null, 'a project without keyEnv cannot authenticate, even with DEV_SYNC_KEY set');
});

test('every present actor field is validated; a present non-string is a forge', () => {
  const req = (body) => ({ authProject: 'alpha', headers: { 'x-dev-key': env.K_ALPHA }, body });
  assert.equal(auth.rejectForgedActor(req({ developer: 'alphabot' })), false);
  assert.equal(auth.rejectForgedActor(req({ developer: 'alphabot', sender: 'olive' })), true, 'decoy + spoof');
  assert.equal(auth.rejectForgedActor(req({ sender: ['alphabot'] })), true, 'array actor');
  assert.equal(auth.rejectForgedActor(req({ sender: '' })), true, 'empty string actor');
  assert.equal(auth.rejectForgedActor(req({ sender: null })), false, 'null is absent');
});

test('secondary actor binds to the resource owner', () => {
  assert.equal(auth.bindSecondaryActor('alpha', 'helper', 'alphabot', env.K_ALPHA), false, 'a sibling cannot complete another bot\'s task');
  assert.equal(auth.bindSecondaryActor('alpha', 'alphabot', 'alphabot', env.K_ALPHA), true);
  assert.equal(auth.bindSecondaryActor('alpha', 'helper', null, env.K_ALPHA), true, 'unowned task, roster bot');
  assert.equal(auth.bindSecondaryActor('alpha', 'olive', null, env.K_ALPHA), false, 'unowned task, not a bot');
  assert.equal(auth.bindSecondaryActor('alpha', ['alphabot'], 'alphabot', env.K_ALPHA), false);
});

test('seatBase is fail-closed', () => {
  assert.equal(seatBase('bot'), 'bot');
  assert.equal(seatBase('bot.a1'), 'bot');
  assert.equal(seatBase('bot.A'), null);
  assert.equal(seatBase('bot.a.b'), null);
  assert.equal(seatBase('.a'), null);
  assert.equal(seatBase(''), null);
});
