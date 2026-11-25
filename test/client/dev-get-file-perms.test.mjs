// Regression for the security audit (run-1): dev_get_file saves under a per-user private folder, never a shared one.
// The default folder is inside the Synapse home; the folder is created 0700 and each file 0600; a pre-existing folder
// owned by someone else, or writable by group or others, is refused. Mode and owner checks run on POSIX only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pinEnv } from './helpers.mjs';

const home = pinEnv();
process.argv.push('--project', 'testproj', '--developer', 'permtest');
const { makeFileSaver, SYNAPSE_HOME } = await import('../../client/index.js');

const POSIX = process.platform !== 'win32';
const bytes = Buffer.from('PK\u0003\u0004 not really a zip');
const view = () => ({ id: crypto.randomUUID(), filename: 'bundle.zip', tier: 'archive', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
// No network: the download is a local Response.
const save = makeFileSaver({ httpUrl: 'http://127.0.0.1:1', headers: () => ({}), fetchImpl: async () => new Response(bytes, { status: 200 }) });

const scratch = [];
let oldUmask;
beforeEach(() => { delete process.env.SYNAPSE_FILES_DIR; if (POSIX) oldUmask = process.umask(0o022); });
afterEach(() => {
  if (POSIX) process.umask(oldUmask);
  for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(path.join(home, 'data'), { recursive: true, force: true });
});
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'getfile-perm-')); scratch.push(d); return d; };

test('the default folder is inside the Synapse home, not the shared temp folder', async () => {
  assert.equal(SYNAPSE_HOME, path.resolve(home));
  const r = await save(view());
  assert.equal(r.ok, true, r.reason);
  assert.equal(path.dirname(r.path), path.join(SYNAPSE_HOME, 'data', 'synapse-files'));
  assert.notEqual(path.dirname(r.path), path.join(os.tmpdir(), 'synapse-files'));
});

test('the folder is 0700 and the file 0600, by default and under SYNAPSE_FILES_DIR', { skip: !POSIX && 'POSIX modes' }, async () => {
  for (const base of [null, tempDir()]) {
    if (base) process.env.SYNAPSE_FILES_DIR = base; else delete process.env.SYNAPSE_FILES_DIR;
    const r = await save(view());
    assert.equal(r.ok, true, r.reason);
    assert.equal(fs.statSync(path.dirname(r.path)).mode & 0o777, 0o700, `folder under ${base || 'the home'}`);
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o600, `file under ${base || 'the home'}`);
  }
});

test('a pre-existing folder writable by group or others is refused', { skip: !POSIX && 'POSIX modes' }, async () => {
  for (const mode of [0o777, 0o775, 0o757]) {
    const base = tempDir();
    process.env.SYNAPSE_FILES_DIR = base;
    fs.mkdirSync(path.join(base, 'synapse-files'));
    fs.chmodSync(path.join(base, 'synapse-files'), mode);
    const r = await save(view());
    assert.equal(r.ok, false, mode.toString(8));
    assert.match(r.reason, /local folder could not be used/);
    assert.deepEqual(fs.readdirSync(path.join(base, 'synapse-files')), [], 'nothing was written into it');
  }
});

test('a pre-existing folder owned by another user is refused', { skip: !(POSIX && process.getuid() === 0) && 'needs root to give a folder away' }, async () => {
  const base = tempDir();
  process.env.SYNAPSE_FILES_DIR = base;
  fs.mkdirSync(path.join(base, 'synapse-files'), { mode: 0o700 });
  fs.chownSync(path.join(base, 'synapse-files'), 12345, 12345);
  const r = await save(view());
  assert.equal(r.ok, false);
  assert.match(r.reason, /local folder could not be used/);
});
