// Config and registry checks, people and roles, and the human-channel boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkConfig, checkRegistry, withDefaults, hasFatal } from '../../server/lib/config.mjs';
import { createPeople, hashHumanKey, verifyHumanKeyHash } from '../../server/lib/people.mjs';
import { loadHumanChannel, createDashboardChannel } from '../../server/lib/human-channel.mjs';

const base = () => ({ version: 2, people: { olive: {} }, owners: ['olive'] });
const fatalText = (f) => f.filter((x) => x.level === 'fatal').map((x) => x.message).join('\n');

test('owners are required and must be configured people', () => {
  assert.match(fatalText(checkConfig({ ...base(), owners: [] })), /owners/);
  assert.match(fatalText(checkConfig({ ...base(), owners: ['ghost'] })), /owner "ghost" is not in "people"/);
  assert.equal(hasFatal(checkConfig(base())), false);
});

test('bad roles, names, channels and origins are fatal', () => {
  assert.ok(hasFatal(checkConfig({ ...base(), people: { olive: { roles: ['god'] } } })));
  assert.ok(hasFatal(checkConfig({ ...base(), people: { Olive: {} }, owners: ['Olive'] })));
  assert.ok(hasFatal(checkConfig({ ...base(), channels: ['all'] })));
  assert.ok(hasFatal(checkConfig({ ...base(), corsOrigins: ['http://x.test/path'] })));
  assert.ok(hasFatal(checkConfig({ ...base(), version: 1 })));
});

test('a non-loopback host is refused unless allowRemote is set with a non-empty allowedHosts, and then it warns', () => {
  assert.match(fatalText(checkConfig({ ...base(), server: { host: '0.0.0.0' } })), /allowRemote/);
  for (const server of [{ host: '0.0.0.0', allowRemote: true }, { host: '0.0.0.0', allowRemote: true, allowedHosts: [] }, { host: '127.0.0.1', allowRemote: true }]) {
    assert.match(fatalText(checkConfig({ ...base(), server })), /allowedHosts" is empty/, JSON.stringify(server));
  }
  const f = checkConfig({ ...base(), server: { host: '0.0.0.0', allowRemote: true, allowedHosts: ['bus.example.test'] } });
  assert.equal(hasFatal(f), false);
  assert.ok(f.some((x) => x.level === 'warn' && /reachable from other machines/.test(x.message)));
});

test('super-scopes are refused, and one account id may map to only one person', () => {
  assert.match(fatalText(checkRegistry({ projects: {}, superScopes: { v: { keyEnv: 'KV' } } }, withDefaults(base()), {})), /superScopes/);
  assert.match(fatalText(checkConfig({ ...base(), people: { olive: { accounts: { discord: '300000000000000111' } }, sam: { accounts: { discord: ['300000000000000222', '300000000000000111'] } } } })), /one id is listed for both/);
});

test('registry: keys are required, long, and unique; bots never share a person\'s name', () => {
  const cfg = withDefaults(base());
  const reg = { projects: { a: { keyEnv: 'KA', assertableBots: ['abot'] }, b: { keyEnv: 'KB', assertableBots: ['olive'] } } };
  const long = 'z'.repeat(30);
  const f = fatalText(checkRegistry(reg, cfg, { KA: long, KB: long }));
  assert.match(f, /same value/);
  assert.match(f, /same name as a person/);
  assert.match(fatalText(checkRegistry({ projects: { a: { keyEnv: 'KA' } } }, cfg, {})), /KA is not set/);
  assert.match(fatalText(checkRegistry({ projects: { a: { keyEnv: 'KA' } } }, cfg, { KA: 'short' })), /shorter than/);
  assert.match(fatalText(checkRegistry({ projects: { a: {} } }, cfg, {})), /keyEnv" is required/);
  assert.match(fatalText(checkRegistry({ projects: { a: { keyEnv: 'KA' } } }, { ...cfg, defaultProject: 'zz' }, { KA: long })), /defaultProject/);
});

test('human keys: scrypt hash round-trip, wrong key and tampered hash refused', () => {
  const h = hashHumanKey('correct-horse-battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyHumanKeyHash(h, 'correct-horse-battery'), true);
  assert.equal(verifyHumanKeyHash(h, 'correct-horse-batterY'), false);
  assert.equal(verifyHumanKeyHash(h.replace(/.$/, 'A'), 'correct-horse-battery'), false);
  assert.equal(verifyHumanKeyHash('plain', 'x'), false);
  assert.throws(() => hashHumanKey('short'));
  assert.throws(() => hashHumanKey('has a space in it'), /printable ASCII/, 'header-safe characters only');
  assert.throws(() => hashHumanKey('café-keyvalue-1'), /printable ASCII/);
});

test('people: unknown identities are refused, owners and approvers answer, scoping holds', () => {
  const p = createPeople({ owners: ['olive'], people: { olive: { accounts: { discord: '111' } }, sam: { roles: ['approver'], projects: ['b'] }, pat: { roles: ['pingable'] } } });
  assert.equal(p.byExternalId('discord', '111'), 'olive');
  assert.equal(p.byExternalId('discord', '999'), null, 'an unknown external id is not a person');
  assert.equal(p.byExternalId('discord', ''), null);
  const dup = createPeople({ owners: ['a'], people: { a: { accounts: { discord: '5' } }, b: { accounts: { discord: '5' } } } });
  assert.equal(dup.byExternalId('discord', '5'), null, 'an id claimed by two people resolves to nobody');
  assert.equal(p.canAnswer('olive', 'a'), true);
  assert.equal(p.canAnswer('sam', 'b'), true);
  assert.equal(p.canAnswer('sam', 'a'), false);
  assert.equal(p.canAnswer('pat', 'a'), false);
  assert.equal(p.canAnswer('ghost', 'a'), false);
  assert.deepEqual(p.answerersFor('a'), ['olive']);
  assert.deepEqual(p.pingableFor('a').sort(), ['olive', 'pat']);
  assert.equal(p.verifyKey('ghost', 'anything-at-all'), false);
});

test('human channel: dashboard by default; Discord switched on without the pack stops the boot', async () => {
  const ch = await loadHumanChannel(withDefaults(base()), {});
  assert.equal(ch.name, 'dashboard');
  await assert.rejects(() => loadHumanChannel(withDefaults({ ...base(), discord: { enabled: true } }), {}, { importer: async () => { throw new Error('missing'); } }), /Discord pack is not installed/);
  let seen = null;
  const fake = await loadHumanChannel(withDefaults({ ...base(), discord: { enabled: true } }), { marker: 1 }, { importer: async () => ({ createHumanChannel: async (ctx) => { seen = ctx; return { name: 'fake' }; } }) });
  assert.equal(fake.name, 'fake');
  assert.equal(seen.marker, 1, 'the pack receives the core context');
  assert.equal(createDashboardChannel().name, 'dashboard');
  await assert.rejects(() => loadHumanChannel(withDefaults({ ...base(), discord: { enabled: true } }), {}, { importer: async () => ({ createHumanChannel: async () => ({ name: 'x', start: 'nope' }) }) }), /start must be a function/);
  await assert.rejects(() => loadHumanChannel(withDefaults({ ...base(), discord: { enabled: true } }), {}, { importer: async () => ({ createHumanChannel: async () => ({}) }) }), /no name/);
  assert.equal(typeof fake.stop, 'function', 'a missing lifecycle method gets a default');
});

test('the core never imports discord.js', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'server');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs')) files.push(p); } };
  walk(root);
  for (const f of files) assert.ok(!/from\s+['"]discord\.js['"]|require\(['"]discord\.js['"]\)/.test(fs.readFileSync(f, 'utf8')), f);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, '..', 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies['discord.js']);
});
