// dev_onboarding_guide: a read-only tool that returns AGENTS.md from the app folder above client/, read asynchronously from a
// regular file of at most 64 KiB; a guide that is missing, unreadable, not a file or too large gets an error result naming
// the path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinEnv, CLIENT_DIR } from './helpers.mjs';

pinEnv();
const { TOOLS, handleToolCall, readOnboardingGuide, ONBOARDING_GUIDE_FILE, ONBOARDING_GUIDE_MAX_BYTES } = await import('../../client/index.js');

const GUIDE = path.resolve(CLIENT_DIR, '..', 'AGENTS.md');
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const textOf = (r) => r.content.map((c) => c.text).join('');

test('the tool is listed read-only, names AGENTS.md, and takes no parameters', () => {
  const t = TOOLS.find((x) => x.name === 'dev_onboarding_guide');
  assert.ok(t, 'dev_onboarding_guide is listed');
  assert.deepEqual(t.annotations, READ);
  assert.match(t.description, /AGENTS\.md/);
  assert.match(t.description, /Read-only\.$/);
  assert.deepEqual(t.inputSchema, { type: 'object', properties: {} });
});

test('the file is found from the client\'s own location: AGENTS.md in the folder above client/', () => {
  assert.equal(path.resolve(ONBOARDING_GUIDE_FILE), GUIDE);
});

test('a call returns the guide\'s exact text when it is installed, or a plain error naming the path when it is not', async () => {
  const r = await handleToolCall({ params: { name: 'dev_onboarding_guide', arguments: {} } });
  assert.equal(ONBOARDING_GUIDE_MAX_BYTES, 65536);
  if (fs.existsSync(GUIDE)) {
    assert.notEqual(r.isError, true);
    assert.equal(textOf(r), fs.readFileSync(GUIDE, 'utf8'));
  } else {
    assert.equal(r.isError, true);
    assert.ok(textOf(r).includes(GUIDE));
    assert.ok(textOf(r).includes('the file is missing'));
  }
});

test('a guide that reads: its exact text, not an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-guide-ok-'));
  try {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, '# Synapse for agents\n\nStep one.\n');
    const r = await readOnboardingGuide(file);
    assert.notEqual(r.isError, true);
    assert.equal(textOf(r), '# Synapse for agents\n\nStep one.\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a guide that is missing, a directory or too large gets a plain error result naming the path, never a throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-guide-'));
  try {
    const big = path.join(dir, 'big.md');
    fs.writeFileSync(big, 'x'.repeat(ONBOARDING_GUIDE_MAX_BYTES + 1));
    const exact = path.join(dir, 'exact.md');
    fs.writeFileSync(exact, 'y'.repeat(ONBOARDING_GUIDE_MAX_BYTES));
    for (const [file, why] of [[path.join(dir, 'app', 'AGENTS.md'), 'missing'], [dir, 'not a file'], [big, `larger than ${ONBOARDING_GUIDE_MAX_BYTES} bytes`]]) {
      const r = await readOnboardingGuide(file);
      assert.equal(r.isError, true, file);
      const msg = textOf(r);
      assert.ok(msg.includes(file), 'names the path it tried');
      assert.ok(msg.includes(`the file is ${why}`), `says why: ${why}`);
      assert.match(msg, /It ships as AGENTS\.md in the Synapse app folder, beside the client folder/);
      assert.doesNotMatch(msg, /\n\s+at /, 'no stack trace');
    }
    const ok = await readOnboardingGuide(exact);
    assert.notEqual(ok.isError, true, 'a file exactly at the cap is read');
    assert.equal(textOf(ok).length, ONBOARDING_GUIDE_MAX_BYTES);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
