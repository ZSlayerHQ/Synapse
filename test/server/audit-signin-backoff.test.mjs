// Regression for the security audit (run-1), candidate (d): failed personal-key attempts back off per person and address,
// so a caller cannot lock an owner out by failing under another name.
// Every bus here is in-process on a random port in 4600-4999.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startBus } from '../helpers/bus.mjs';

const OWNER = { human: 'owner1', key: 'owner-key-0123456789' };
const GUEST = { human: 'guest', key: 'guest-key-0123456789' };

function rawRequest(fx, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.bus.port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body: json, headers: res.headers }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ─── (d) Failed personal-key attempts back off per person and address, not per address ───

test('sign-in: failures under another name never lock an owner out; failures under one name back off that name only', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] } }, people: { owner1: { key: OWNER.key }, guest: { key: GUEST.key, roles: ['approver'] } } });
  try {
    for (let i = 0; i < 25; i++) assert.equal((await fx.call('GET', '/api/whoami', { human: 'nobody', key: 'wrong-key-0123456789' })).status === 200, false);
    assert.equal((await fx.call('GET', '/api/whoami', { human: OWNER.human, key: OWNER.key })).status, 200, 'the owner still signs in');
    assert.equal((await fx.call('GET', '/api/ask/open', { human: OWNER.human, key: OWNER.key })).status, 200);
    let backedOff = null;
    for (let i = 0; i < 25 && !backedOff; i++) {
      const r = await rawRequest(fx, { path: '/api/whoami', headers: { 'X-Synapse-Human': 'guest', 'X-Dev-Key': 'wrong-key-0123456789' } });
      if (r.status === 429) backedOff = r;
    }
    assert.ok(backedOff, 'repeated failures for one name back off');
    const wait = Number(backedOff.headers['retry-after']);
    assert.ok(wait >= 1 && wait <= 60, `the backoff is short and bounded (${wait}s)`);
    assert.equal((await fx.call('GET', '/api/whoami', { human: OWNER.human, key: OWNER.key })).status, 200, 'another person is unaffected');
    assert.equal((await fx.call('GET', '/api/whoami', { key: fx.keys.alpha, project: 'alpha' })).status, 200, 'keys are unaffected');
  } finally { await fx.close(); }
});
