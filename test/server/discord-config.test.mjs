// The Discord block of synapse.config.json: checked by the core at boot (and by doctor and setup) without discord.js.
// While the pack is off a problem in the block only warns; once it is on, the same problem stops the boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig, checkDiscord, discordTokenProblem, hasFatal } from '../../server/lib/config.mjs';
import { createRedactor } from '../../server/lib/redact.mjs';
import { fakeToken } from '../helpers/discord-stub.mjs';

const CH1 = '700000000000000201';
const CH2 = '700000000000000202';
const U1 = '700000000000000101';
const reg = { projects: { alpha: { keyEnv: 'KA' }, beta: { keyEnv: 'KB', roster: { bbot: { keyEnv: 'KB_BOT' } } } } };
const TOKEN = { SYNAPSE_DISCORD_TOKEN: fakeToken() };
const base = (discord, extra = {}) => ({ version: 2, people: { olive: { roles: ['owner'], accounts: { discord: U1 } } }, owners: ['olive'], discord, ...extra });
const fatalText = (f) => f.filter((x) => x.level === 'fatal').map((x) => x.message).join('\n');
const warnText = (f) => f.filter((x) => x.level === 'warn').map((x) => x.message).join('\n');

test('a valid block passes; the token is required only when enabled, and must have a bot token\'s shape', () => {
  const d = { enabled: true, projects: { alpha: { channels: { code: CH1, build: CH2 }, cards: 'build' } } };
  assert.equal(hasFatal(checkDiscord(base(d), reg, TOKEN)), false);
  assert.match(fatalText(checkDiscord(base(d), reg, {})), /SYNAPSE_DISCORD_TOKEN is not set/);
  for (const bad of ['short', 'x'.repeat(60), 'aaaa.bbbb.cccc', `${Buffer.from('not-digits-here').toString('base64url')}.abcdef.${'c'.repeat(30)}`]) {
    assert.match(fatalText(checkDiscord(base(d), reg, { SYNAPSE_DISCORD_TOKEN: bad })), /does not look like a Discord bot token/, bad.slice(0, 12));
  }
  assert.equal(discordTokenProblem(fakeToken()), null);
  assert.equal(hasFatal(checkDiscord(base({ ...d, enabled: false }), reg, {})), false, 'off: no token needed');
  assert.equal(hasFatal(checkDiscord(base({ ...d, tokenEnv: 'MY_BOT' }), reg, { MY_BOT: TOKEN.SYNAPSE_DISCORD_TOKEN })), false, 'a custom token variable');
});

test('the token can never be a bus key: not its variable, not its value', () => {
  const d = { enabled: true, projects: { alpha: { channels: { code: CH1 } } } };
  assert.match(fatalText(checkDiscord(base({ ...d, tokenEnv: 'KA' }), reg, { KA: TOKEN.SYNAPSE_DISCORD_TOKEN })), /KA, which holds a bus key/);
  assert.match(fatalText(checkDiscord(base({ ...d, tokenEnv: 'KB_BOT' }), reg, { KB_BOT: TOKEN.SYNAPSE_DISCORD_TOKEN })), /holds a bus key/, 'a per-bot key variable too');
  assert.match(fatalText(checkDiscord(base(d), reg, { ...TOKEN, KA: TOKEN.SYNAPSE_DISCORD_TOKEN })), /same value as a bus key/);
});

test('duplicate mappings are refused when on, and warned about when off', () => {
  const twoProjects = { projects: { alpha: { channels: { code: CH1 } }, beta: { channels: { code: CH1 } } } };
  assert.match(fatalText(checkDiscord(base({ ...twoProjects, enabled: true }), reg, TOKEN)), /mapped to both project "alpha" and project "beta"/);
  const off = checkDiscord(base({ ...twoProjects, enabled: false }), reg, {});
  assert.equal(hasFatal(off), false);
  assert.match(warnText(off), /mapped to both project "alpha" and project "beta".*the Discord pack is off/);
  const twoChannels = { enabled: true, projects: { alpha: { channels: { code: CH1, build: CH1 } } } };
  assert.match(fatalText(checkDiscord(base(twoChannels), reg, TOKEN)), /mapped to both channels\.code and channels\.build/);
});

test('duplicate account mappings are always refused; a malformed Discord id is fatal only with the pack on', () => {
  const two = { olive: { roles: ['owner'], accounts: { discord: U1 } }, sam: { roles: ['approver'], accounts: { discord: U1 } } };
  assert.match(fatalText(checkConfig(base(undefined, { people: two }))), /one id is listed for both "olive" and "sam"/);
  const malformed = { olive: { roles: ['owner'], accounts: { discord: 'olive#1234' } } };
  assert.match(fatalText(checkConfig(base({ enabled: true }, { people: malformed }))), /accounts\.discord must be a Discord user id/);
  const off = checkConfig(base({ enabled: false }, { people: malformed }));
  assert.equal(hasFatal(off), false);
  assert.match(warnText(off), /accounts\.discord must be a Discord user id/);
});

test('bad shapes are refused with the pack on and only warned about with it off', () => {
  const cases = [
    [{ webhook: 'x' }, /unknown field "webhook"/],
    [{ tokenEnv: 'lower-case' }, /tokenEnv/],
    [{ projects: { alpha: { channels: { code: 'general' } } } }, /must be a Discord channel id/],
    [{ projects: { alpha: { channels: { nosuch: CH1 } } } }, /"nosuch" is not a bus channel/],
    [{ projects: { gamma: { channels: { code: CH1 } } } }, /project "gamma" is not in projects\.json/],
    [{ projects: { alpha: { channels: { code: CH1 }, cards: 'build' } } }, /cards must name one of that project's mapped bus channels/],
    [{ projects: { alpha: { channels: { code: CH1 }, extra: 1 } } }, /unknown field "extra"/],
  ];
  for (const [d, re] of cases) {
    assert.match(fatalText(checkDiscord(base({ ...d, enabled: true }), reg, TOKEN)), re, `on: ${JSON.stringify(d)}`);
    const off = checkDiscord(base({ ...d, enabled: false }), reg, {});
    assert.equal(hasFatal(off), false, `off: ${JSON.stringify(d)}`);
    assert.match(warnText(off), re, `off warns: ${JSON.stringify(d)}`);
  }
  assert.equal(hasFatal(checkDiscord(base({ enabled: 'yes' }), reg, {})), false, '"yes" is not true, so the pack is off and this only warns');
});

test('warnings: nothing mapped, or no owner or approver with a Discord account', () => {
  const f = checkDiscord({ version: 2, people: { olive: { roles: ['owner'] } }, owners: ['olive'], discord: { enabled: true } }, reg, TOKEN);
  assert.equal(hasFatal(f), false);
  assert.ok(f.some((x) => /no Discord channel is mapped/.test(x.message)));
  assert.ok(f.some((x) => /no owner or approver has a Discord account id/.test(x.message)));
});

test('no finding ever quotes a Discord id or the token', () => {
  const d = { enabled: true, projects: { alpha: { channels: { code: CH1 } }, beta: { channels: { code: CH1 } } } };
  const text = checkDiscord(base(d), reg, { SYNAPSE_DISCORD_TOKEN: 'bad token with spaces in it here' }).map((x) => x.message).join('\n');
  assert.ok(!text.includes(CH1) && !text.includes(U1) && !text.includes('bad token'));
});

test('redaction: exact key values and credential shapes become [redacted]', () => {
  const key = 'k'.repeat(10) + 'SECRET' + 'k'.repeat(10);
  const redact = createRedactor([key, 'short', '', null]);
  assert.equal(redact(`use ${key} now`), 'use [redacted] now');
  assert.equal(redact('short stays'), 'short stays', 'values under 8 characters are not treated as secrets (bus keys are 24 or more)');
  // Credential shapes, built at run time so this file itself holds no token-shaped text.
  const botToken = ['M' + 'a'.repeat(23), 'b'.repeat(6), 'c'.repeat(27)].join('.');
  const gh = 'ghp' + '_' + 'd'.repeat(36);
  const hook = 'https://discord.com/api/web' + 'hooks/12345678/' + 'e'.repeat(30);
  const out = redact(`t=${botToken} g=${gh} w=${hook}`);
  assert.ok(!out.includes(botToken) && !out.includes(gh) && !out.includes(hook), out);
  assert.equal((out.match(/\[redacted\]/g) || []).length, 3);
});
