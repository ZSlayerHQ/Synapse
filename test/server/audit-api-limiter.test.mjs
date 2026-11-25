// Regression for audit run-2 candidate "api-limiter-ip-keyed-before-auth": the request budget is per authenticated
// principal, so failing requests from one address, or one project's traffic, cannot make other callers get 429.
// An in-process bus on a random 4600-4999 port.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startBus } from '../helpers/bus.mjs';

const OWNER = { human: 'owner1', key: 'owner-key-0123456789' };
const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
function get(fx, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.bus.port, path: '/api/whoami', headers, agent }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}
async function burst(n, fn) { for (let i = 0; i < n; i += 50) await Promise.all(Array.from({ length: Math.min(50, n - i) }, fn)); }

test('a pre-auth flood and one project\'s traffic do not use up other callers\' request budget', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] } }, people: { owner1: { key: OWNER.key } } });
  try {
    await burst(1250, () => get(fx, { 'X-Dev-Project': 'beta' }));
    assert.equal(await get(fx, { 'X-Dev-Key': fx.keys.beta, 'X-Dev-Project': 'beta' }), 200, 'beta after 1250 keyless requests from the same address');
    assert.equal(await get(fx, { 'X-Synapse-Human': OWNER.human, 'X-Dev-Key': OWNER.key }), 200, 'the owner after the flood');
    const statuses = [];
    await burst(1210, async () => statuses.push(await get(fx, { 'X-Dev-Key': fx.keys.alpha, 'X-Dev-Project': 'alpha' })));
    assert.ok(statuses.includes(429), 'one principal still has a budget');
    assert.equal(await get(fx, { 'X-Dev-Key': fx.keys.beta, 'X-Dev-Project': 'beta' }), 200, 'beta is unaffected by alpha');
  } finally { agent.destroy(); await fx.close(); }
});
