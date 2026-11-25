// Regression for the security audit (run-1), candidate (a): alerts, seat entries and locks are bounded per project.
// Every bus here is in-process on a random port in 4600-4999.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBus } from '../helpers/bus.mjs';

// ─── (a) Alerts and seat state are bounded per project ───

test('bounds: alerts are capped per project and the recipient name is bounded', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] } } });
  try {
    const A = { key: fx.keys.alpha, project: 'alpha' };
    const B = { key: fx.keys.beta, project: 'beta' };
    await fx.call('POST', '/api/alert', { ...B, body: { from: 'betabot', to: 'ghost', message: 'beta alert' } });
    for (let i = 0; i < 250; i++) await fx.call('POST', '/api/alert', { ...A, body: { from: 'alphabot', to: 'ghost', message: `a${i}` } });
    const alphaAlerts = (await fx.call('GET', '/api/alerts/ghost', A)).body.alerts;
    assert.ok(alphaAlerts.length <= 200, `alpha keeps at most 200 alerts (got ${alphaAlerts.length})`);
    assert.equal(alphaAlerts[alphaAlerts.length - 1].message, 'a249', 'the newest are kept');
    assert.equal((await fx.call('GET', '/api/alerts/ghost', B)).body.alerts.length, 1, 'beta keeps its alert');
    assert.equal((await fx.call('POST', '/api/alert', { ...A, body: { from: 'alphabot', to: 'x'.repeat(300_000), message: 'm' } })).status, 400);
  } finally { await fx.close(); }
});

test('bounds: seat entries and their free text are capped per project', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] } } });
  try {
    const A = { key: fx.keys.alpha, project: 'alpha' };
    const B = { key: fx.keys.beta, project: 'beta' };
    await fx.call('POST', '/api/checkin', { ...B, body: { developer: 'betabot' } });
    for (let i = 0; i < 150; i++) await fx.call('POST', '/api/checkin', { ...A, body: { developer: `alphabot.s${i}`, workingOn: 'w'.repeat(100_000), branch: 'b'.repeat(10_000) } });
    const devs = (await fx.call('GET', '/api/status', A)).body.developers;
    assert.ok(devs.length <= 100, `alpha keeps at most 100 seat entries (got ${devs.length})`);
    assert.ok(devs.every((d) => d.workingOn.length <= 500 && d.branch.length <= 200), 'free text is capped');
    assert.ok(devs.some((d) => d.name === 'alphabot.s149'), 'the newest seat is kept');
    assert.equal((await fx.call('GET', '/api/status', B)).body.developers.length, 1, 'beta keeps its seat');
  } finally { await fx.close(); }
});

test('bounds: locks are capped per project', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] } } });
  try {
    const A = { key: fx.keys.alpha, project: 'alpha' };
    const B = { key: fx.keys.beta, project: 'beta' };
    for (let i = 0; i < 500; i++) assert.equal((await fx.call('POST', '/api/lock', { ...A, body: { developer: 'alphabot', file: `f${i}.txt` } })).body.ok, true);
    const over = await fx.call('POST', '/api/lock', { ...A, body: { developer: 'alphabot', file: 'one-more.txt' } });
    assert.equal(over.status, 429);
    assert.equal(over.body.error, 'too_many_locks');
    assert.equal((await fx.call('POST', '/api/lock', { ...A, body: { developer: 'alphabot', file: 'f1.txt', reason: 'refresh' } })).body.ok, true, 'a held lock can be renewed at the cap');
    assert.equal((await fx.call('POST', '/api/lock', { ...B, body: { developer: 'betabot', file: 'b.txt' } })).body.ok, true, 'beta is unaffected');
  } finally { await fx.close(); }
});
