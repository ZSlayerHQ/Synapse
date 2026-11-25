// The hook helper: nearest-config project resolution, the seat-file rule shared with the client, structured output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('../../hooks/lib/synapse-hook.cjs');

test('the nearest .synapse/config.json wins over an enclosing git root', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-hooklib-'));
  try {
    fs.mkdirSync(path.join(outer, '.git'));
    const inner = path.join(outer, 'packages', 'app');
    fs.mkdirSync(path.join(inner, '.synapse'), { recursive: true });
    fs.mkdirSync(path.join(inner, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(inner, '.synapse', 'config.json'), JSON.stringify({ project: 'app', developer: 'appbot', keyEnv: 'K_APP' }));
    assert.equal(lib.findProjectRoot(path.join(inner, 'src', 'deep')), inner);
    assert.equal(lib.findProjectRoot(outer), null, 'no config above or at the git root');
    const cfg = lib.loadConfig({ cwd: path.join(inner, 'src'), env: { SYNAPSE_HOME: path.join(outer, 'home'), K_APP: 'k' } });
    assert.equal(cfg.project, 'app');
    assert.equal(cfg.root, inner);
    assert.equal(lib.rootRelative(cfg.root, path.join(inner, 'src', 'x.js')), 'src/x.js');
  } finally { fs.rmSync(outer, { recursive: true, force: true }); }
});

test('the seat file rule: sha256(session id), first 32 hex; the seat file names the developer', () => {
  assert.equal(lib.seatFileName('abc'), `${crypto.createHash('sha256').update('abc').digest('hex').slice(0, 32)}.json`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-hookseat-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-hookproj-'));
  try {
    fs.mkdirSync(path.join(proj, '.synapse'));
    fs.writeFileSync(path.join(proj, '.synapse', 'config.json'), JSON.stringify({ project: 'p', developer: 'pbot', keyEnv: 'K_P' }));
    fs.mkdirSync(path.join(home, 'data', 'seats'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data', 'seats', lib.seatFileName('s-1')), JSON.stringify({ developer: 'pbot.left', project: 'p' }));
    assert.equal(lib.loadConfig({ cwd: proj, env: { SYNAPSE_HOME: home }, sessionId: 's-1' }).developer, 'pbot.left');
    assert.equal(lib.loadConfig({ cwd: proj, env: { SYNAPSE_HOME: home, DEV_SYNC_SEAT: 'right' }, sessionId: 'other' }).developer, 'pbot.right');
    const auto = lib.loadConfig({ cwd: proj, env: { SYNAPSE_HOME: home, DEV_SYNC_SEAT: 'auto' }, sessionId: 'other' });
    assert.equal(auto.developer, 'pbot');
    assert.match(auto.warnings[0], /DEV_SYNC_SEAT=auto/);
    fs.writeFileSync(path.join(home, 'data', 'seats', lib.seatFileName('s-2')), JSON.stringify({ developer: 'qbot.x', project: 'q' }));
    assert.equal(lib.loadConfig({ cwd: proj, env: { SYNAPSE_HOME: home }, sessionId: 's-2' }).developer, 'pbot', 'a seat file of another project is ignored');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true }); }
});
