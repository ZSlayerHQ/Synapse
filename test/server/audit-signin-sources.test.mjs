// Regressions for audit run-2 candidates on the personal-key backoff: failures under an owner's name cannot hold out
// an owner whose key already verified on this bus; switching between loopback source addresses does not reset the
// backoff; made-up names share one record per source. In-process bus on a random 4600-4999 port.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startBus } from '../helpers/bus.mjs';

const OWNER = { human: 'owner1', key: 'owner-key-0123456789' };
function whoami(fx, headers, localAddress) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.bus.port, path: '/api/whoami', headers, ...(localAddress ? { localAddress } : {}) }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}
const asOwner = (key) => ({ 'X-Synapse-Human': OWNER.human, 'X-Dev-Key': key });

test('failures under an owner\'s name never hold out the owner once their key has verified on this bus', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] } }, people: { owner1: { key: OWNER.key } } });
  try {
    assert.equal(await whoami(fx, asOwner(OWNER.key)), 200, 'the owner signs in (the dashboard does this on load)');
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push(await whoami(fx, asOwner('wrong-key-0123456789')));
    assert.ok(statuses.includes(429), 'wrong keys under the owner\'s name back off');
    assert.equal(await whoami(fx, asOwner(OWNER.key)), 200, 'the owner is not held by the backoff');
    assert.equal(await whoami(fx, asOwner('wrong-key-0123456789')), 429, 'the guesser still is');
  } finally { await fx.close(); }
});

test('another loopback source address does not reset the backoff, and made-up names share one record', async (t) => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] } }, people: { owner1: { key: OWNER.key } } });
  try {
    try { await whoami(fx, {}, '127.0.0.2'); } catch { t.skip('this OS cannot bind 127.0.0.2'); return; }
    for (let i = 0; i < 5; i++) await whoami(fx, asOwner('wrong-key-0123456789'), '127.0.0.1');
    const rotated = [];
    for (let i = 2; i < 12; i++) rotated.push(await whoami(fx, asOwner('wrong-key-0123456789'), `127.0.0.${i}`));
    assert.ok(rotated.every((s) => s === 429), `every other loopback address is held too (${rotated.join(',')})`);
    const made = [];
    for (let i = 0; i < 12; i++) made.push(await whoami(fx, { 'X-Synapse-Human': `nobody${i}`, 'X-Dev-Key': 'wrong-key-0123456789' }));
    assert.ok(made.includes(429), 'made-up names back off together');
  } finally { await fx.close(); }
});
