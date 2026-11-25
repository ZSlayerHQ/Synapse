// digest-store.mjs — persistent per-seat digest buffer (spec R2: completeness is a hard
// invariant — a server restart must not evaporate withheld messages).
//
// Flush atomicity: take() is a SYNCHRONOUS snapshot+clear — the
// entries are removed from the buffer and persisted in the same tick, BEFORE the caller's async
// send begins. A message classified 'digest' during that send lands in a fresh (now-empty)
// bucket and rides the NEXT digest; nothing is lost and nothing double-sends. Single-threaded
// Node makes the read+clear atomic by construction; the test suite pins it anyway.
//
// That "nothing double-sends" clause used to be false in one case, which is why it is now
// spelled out (2026-07-29): if the post-clear persist() failed, the bucket was cleared in
// memory while the FILE still held the entries, so a restart reloaded and flushed them a
// second time. take() now rolls the clear back and returns [] when the delete is not durable,
// deferring the digest to the next sweep. Duplication was the safer failure direction, but the
// header claimed an invariant the code did not hold, which is the same shape as the two other
// false comments found the same night.
//
// Buckets are keyed per exact SEAT (project|seat) — twin sessions of one base bot each hold
// their own buffer, matching per-connection delivery.

import fs from 'fs';

const ENTRY_CONTENT_CAP = 300; // digest lines cap at 160 anyway; store a bounded excerpt only
// Bounded per project: at most SEATS_PER_PROJECT seat buckets (a new seat name evicts the project's oldest bucket) and
// BUCKET_MAX entries in each (the oldest go). One project's seats never evict another project's bucket.
export const SEATS_PER_PROJECT = 100;
export const BUCKET_MAX = 100;

// `phase` (diagnostics logs plan rev 3): an optional marker, (name, fn) => fn(), that labels each persistence step so a
// main-thread stall names the exact one. It returns fn's result or throws fn's error unchanged.
export function openDigestStore({ file, phase = (name, fn) => fn() }) {
  let data = Object.create(null);
  // Distinguish MISSING from CORRUPT. These were one silent path: any failure fell
  // into `catch { /* fresh store */ }`, so a corrupt store was indistinguishable
  // from a first run and every withheld message vanished with no signal. A missing
  // file is normal; an unparseable one is an incident, and the bytes are preserved
  // rather than overwritten by the next persist().
  if (fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (loaded && typeof loaded === 'object') data = Object.assign(Object.create(null), loaded);
    } catch (e) {
      const quarantine = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, quarantine); } catch { /* best effort */ }
      console.error(`[digest-store] CORRUPT store at ${file}: ${e.message}`);
      console.error(`[digest-store] preserved as ${quarantine}; starting empty. Withheld messages in it are NOT lost, but are not being delivered either.`);
    }
  }

  // Atomic write: temp + rename, so an interrupted write can never truncate the only
  // durable copy. Same pattern as saveState() in server.js ("Atomic write, security
  // fix M4") — this file simply never adopted it. On failure the PREVIOUS file
  // survives intact, so a bad write costs at most the newest entry rather than the
  // whole buffer.
  let lastPersistError = null;
  const persist = () => {
    const tmp = `${file}.tmp`;
    try {
      const body = phase('digest-serialize', () => JSON.stringify(data));
      phase('digest-write', () => fs.writeFileSync(tmp, body));
      phase('digest-rename', () => fs.renameSync(tmp, file));
      lastPersistError = null;
      return true;
    } catch (e) {
      lastPersistError = e.message;
      phase('digest-cleanup', () => { try { fs.unlinkSync(tmp); } catch { /* best effort */ } });
      // Loud and distinctly labelled: the buffer is still in memory, but it is NOT
      // durable, so a restart from here loses it. Callers on the delivery path do
      // not check a return value, so the log is the signal.
      console.error(`[digest-store] NOT DURABLE — persist failed: ${e.message}. Buffer held in memory only; a restart will lose it.`);
      return false;
    }
  };
  const key = (project, seat) => `${project}|${seat}`;
  // Adds entries to one bucket in memory, within the caps; returns whether anything changed. The caller persists once.
  function add(project, seat, entries) {
    const k = key(project, seat);
    if (!Array.isArray(data[k])) {
      const mine = Object.keys(data).filter((x) => x.startsWith(`${project}|`));
      for (const old of mine.slice(0, Math.max(0, mine.length - SEATS_PER_PROJECT + 1))) delete data[old];
      data[k] = [];
    }
    const bucket = data[k];
    let changed = false;
    for (const entry of entries) {
      // Idempotent by message id (#485): a replay-routed entry must not duplicate one the dying
      // process already buffered in a restart window — same id lands in the digest exactly once.
      if (entry.id && bucket.some((e) => e.id === entry.id)) continue;
      bucket.push({ ...entry, content: String(entry.content || '').slice(0, ENTRY_CONTENT_CAP) });
      changed = true;
    }
    if (bucket.length > BUCKET_MAX) bucket.splice(0, bucket.length - BUCKET_MAX);
    return changed;
  }
  return {
    push(project, seat, entry) {
      // Already buffered: state unchanged, so it is durable by definition.
      if (!add(project, seat, [entry])) return true;
      return persist(); // true = durable on disk, false = memory only (logged loudly)
    },
    // Many entries for one seat with ONE write of the store (a replay withholds up to a page at once).
    pushMany(project, seat, entries) {
      if (!entries.length || !add(project, seat, entries)) return true;
      return persist();
    },
    // Synchronous snapshot + clear (see header). Returns the snapshot, or an empty
    // array if the clear could not be made durable.
    take(project, seat) {
      const k = key(project, seat);
      const out = data[k] || [];
      if (!out.length) return out;
      delete data[k];
      if (!persist()) {
        // The DELETE is not durable, so the file still holds these entries and a
        // restart would reload and flush them again. Handing them to the caller now
        // would therefore send twice. Roll the clear back and report nothing pending:
        // the sweep retries on the next tick. Delayed beats duplicated, and this is
        // what makes the header's "nothing double-sends" actually true rather than
        // aspirational.
        data[k] = out;
        console.error(`[digest-store] take DEFERRED for ${k}: clear not durable, ${out.length} entr${out.length === 1 ? 'y' : 'ies'} held for the next sweep.`);
        return [];
      }
      return out;
    },
    // Non-mutating snapshot for the peek→send→ack flush flow (#494): the caller sends
    // FIRST and acks only after the digest has a durable home, so a failed send can no
    // longer strand entries that were already cleared.
    peek(project, seat) {
      return (data[key(project, seat)] || []).slice();
    },
    // Durable clear of exactly `count` entries from the FRONT of the bucket — the ones a
    // prior peek() returned. Safe as a count-prefix because the flush path is fully
    // synchronous (peek → sendDirect → ack in one tick; pushes only append), so the
    // peeked entries are still the head of the bucket at ack time. Entries pushed after
    // the peek stay buffered and ride the next digest. On a failed persist the bucket is
    // rolled back and false is returned: the send already happened, so the next sweep
    // may repeat the digest — duplicate beats lost, the inverse trade from take(), and
    // logged loudly either way.
    ack(project, seat, count) {
      const k = key(project, seat);
      const bucket = data[k] || [];
      if (!count || !bucket.length) return true;
      const removed = bucket.splice(0, Math.min(count, bucket.length));
      if (!bucket.length) delete data[k];
      if (!persist()) {
        data[k] = removed.concat(data[k] || []);
        console.error(`[digest-store] ack DEFERRED for ${k}: clear not durable, ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} held; the sent digest may repeat next sweep (duplicate beats lost).`);
        return false;
      }
      return true;
    },
    // Durability introspection, so "did the buffer actually persist" is answerable
    // rather than only greppable in stderr. Null when the last write succeeded.
    persistError() {
      return lastPersistError;
    },
    size(project, seat) {
      return (data[key(project, seat)] || []).length;
    },
    oldestTs(project, seat) {
      const a = data[key(project, seat)];
      return a && a.length ? a[0].timestamp : null;
    },
    pending() {
      return Object.entries(data)
        .filter(([, v]) => Array.isArray(v) && v.length)
        .map(([k]) => {
          const i = k.indexOf('|');
          return { project: k.slice(0, i), seat: k.slice(i + 1) };
        });
    },
  };
}
