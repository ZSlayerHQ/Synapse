// client/replay.js
//
// Replay-on-reconnect for the Synapse MCP client.
//
// The bus is fire-and-forget: a message published while a client's WebSocket is down (the 3-5 s reconnect
// window, a proxy idle-kill, a laptop sleep) reaches no one and is never resent. This module closes that
// hole. On reconnect the client asks the server for everything after its last-seen cursor; the server
// (GET /api/messages) either replays the gap oldest-first or, when the gap is too large to reconstruct
// (missing / too-old / evicted-from-ring), returns an observable resync_required so the client jumps to
// head and says so, rather than silently losing a window or replaying from zero.
//
// Pure module: no side effects on import, no transport coupling. The caller injects `deliver` (feed one
// message into the session) and `notice` (surface a one-line gap warning), so the logic is unit-testable
// against a throwaway server with collecting callbacks. index.js wires the production callbacks.

// 'msg-123' -> 123; '' / null / undefined / non-numeric -> null. Strict (digits-only after the prefix) so a
// garbage cursor resolves to null and triggers an observable resync instead of a silent wrong-point replay.
// The server parses cursors the same way: the cursor unit must parse identically on both ends.
export function numericId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).replace(/^msg-/, '');
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// Bounded, insertion-ordered id set for idempotent injection. The reconnect replay and the live socket can
// both deliver the same message id in the window where a live message lands while the replay HTTP request
// is in flight; checking this set before injecting makes that overlap a no-op (zero double-injection) and
// also defends against any server-side double-send. Bounded so a long-lived session can't grow it without
// limit; eviction is oldest-first (Set preserves insertion order), safe because ids only ever move forward.
export function createSeenSet(max = 1000) {
  const ids = new Set();
  return {
    has: (id) => ids.has(id),
    mark: (id) => {
      if (id == null) return;
      ids.add(id);
      if (ids.size > max) ids.delete(ids.values().next().value);
    },
    // A message whose channel notification failed is forgotten, so a later replay can still inject it.
    forget: (id) => { ids.delete(id); },
    get size() { return ids.size; },
  };
}

// Fetch + apply the post-cursor gap on reconnect. Returns the cursor the client should hold going forward
// (advanced to head on success/resync, left unchanged on a transient failure so the next reconnect retries).
// Never throws: a reconnect handler must not be taken down by a flaky catch-up fetch.
//
//   httpUrl   base URL of the Synapse server (no trailing /api)
//   project   project id for the X-Dev-Project header (null => the server's default project)
//   key       X-Dev-Key for this project
//   developer this seat's name; the server scopes replayed DMs to it (servers fail closed and replay no
//             DMs at all when this is absent)
//   sinceId   last-seen cursor ('msg-<n>' string) or null when the socket dropped before any message
//   deliver   async (msg) => void: inject one replayed message into the session
//   notice    async (text) => void: surface a one-line gap warning
//   fetchImpl test seam; defaults to global fetch
export async function replayOnReconnect({ httpUrl, project, key, developer, sinceId, deliver, notice, fetchImpl }) {
  const doFetch = fetchImpl || fetch;

  // A reconnect with a cursor replays strictly after it. A reconnect with no cursor yet (socket dropped
  // before any message was seen) sends replay=1 so the server returns an observable resync-to-head rather
  // than us silently assuming nothing was missed.
  const qs = new URLSearchParams();
  if (sinceId != null) qs.set('since_id', String(sinceId));
  else qs.set('replay', '1');
  if (developer) qs.set('developer', String(developer));

  let res;
  try {
    res = await doFetch(`${httpUrl}/api/messages?${qs.toString()}`, {
      headers: { 'X-Dev-Key': key || '', ...(project ? { 'X-Dev-Project': project } : {}) },
    });
  } catch {
    return sinceId; // transient (server down mid-reconnect); hold the cursor, the next reconnect retries.
  }

  let data;
  try { data = await res.json(); } catch { return sinceId; }

  if (data && data.resync_required) {
    // Warn whenever we held a real cursor that the server rejected as too-old / missing / evicted: that is a
    // genuine missed window, including the case where this project's whole retained slice was evicted by a busy
    // sibling project (head_id null). The notice is not gated on head_id: a null head means everything was lost,
    // which is exactly the gap that must stay observable. The one case suppressed is a null prior cursor (no
    // message seen yet): it cannot be told apart from messages that predate this session, so seeding to head
    // silently avoids a false alarm. Cursor: advance to head when the server reports one; otherwise hold sinceId.
    if (sinceId != null && typeof notice === 'function') {
      await notice(`Reconnected after a gap too large to replay (${data.reason}). Some messages sent while you were disconnected were not re-delivered. Run dev_msg_history to backfill if you need them.`);
    }
    return data.head_id != null ? data.head_id : sinceId;
  }

  const messages = Array.isArray(data && data.messages) ? data.messages : [];
  let cursor = sinceId;
  for (const m of messages) {
    if (typeof deliver === 'function') await deliver(m);
    if (m && m.id != null) cursor = m.id;
  }
  // Prefer the server's reported head so an empty (already-caught-up) replay still advances the cursor.
  if (data && data.cursor != null) cursor = data.cursor;
  return cursor;
}
