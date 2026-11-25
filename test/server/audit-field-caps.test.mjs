// Regression for audit run-2 candidate "per-project-count-caps-without-field-size-caps": every stored field is size
// capped, so a project's capped record counts also cap the bytes it can put into state.json. In-process bus on a random
// 4600-4999 port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startBus } from '../helpers/bus.mjs';

const BIG = 'x'.repeat(100_000);

test('stored fields are size capped: tasks, errors, logs, lock reasons in activity, meta, direct and wake names', async () => {
  const fx = await startBus({ projects: { alpha: { bots: ['alphabot'] } } });
  let stopped = false;
  try {
    const A = { key: fx.keys.alpha, project: 'alpha' };
    const task = (await fx.call('POST', '/api/tasks', { ...A, body: { title: 't', createdBy: 'alphabot', owner: BIG, branch: BIG, type: BIG, priority: BIG } })).body.task;
    assert.ok(task.owner.length <= 80 && task.branch.length <= 200 && task.type.length <= 32 && String(task.priority).length <= 32, JSON.stringify(task).length);
    const patched = (await fx.call('PATCH', `/api/tasks/${task.id}`, { ...A, body: { status: BIG, owner: BIG, branch: BIG, type: BIG, priority: BIG } })).body.task;
    assert.ok(JSON.stringify(patched).length < 1000, `patched task stays small (${JSON.stringify(patched).length})`);
    assert.equal((await fx.call('POST', '/api/tasks', { ...A, body: { title: 'b', createdBy: 'alphabot', blockedBy: Array.from({ length: 60 }, () => task.id) } })).status, 400);

    await fx.call('POST', '/api/errors', { ...A, body: { developer: 'alphabot', message: 'm', type: BIG, file: BIG, line: BIG, severity: BIG } });
    const err = (await fx.call('GET', '/api/errors', A)).body.errors[0];
    assert.ok(JSON.stringify(err).length < 6000, `error entry stays small (${JSON.stringify(err).length})`);

    await fx.call('POST', '/api/logs', { ...A, body: { developer: 'alphabot', lines: [{ line: 'l', level: BIG }] } });
    assert.ok((await fx.call('GET', '/api/logs', A)).body.logs.alphabot[0].level.length <= 32);

    await fx.call('POST', '/api/lock', { ...A, body: { developer: 'alphabot', file: 'f.txt', reason: BIG } });
    const act = (await fx.call('GET', '/api/activity', A)).body.entries.find((e) => e.action === 'lock');
    assert.ok(act.message.length < 700, `lock activity stays small (${act.message.length})`);

    assert.equal((await fx.call('POST', '/api/message', { ...A, body: { sender: 'alphabot', channel: 'code', content: 'c', meta: { blob: BIG } } })).status, 400);
    assert.equal((await fx.call('POST', '/api/message/broadcast', { ...A, body: { sender: 'alphabot', content: 'c', meta: { blob: BIG } } })).status, 400);
    assert.equal((await fx.call('POST', '/api/message/direct', { ...A, body: { from: 'alphabot', to: BIG, content: 'c' } })).status, 400);
    assert.equal((await fx.call('POST', '/api/wake', { ...A, body: { sender: 'alphabot', seat: BIG } })).status, 400);

    // Over the WebSocket: an oversized `to` or meta is refused with an error frame and stores nothing.
    const ws = new WebSocket(`${fx.wsUrl}?developer=alphabot&project=alpha`, { headers: { 'X-Dev-Key': fx.keys.alpha } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const errors = [];
    ws.on('message', (raw) => { const d = JSON.parse(raw); if (d.event === 'error') errors.push(d.error); });
    ws.send(JSON.stringify({ event: 'message', content: 'c', to: BIG }));
    ws.send(JSON.stringify({ event: 'message', content: 'c', channel: 'code', meta: { blob: BIG } }));
    await new Promise((r) => setTimeout(r, 300));
    ws.close();
    assert.deepEqual(errors.sort(), ['invalid_to', 'meta_too_large']);

    await fx.bus.stop(); // writes state.json
    stopped = true;
    const size = fs.statSync(path.join(fx.home, 'data', 'state.json')).size;
    assert.ok(size < 60_000, `state.json stays small (${size} bytes)`);
  } finally { if (stopped) fs.rmSync(fx.home, { recursive: true, force: true }); else await fx.close(); }
});
