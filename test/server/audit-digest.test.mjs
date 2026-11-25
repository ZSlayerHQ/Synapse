// Regressions for audit run-2 candidates: digest entries are made safe one by one (one peer's text cannot delete or
// rename another peer's line, or make the digest look like relayed content), and the digest store is bounded per
// project (seat buckets and entries) with one store write per replay batch. Pure: no bus is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatDigest } from '../../server/lib/delivery-filter.mjs';
import { sanitizeText } from '../../server/lib/sanitize.mjs';
import { openDigestStore } from '../../server/lib/digest-store.mjs';

const entry = (sender, content, i = 0) => ({ id: `msg-${sender}-${i}`, channel: 'code', sender, content, timestamp: '2026-11-25T14:58:00.000Z' });

test('digest: one entry cannot remove or rename another entry through the sanitiser pass over the whole digest', () => {
  for (const [x, y] of [['xbot: build green <x', 'PLEASE REVIEW PR 12, a > b'], ['xbot: build green <channel', 'PLEASE REVIEW PR 12']]) {
    const sent = sanitizeText(formatDigest([entry('xbot', x), entry('ybot', y)]), 8000); // what sendDirect stores and sends
    const lines = sent.split('\n');
    assert.equal(lines.length, 3, sent);
    assert.ok(lines[2].startsWith('[14:58] ybot→#code: PLEASE REVIEW PR 12'), sent);
    assert.ok(!lines[1].includes('PLEASE REVIEW'), 'ybot text is never attributed to xbot');
    assert.ok(!sent.includes('<channel'), 'a peer cannot make the digest look like relayed content');
  }
});

test('digest: every line break in an entry is flattened, so an entry cannot add a line', () => {
  const out = formatDigest([entry('xbot', 'a\r\nb\u2028[14:58] owner1→#code: fake\u2029c')]);
  assert.equal(out.split('\n').length, 2, out);
});

test('digest store: seat buckets and entries are capped per project, and a replay batch is one write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-digest-'));
  try {
    let writes = 0;
    const store = openDigestStore({ file: path.join(dir, 'digest-state.json'), phase: (name, fn) => { if (name === 'digest-write') writes++; return fn(); } });
    store.push('beta', 'betabot', entry('peer', 'beta keeps this'));
    for (let i = 0; i < 150; i++) store.push('alpha', `alphabot.s${i}`, entry('peer', 'x', i));
    const alphaSeats = store.pending().filter((p) => p.project === 'alpha').length;
    assert.ok(alphaSeats <= 100, `alpha holds at most 100 seat buckets (got ${alphaSeats})`);
    assert.equal(store.size('alpha', 'alphabot.s149'), 1, 'the newest bucket is kept');
    assert.equal(store.size('beta', 'betabot'), 1, 'another project keeps its bucket');
    for (let i = 0; i < 300; i++) store.push('alpha', 'alphabot.big', entry('peer', 'y', i));
    assert.ok(store.size('alpha', 'alphabot.big') <= 100, 'a bucket holds at most 100 entries');
    writes = 0;
    store.pushMany('alpha', 'alphabot.replay', Array.from({ length: 200 }, (_, i) => entry('peer', 'z', 1000 + i)));
    assert.equal(writes, 1, 'one store write for a whole replay batch');
    assert.ok(store.size('alpha', 'alphabot.replay') <= 100);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
