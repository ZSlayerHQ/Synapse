// The dev_get_file result mapper (mapAgentFileResult).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinEnv } from './helpers.mjs';

pinEnv();
const { mapAgentFileResult } = await import('../../client/index.js');

test('image result -> MCP image content block (base64 as data, mimetype as mimeType)', () => {
  const out = mapAgentFileResult({ kind: 'image', base64: 'QUJD', mimetype: 'image/png', filename: 'p.png' });
  assert.deepEqual(out, { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }] });
  assert.ok(!out.isError);
});

test('text result -> the untrusted-wrapped text verbatim, then the save hint as its own block', () => {
  const out = mapAgentFileResult({ kind: 'text', text: '⟦untrusted…⟧ hi', filename: 'n.txt' });
  assert.equal(out.content[0].type, 'text');
  assert.equal(out.content[0].text, '⟦untrusted…⟧ hi');
  assert.equal(out.content[1].text, 'If this text was cut short, call dev_get_file again with save: true to get the whole file.');
  assert.ok(!out.isError);
});

test('audio / blocked -> the server note as text (not an error)', () => {
  for (const kind of ['audio', 'blocked']) {
    const out = mapAgentFileResult({ kind, note: `note-for-${kind}`, filename: 'f' });
    assert.equal(out.content[0].type, 'text');
    assert.equal(out.content[0].text, `note-for-${kind}`);
    assert.ok(!out.isError);
  }
});

// These kinds are saved by the tool; without a saved copy they are errors and the server's key-directed note is never shown.
test('archive / document / binary / too_large without a saved copy -> isError, and the key-directed note is never shown', () => {
  for (const kind of ['archive', 'document', 'binary', 'too_large']) {
    const id = '0c4b90af-f68d-4474-8f11-440055559050';
    const out = mapAgentFileResult({ id, kind, filename: 'bundle.zip', note: `download at /api/files/${id} with your X-Dev-Key` });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /^Could not save "bundle\.zip": /);
    assert.doesNotMatch(out.content[0].text, /X-Dev-Key|\/api\/files/);
  }
});

test('non-2xx (api surfaced { error }) -> friendly isError text', () => {
  const out = mapAgentFileResult({ error: 'File not found' });
  assert.equal(out.content[0].type, 'text');
  assert.equal(out.content[0].text, 'File not found or not accessible to this project.');
  assert.equal(out.isError, true);
});

test('null / undefined result -> isError (a tool must never read a failure as success)', () => {
  assert.equal(mapAgentFileResult(null).isError, true);
  assert.equal(mapAgentFileResult(undefined).isError, true);
});
