// The dev_send_file result texts: "stored" only when the bus says so, the Discord post on its own line, "not stored" only for
// the route's pre-store errors, and everything else "outcome unknown".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinEnv } from './helpers.mjs';

pinEnv();
const { mapSendFileResult, TOOLS } = await import('../../client/index.js');

const text = (out) => out.content[0].text;
const ok = (relay, relayStatus) => ({ fileName: 'shot.png', status: 200, data: { ok: true, id: 'msg-1', fileId: 'f-1', tier: 'media', ...(relay ? { relay, relayStatus } : {}) } });

test('stored + each relay outcome, and a server without relay', () => {
  for (const [relay, status, line] of [
    ['ok', 200, 'Posted to Discord.'],
    ['rejected', 413, 'Discord refused the post (status 413).'],
    ['disabled', null, 'Not posted to Discord (relay off or no webhook for this channel).'],
    ['unknown', 204, 'Discord post unconfirmed.'],
    [undefined, undefined, 'Discord post unconfirmed.'],
  ]) {
    const out = mapSendFileResult(ok(relay, status));
    assert.equal(text(out), `Stored shot.png as fileId f-1 and announced it on the bus. ${line}`);
    assert.ok(!out.isError);
  }
});

test('stored:true on a 500: stored, the announcement may not have been made, do not upload again', () => {
  const out = mapSendFileResult({ fileName: 'log.txt', status: 500, data: { ok: false, stored: true, fileId: 'f-2', error: 'The file is stored, but the upload did not finish' } });
  assert.match(text(out), /^Stored log\.txt as fileId f-2, but the upload did not finish: the bus announcement may not have been made\./);
  assert.match(text(out), /Discord post unconfirmed\./);
  assert.match(text(out), /Do not upload it again/);
  assert.equal(out.isError, true);
});

test('each pre-store error: not stored', () => {
  for (const [status, error] of [[400, 'No file attached'], [413, 'File too large (max 100MB)'], [400, 'bad_upload'], [400, 'File type not allowed']]) {
    const out = mapSendFileResult({ fileName: 'x.bin', status, data: { error } });
    assert.equal(text(out), `x.bin was not stored: ${error}.`);
    assert.equal(out.isError, true);
  }
});

test('everything else is outcome unknown: a 500 without stored:true, a lost response, a non-JSON body, an unlisted error', () => {
  for (const input of [
    { fileName: 'a.txt', status: 500, data: { ok: false, error: 'File upload failed' } },
    { fileName: 'a.txt', lost: 'socket hang up' },
    { fileName: 'a.txt', status: 502, data: null },
    { fileName: 'a.txt', status: 403, data: { error: 'identity_not_in_project_roster' } },
    { fileName: 'a.txt', status: 400, data: { error: 'something new' } },
  ]) {
    const out = mapSendFileResult(input);
    assert.match(text(out), /^Upload outcome unknown for a\.txt/);
    assert.match(text(out), /may already be stored and announced\. Check the channel history for it before retrying\./);
    assert.doesNotMatch(text(out), /not stored/);
    assert.equal(out.isError, true);
  }
});

test('the dev_send_file description promises storage and the announcement, with the Discord post reported separately and optional', () => {
  const d = TOOLS.find((t) => t.name === 'dev_send_file').description;
  assert.match(d, /stored and announced on the bus/);
  assert.match(d, /Discord post is reported on its own line/);
  assert.match(d, /when the optional Discord pack is enabled/);
  assert.doesNotMatch(d, /upload \+ relay were accepted/);
});
