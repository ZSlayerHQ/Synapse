// With Discord switched off, the core never loads discord.js, @discordjs/*, or the pack itself: checked in a fresh
// process that records every module it resolves while a bus runs a full card round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const child = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'no-discord-child.mjs');
const env = { ...process.env };
delete env.DEV_SYNC_SEAT;
delete env.NODE_OPTIONS;

for (const mode of ['off', 'mapped-but-off']) {
  test(`discord disabled (${mode}): discord.js and the pack are never loaded, and the core works as before`, () => {
    const r = spawnSync(process.execPath, [child, mode], { encoding: 'utf8', env, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.ok(out.resolved.length > 20, 'the recorder saw the core load');
    assert.ok(out.resolved.some((u) => u.endsWith('/server/server.mjs')), 'the recorder saw the server');
    const discord = out.resolved.filter((u) => /discord/i.test(u));
    assert.deepEqual(discord, [], 'no Discord module was resolved');
    assert.equal(out.channel, 'dashboard');
    assert.equal(out.delivery, 'dashboard');
    assert.equal(out.answered, 200);
  });
}
