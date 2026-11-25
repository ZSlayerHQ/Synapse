// A failed or timed-out bus call reaches the calling agent as an MCP error result (isError: true) through the real tool
// handlers, not only at the HTTP-helper layer. The client is pointed at a mock server via --url before import.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pinEnv, listenInRange, closeServer } from './helpers.mjs';

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/tasks' || p === '/api/message') return; // never answers
  if (p === '/api/locks') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"boom"}'); }
  if (p === '/api/lock') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not here"}');
});
const port = await listenInRange(server);
after(() => closeServer(server));

pinEnv({ DEV_SYNC_API_TIMEOUT_MS: '200' });
process.argv.push('--url', `ws://127.0.0.1:${port}/ws`, '--developer', 'toolerrtest');
const { handleToolCall } = await import('../../client/index.js');
const call = (name, args = {}) => Promise.race([
  handleToolCall({ params: { name, arguments: args } }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('no answer: no wait limit')), 3000)),
]);

test('a read that times out is an error result', async () => {
  const out = await call('dev_task_list', {});
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /^Synapse did not answer within 200 ms on \/api\/tasks/);
});

test('a write that times out is an error result that says it may already have been applied', async () => {
  const out = await call('dev_msg_send', { channel: 'code', content: 'hello' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /on POST \/api\/message\. The request may already have been applied/);
});

test('a server error is an error result; a success is not', async () => {
  const bad = await call('dev_sync_locks', {});
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text, 'boom');
  const good = await call('dev_sync_unlock', { file: 'a.txt' });
  assert.ok(!good.isError);
  assert.equal(good.content[0].text, 'Released lock on a.txt.');
});

test('a file that cannot be read is an error result, before any request', async () => {
  const out = await call('dev_send_file', { filePath: 'Z:/definitely/not/here.txt' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /^File not sent: /);
});

test('an unknown or cut tool name is an error result', async () => {
  for (const name of ['dev_service_list', 'dev_job_finish', 'dev_bus_status', 'nope']) {
    const out = await call(name, {});
    assert.equal(out.isError, true, name);
    assert.equal(out.content[0].text, `Unknown tool: ${name}`);
  }
});
