// Every bus call made through the client's api() helper has a wait limit covering the request and the body, classified by
// the deadline signal (the runtime raises TimeoutError, not AbortError). A timed-out write says it may already have been
// applied; nothing is retried. The upload maps a timeout at either stage to "outcome unknown", never "File not sent". Each
// case runs against a mock server and has its own guard, so an unbounded call fails here instead of hanging.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pinEnv, listenInRange, closeServer } from './helpers.mjs';

pinEnv({ DEV_SYNC_API_TIMEOUT_MS: '250', DEV_SYNC_UPLOAD_TIMEOUT_MS: '260' });
const mod = await import('../../client/index.js');
const { makeApi, postFileUpload, API_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } = mod;

const hits = [];
let server;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(req.url);
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/never') return; // no headers, ever
      if (p === '/stall') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":'); return; } // headers, then no body
      if (p === '/late') { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, 600); return; }
      if (p === '/bad') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{not json'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"id":"m1","fileId":"f1"}');
    });
  });
  const port = await listenInRange(server);
  base = `http://127.0.0.1:${port}`;
});
after(() => closeServer(server));

const guard = (p, ms = 3000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('no answer: the call has no wait limit')), ms))]);
const countFor = (path) => hits.filter((h) => h.startsWith(path)).length;
const api = () => makeApi({ httpUrl: base, headers: () => ({ 'X-Dev-Key': 'k' }), defaultTimeoutMs: API_TIMEOUT_MS });

test('the limits come from the environment; a value AbortSignal.timeout would reject falls back to the default', () => {
  assert.equal(API_TIMEOUT_MS, 250);
  assert.equal(UPLOAD_TIMEOUT_MS, 260);
  for (const bad of ['1.5', '-5', '5e9', 'abc', '', '0', undefined, '2147483648', '4294967295']) assert.equal(mod.timeoutFromEnv(bad, 90_000), 90_000, `${bad}`);
  assert.equal(mod.timeoutFromEnv('2147483647', 1), 2147483647, 'the largest delay Node honours');
  assert.doesNotThrow(() => AbortSignal.timeout(mod.timeoutFromEnv('1.5', 90_000)));
});

test('a read that never answers reports a timeout with the effective limit', async () => {
  const r = await guard(api()('GET', '/never?a=1'));
  assert.equal(r.error, 'Synapse did not answer within 250 ms on /never?a=1.');
});

test('a write that never answers says it may already have been applied', async () => {
  const r = await guard(api()('POST', '/never', { x: 1 }));
  assert.match(r.error, /^Synapse did not answer within 250 ms on POST \/never\. The request may already have been applied, or may still be applied later\./);
  assert.match(r.error, /Check its result .* before sending it again; a resend can duplicate it\.$/);
});

test('headers then a stalled body is a timeout, not "non-JSON"', async () => {
  const r = await guard(api()('POST', '/stall', {}));
  assert.match(r.error, /^Synapse did not answer within 250 ms on POST \/stall\./);
});

test('a late answer is still reported as a timeout, and the call was made once', async () => {
  const before = countFor('/late');
  const r = await guard(api()('POST', '/late', {}));
  assert.match(r.error, /did not answer within 250 ms/);
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(countFor('/late') - before, 1, 'one request: no retry');
});

test('controls: malformed JSON keeps its own text; a normal call succeeds; a caller\'s own limit wins', async () => {
  assert.equal((await guard(api()('GET', '/bad'))).error, 'Synapse returned non-JSON on /bad');
  assert.deepEqual(await guard(api()('GET', '/ok')), { ok: true, id: 'm1', fileId: 'f1' });
  const r = await guard(api()('GET', '/never', null, { timeoutMs: 120 }));
  assert.equal(r.error, 'Synapse did not answer within 120 ms on /never.');
});

test('an upload that never answers, or stalls its body, is "outcome unknown", never "File not sent"', async () => {
  for (const p of ['/never', '/stall']) {
    const before = countFor(p);
    const out = await guard(postFileUpload({ fileName: 'x.txt', url: `${base}${p}`, headers: {}, body: Buffer.from('x'), timeoutMs: UPLOAD_TIMEOUT_MS }));
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /^Upload outcome unknown for x\.txt \(the response was lost \(no answer within 260 ms\)\): the file may already be stored/);
    assert.equal(countFor(p) - before, 1, 'one request');
  }
  const good = await guard(postFileUpload({ fileName: 'y.txt', url: `${base}/ok`, headers: {}, body: Buffer.from('y'), timeoutMs: UPLOAD_TIMEOUT_MS }));
  assert.match(good.content[0].text, /^Stored y\.txt as fileId f1/);
});
