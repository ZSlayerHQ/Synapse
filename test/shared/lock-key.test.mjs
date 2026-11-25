// The one lock-key policy (shared/lock-key.cjs): the pure function on Windows- and POSIX-shaped paths, then the bus and the
// hook library on a real project folder, so a lock taken through either one is seen by the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startBus } from '../helpers/bus.mjs';

const require = createRequire(import.meta.url);
const { lockKey, foldKey, caseInsensitiveAt } = require('../../shared/lock-key.cjs');
const hookLib = require('../../hooks/lib/synapse-hook.cjs');

test('lockKey: separators, "." and "..", absolute paths under the root, whole-segment containment', () => {
  const W = 'C:/dev/proj';
  const BS = String.fromCharCode(92);
  assert.equal(lockKey(W, ['C:', 'dev', 'proj', 'src', 'a.js'].join(BS)), 'src/a.js', 'backslashes');
  assert.equal(lockKey(W, './src//a.js'), 'src/a.js');
  assert.equal(lockKey(W, 'src/x/../a.js'), 'src/a.js');
  assert.equal(lockKey(W, 'C:/dev/proj/src/a.js'), 'src/a.js', 'absolute under the root');
  assert.equal(lockKey(W, 'c:/dev/proj/src/a.js'), 'src/a.js', 'the drive letter is case-blind');
  assert.equal(lockKey(W, 'C:/dev/proj2/a.js'), 'C:/dev/proj2/a.js', 'a sibling with the root as a name prefix is outside');
  assert.equal(lockKey(W, '../other/a.js'), 'C:/dev/other/a.js', 'a relative path that leaves the root keeps its full path');
  assert.equal(lockKey(W, '..prefix/a.js'), '..prefix/a.js', 'a name starting with ".." is an ordinary name');
  assert.equal(lockKey('/home/u/proj', '/home/u/proj/lib/b.js'), 'lib/b.js');
  assert.equal(lockKey('/home/u/proj', '/etc/hosts'), '/etc/hosts', 'outside: the absolute path, never the basename');
  assert.equal(lockKey('/home/u/proj', '/home/u/proj'), '.');
  assert.equal(lockKey(null, './a//b/../c.js'), 'a/c.js', 'no root: a normalized relative path');
});

test('lockKey: case-insensitive matching keeps the spelling, foldKey gives the shared identity, and the key is idempotent', () => {
  const W = 'C:/Dev/Proj';
  assert.equal(lockKey(W, 'c:/dev/proj/Src/A.js', { caseInsensitive: true }), 'Src/A.js');
  assert.equal(lockKey(W, 'c:/dev/proj/Src/A.js', { caseInsensitive: false }), 'C:/dev/proj/Src/A.js', 'case-sensitive: another folder');
  assert.equal(foldKey('Src/A.js', true), foldKey('src/a.js', true));
  assert.notEqual(foldKey('Src/A.js', false), foldKey('src/a.js', false));
  for (const ci of [true, false]) {
    for (const f of ['src/a.js', 'C:/dev/proj/src/a.js', 'C:/elsewhere/b.js', '../up.js', 'C:/Dev/Proj/x/../y.js']) {
      const k = lockKey(W, f, { caseInsensitive: ci });
      assert.equal(lockKey(W, k, { caseInsensitive: ci }), k, `idempotent: ${f} (ci ${ci})`);
    }
  }
});

test('bus and hook agree on a real project folder: absolute, relative, outside-root and case variants', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-lockkey-'));
  fs.mkdirSync(path.join(root, '.synapse'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-lockkey-out-'));
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot', 'helper'], root } } });
  const A = { key: fx.keys.alpha, project: 'alpha' };
  const blocked = async (file) => (await fx.call('POST', '/api/will-edit', { ...A, body: { developer: 'helper', file } })).body.safe === false;
  try {
    const ci = caseInsensitiveAt(root);
    // The hook turns the tool's absolute path into a key; the bus must treat that key and the raw path as one lock.
    const abs = path.join(root, 'src', 'Canon.js');
    const hookKey = hookLib.rootRelative(root, abs);
    assert.equal(hookKey, 'src/Canon.js');
    await fx.call('POST', '/api/lock', { ...A, body: { developer: 'alphabot', file: hookKey } });
    assert.equal(await blocked(abs), true, 'the absolute path');
    assert.equal(await blocked('./src//Canon.js'), true, 'a relative spelling');
    assert.equal(await blocked('SRC/canon.js'), ci, `another case: one lock only where the project folder is case-insensitive (${ci})`);
    // Outside the root: the hook and the bus both keep the full path, so two outside files with one name stay apart.
    const out1 = path.join(outside, 'a', 'same.js');
    const out2 = path.join(outside, 'b', 'same.js');
    const outKey = hookLib.rootRelative(root, out1);
    assert.equal(outKey, out1.split(path.sep).join('/').replace(/^([a-z]):/, (m, d) => `${d.toUpperCase()}:`));
    await fx.call('POST', '/api/lock', { ...A, body: { developer: 'alphabot', file: outKey } });
    assert.equal(await blocked(out1), true);
    assert.equal(await blocked(out2), false, 'same basename, other folder: another file');
    assert.equal(await blocked('same.js'), false, 'a root file with that basename: another file');
  } finally {
    await fx.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
