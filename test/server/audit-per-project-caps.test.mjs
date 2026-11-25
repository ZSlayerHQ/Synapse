// Regression for the security audit (run-1), candidate (c): capped stores are capped per project, so one project's writes
// never evict another project's records.
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

// ─── (c) Capped stores are capped per project: one project's writes never evict another's records ───

test('caps: tasks and activity are capped per project', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] } } });
  try {
    const A = { key: fx.keys.alpha, project: 'alpha' };
    const B = { key: fx.keys.beta, project: 'beta' };
    await fx.call('POST', '/api/tasks', { ...B, body: { title: 'beta task', createdBy: 'betabot' } });
    await fx.call('POST', '/api/did-edit', { ...B, body: { developer: 'betabot', file: 'b.txt' } });
    for (let i = 0; i < 201; i++) await fx.call('POST', '/api/tasks', { ...A, body: { title: `a${i}`, createdBy: 'alphabot' } });
    for (let i = 0; i < 300; i++) await fx.call('POST', '/api/did-edit', { ...A, body: { developer: 'alphabot', file: `a${i}.txt` } });
    assert.equal((await fx.call('GET', '/api/tasks', B)).body.tasks.length, 1, 'beta keeps its task');
    assert.equal((await fx.call('GET', '/api/tasks', A)).body.tasks.length, 200, 'alpha is capped at its own 200');
    const betaActivity = (await fx.call('GET', '/api/activity?limit=500', B)).body.entries;
    assert.ok(betaActivity.some((e) => e.action === 'edit' && e.file === 'b.txt'), 'beta keeps its activity');
  } finally { await fx.close(); }
});

test('caps: notifications, errors and log buffers are capped per project; a bot name shared by two projects keeps two buffers', async () => {
  const fx = await startBus({
    projects: { alpha: { bots: ['alphabot', 'shared'] }, beta: { bots: ['betabot', 'shared'] } },
    people: { owner1: { key: OWNER.key }, guest: { key: GUEST.key, roles: ['pingable'], projects: ['beta'] } },
  });
  try {
    const A = { key: fx.keys.alpha, project: 'alpha' };
    const B = { key: fx.keys.beta, project: 'beta' };
    await fx.call('POST', '/api/notify', { ...B, body: { sender: 'betabot', message: 'beta note', tag: 'owner1' } });
    await fx.call('POST', '/api/errors', { ...B, body: { developer: 'betabot', message: 'beta error' } });
    await fx.call('POST', '/api/logs', { ...B, body: { developer: 'shared', lines: 'beta line' } });
    for (let i = 0; i < 201; i++) await fx.call('POST', '/api/notify', { ...A, body: { sender: 'alphabot', message: `a${i}`, tag: 'owner1' } });
    for (let i = 0; i < 201; i++) await fx.call('POST', '/api/errors', { ...A, body: { developer: 'alphabot', message: `e${i}` } });
    await fx.call('POST', '/api/logs', { ...A, body: { developer: 'shared', lines: Array.from({ length: 201 }, (_, i) => ({ line: `a${i}` })) } });
    const notes = (await fx.call('GET', '/api/notifications', { human: GUEST.human, key: GUEST.key, project: 'beta' })).body.notifications;
    assert.ok(notes.some((n) => n.message === 'beta note'), 'beta keeps its notification');
    assert.ok((await fx.call('GET', '/api/errors', B)).body.errors.some((e) => e.message === 'beta error'), 'beta keeps its error');
    const logs = (await fx.call('GET', '/api/logs', B)).body.logs;
    assert.deepEqual((logs.shared || []).map((r) => r.line), ['beta line'], 'beta keeps its own log buffer');
    const alphaLogs = (await fx.call('GET', '/api/logs', A)).body.logs;
    assert.ok(alphaLogs.shared.every((r) => r.project === 'alpha'));
  } finally { await fx.close(); }
});

test('caps: the file store budget is shared out per project, so one project\'s uploads never evict another\'s files', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] }, beta: { bots: ['betabot'] } }, extraEnv: { SYNAPSE_FILES_MAX_BYTES: '4000' } });
  try {
    const up = async (key, project, sender, size) => {
      const form = new FormData();
      form.append('file', new Blob(['x'.repeat(size)]), 'blob.txt');
      form.append('sender', sender);
      const r = await fetch(`${fx.base}/api/message/file`, { method: 'POST', headers: { 'X-Dev-Key': key, 'X-Dev-Project': project }, body: form });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const betaFile = await up(fx.keys.beta, 'beta', 'betabot', 1000);
    assert.equal(betaFile.status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await up(fx.keys.alpha, 'alpha', 'alphabot', 1000)).status, 200);
    assert.equal((await rawRequest(fx, { path: `/api/files/${betaFile.body.fileId}`, headers: { 'X-Dev-Key': fx.keys.beta, 'X-Dev-Project': 'beta' } })).status, 200, 'beta keeps its file');
    assert.equal((await up(fx.keys.alpha, 'alpha', 'alphabot', 2500)).status, 413, 'a file over the project share is refused');
  } finally { await fx.close(); }
});
