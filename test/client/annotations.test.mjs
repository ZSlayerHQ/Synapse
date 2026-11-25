// Every tool def carries an honest annotations object from exactly one class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinEnv } from './helpers.mjs';

pinEnv();
const { TOOLS } = await import('../../client/index.js');

// Expected values restated here, independent of the constants in index.js, so a drifted class constant fails here.
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const UNTRUSTED_READ = { destructiveHint: false, idempotentHint: false, openWorldHint: false };
const INTERNAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const OPEN_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const EXPECTED = {
  // true reads (closed world)
  dev_task_list: READ,
  dev_sync_activity: READ,
  dev_onboarding_guide: READ,
  // reads that ingest text other parties wrote (readOnlyHint deliberately omitted)
  dev_msg_history: UNTRUSTED_READ,
  dev_get_file: UNTRUSTED_READ,
  // coordination writes (the server also prunes/logs)
  dev_sync_status: INTERNAL_WRITE,
  dev_sync_locks: INTERNAL_WRITE,
  dev_sync_checkin: INTERNAL_WRITE,
  dev_sync_lock: INTERNAL_WRITE,
  dev_sync_unlock: INTERNAL_WRITE,
  dev_sync_will_edit: INTERNAL_WRITE,
  dev_sync_did_edit: INTERNAL_WRITE,
  dev_log: INTERNAL_WRITE,
  // internal record writes
  dev_task_create: INTERNAL_WRITE,
  dev_report_error: INTERNAL_WRITE,
  // writes people may see on the dashboard or an optional relay
  dev_task_update: OPEN_WRITE,
  dev_msg_send: OPEN_WRITE,
  dev_msg_broadcast: OPEN_WRITE,
  dev_notify_human: OPEN_WRITE,
  dev_send_file: OPEN_WRITE,
  dev_ask: OPEN_WRITE,
  // internal seat signals
  dev_sync_alert: INTERNAL_WRITE,
  dev_wake: INTERNAL_WRITE,
};

test('the TOOLS array is exactly the 23 tools the matrix covers', () => {
  assert.equal(TOOLS.length, 23);
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), Object.keys(EXPECTED).sort());
});

test('every tool def carries the annotations of exactly one class', () => {
  for (const t of TOOLS) {
    assert.deepEqual(t.annotations, EXPECTED[t.name], `annotations mismatch on ${t.name}`);
  }
});

test('the untrusted-read class omits readOnlyHint and nothing else does', () => {
  for (const t of TOOLS) {
    const hasReadOnly = Object.prototype.hasOwnProperty.call(t.annotations, 'readOnlyHint');
    if (t.name === 'dev_msg_history' || t.name === 'dev_get_file') {
      assert.equal(hasReadOnly, false, `${t.name} must not declare readOnlyHint`);
    } else {
      assert.equal(hasReadOnly, true, `${t.name} must declare readOnlyHint explicitly`);
    }
  }
});
