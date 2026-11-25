// dev-sync/ask-store.mjs
//
// Synapse ask-bridge durable store (#388). Lets an operator answer a bot's AskUserQuestion
// prompts from the dashboard / Discord instead of the terminal. The bot's session PARKS the
// question; the operator ANSWERS it; the session RESUMES with the validated selection.
//
// Security model (what actually gates each transition TODAY vs what is RESERVED):
//   - tool_use_id is an OBSERVABLE harness CORRELATION id (it appears in bus payloads), so it is
//     NOT a secret. It is the public handle every caller uses to address a parked question.
//   - Replay / single-use is enforced TODAY by the STATUS STATE-MACHINE plus PROJECT SCOPE, NOT by
//     a nonce. The status column walks pending -> answered -> consumed via guarded UPDATEs whose
//     WHERE clause asserts the expected prior status; a second answer() or claimForResume() flips
//     zero rows and throws. project scope keeps a foreign project from touching another project's
//     row. answer() takes no nonce parameter on purpose, and claimForResume() does not "consume" a
//     nonce — it advances the status state-machine.
//   - The server-minted `nonce` stays PURELY SERVER-INTERNAL (signed-off decision I3, 2026-06-07: the
//     nonce never leaves the server, full stop). It is minted on park(), stored in the row, never
//     leaked to a park() caller, and returned by claimForResume() to the IN-PROCESS server module ONLY
//     (the HTTP layer strips it; the claim response is {selections, questions, answeredBy}). Resume-authz is
//     the project-key scope wall plus the status state-machine, NOT the nonce. The nonce is currently
//     UNUSED by any transit path; a future phase that wants to use it must RE-OPEN I3 first. Never read
//     it as an enforced gate, and never carry it across a process boundary.
//   - OPERATOR AUTHZ is enforced at the HTTP endpoint layer (the /api/ask/* routes in server.js), NOT
//     in this module.
//
// Mirrors dev-sync/files-store.js: node:sqlite DatabaseSync, WAL, prepared statements, a factory
// that returns an object of methods. `:memory:` for tests; a real file path for production durability.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

// Lifecycle: pending --answer()--> answered --claimForResume()--> consumed.
const STATUS_PENDING = 'pending';
const STATUS_ANSWERED = 'answered';
const STATUS_CONSUMED = 'consumed';
const TRUNCATED = ' [truncated]';

// Safe JSON parse for stored columns. A raw SyntaxError must never escape the store API — wrap it in
// a domain error naming the toolUseId so corruption is attributable to a specific parked row.
function parseStored(json, toolUseId) {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`ask-store: corrupt stored data for '${toolUseId}'`);
  }
}

// Security spine [A] of the ask-bridge (#388). The bus carries only a SELECTION (question text ->
// chosen labels); this gate asserts each selected label was ACTUALLY OFFERED by the SERVER-stored
// question, then produces the `answers` map. Called by the /api/ask/answer endpoint (reject a bad
// selection at write time) and by the resume hook (reconstruct tool input from server questions, never
// from the bus). Pure + deterministic: no DB, no I/O, no logging. Throws never leak a nonce/secret —
// only the offending label + question text, which are already public.
//
//   questions  : [{ question, header, options: [{ label, description }], multiSelect }]
//   selections : { <question text>: [<chosen label>, ...] }
//   returns    : { <question text>: "<comma-joined offered labels>" }
export function canonicalize(questions, selections) {
  const qs = Array.isArray(questions) ? questions : [];
  const sel = selections ?? {};
  const askedKeys = new Set(qs.map((q) => q?.question));
  const answers = {};

  // Foreign-key guard FIRST. A selection key that matches no asked question is an answer to a question
  // that was never asked. Runs before per-question processing so a foreign key is rejected as the
  // proximate cause even when an asked question is also (separately) unanswered. Uses
  // Object.prototype.hasOwnProperty.call so a question text of 'toString'/'constructor'/'__proto__'
  // is judged on OWN keys only, never the prototype chain.
  for (const key of Object.keys(sel)) {
    if (!askedKeys.has(key)) {
      throw new Error(`canonicalize: '${key}' is not an offered option (no such question was asked)`);
    }
  }

  for (const q of qs) {
    const text = q?.question;
    const hasSel = Object.prototype.hasOwnProperty.call(sel, text);
    const chosen = hasSel ? sel[text] : undefined;
    const labels = !hasSel ? [] : Array.isArray(chosen) ? chosen : [chosen];

    // Cardinality enforcement (the #388 security fix). Every asked question must be answered with at
    // least one label; a single-select question accepts EXACTLY one.
    if (labels.length === 0) {
      throw new Error(`canonicalize: question '${text}' must be answered (at least one label required)`);
    }
    if (q?.multiSelect !== true && labels.length > 1) {
      throw new Error(`canonicalize: question '${text}' is single-select but ${labels.length} labels were selected`);
    }

    const offered = new Set((q?.options ?? []).map((o) => o?.label));
    for (const label of labels) {
      if (!offered.has(label)) {
        throw new Error(`canonicalize: '${label}' is not an offered option for question '${text}'`);
      }
    }
    answers[text] = labels.join(', ');
  }

  return answers;
}

export function openAskStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ask_parks (
      tool_use_id     TEXT PRIMARY KEY,
      session_id      TEXT,
      project         TEXT,
      questions_json  TEXT,
      nonce           TEXT NOT NULL,
      selections_json TEXT,
      status          TEXT NOT NULL CHECK (status IN ('pending','answered','consumed')),
      created_at      TEXT NOT NULL,
      answered_at     TEXT,
      consumed_at     TEXT
    )`);
  // Migration (2026-07-22, decisions-mirror fix): refs_json holds the posted card refs
  // [{channelId, messageId, via, webhookId?, textBase? or embedBase?}] so the answer-time cross-edit survives a :4100
  // restart. Pre-migration databases lack the column; ADD COLUMN is additive and leaves rows intact.
  const columns = db.prepare('PRAGMA table_info(ask_parks)').all().map((c) => c.name);
  if (!columns.includes('refs_json')) {
    db.exec('ALTER TABLE ask_parks ADD COLUMN refs_json TEXT');
  }
  // Migration: answered_by holds the
  // name of the operator whose tap answered the card, so the asking session is told who decided. Additive like refs_json;
  // a row answered before the column existed keeps NULL and is delivered with today's text.
  if (!columns.includes('answered_by')) {
    db.exec('ALTER TABLE ask_parks ADD COLUMN answered_by TEXT');
  }
  // Migration (2026-11-08, Other-button reply wait; vault plan docs/plans/2026-11-08-other-button-reply-plan.md rev 4).
  // reply_wait_until: the deadline while a wait is open (UTC ISO, compared as text), NULL otherwise. reply_channel_id and
  // reply_operator: set at arm, never cleared. reply_msg_id: the Discord id of the reply that took the wait. reply_text: the
  // asker's copy of that reply, kept for the reconnect claim while undelivered. reply_prompt_json: the posted prompt's edit
  // target and failed-edit count. All nullable, so old rows keep their lifecycle.
  for (const col of ['reply_wait_until', 'reply_channel_id', 'reply_operator', 'reply_msg_id', 'reply_text', 'reply_prompt_json']) {
    if (!columns.includes(col)) db.exec(`ALTER TABLE ask_parks ADD COLUMN ${col} TEXT`);
  }
  // Migration (2026-11-17, vault plan docs/plans/2026-11-17-ask-cards-expire-after-24h-plan.md): reopened_as holds the askId of
  // the card parked when someone pressed `Answer N` on the notice for a card that expired. Nullable and additive like the rest;
  // set together with that card's park in one transaction (reopenWithPark), so a second press finds it set and parks nothing.
  if (!columns.includes('reopened_as')) db.exec('ALTER TABLE ask_parks ADD COLUMN reopened_as TEXT');
  // Migration (2026-11-17, the same plan, fix round 1 finding 1): the expiry close's outstanding work, kept on the row so a restart
  // or a failed notice loses none of it. expiry_state: 'owed' from the close until the notice that lists the card has posted;
  // 'listed' when it has posted but a stored copy is not closed yet (fix round 2); 'done' once both hold, or after the sweep's last
  // try at the copies; 'failed' after EXPIRY_MAX_TRIES notices that did not post. expiry_tries counts the notices that did not post
  // while 'owed', and the passes whose copies did not all close while 'listed'. Both NULL on every row the sweep never closed, so an
  // older bus reads and writes the table as before.
  if (!columns.includes('expiry_state')) db.exec('ALTER TABLE ask_parks ADD COLUMN expiry_state TEXT');
  if (!columns.includes('expiry_tries')) db.exec('ALTER TABLE ask_parks ADD COLUMN expiry_tries INTEGER');
  // Fix round 3 (finding 4): the generation of the row's latest notice attempt, raised by claimNoticeAttempt as each attempt starts.
  // A notice result moves the row only when it carries the row's current generation, so an attempt that was let go and settles
  // later never moves a newer attempt's row. NULL on every row no notice was attempted for.
  if (!columns.includes('expiry_gen')) db.exec('ALTER TABLE ask_parks ADD COLUMN expiry_gen INTEGER');
  // Fix round 4 (finding 1): when a reopened card's answer was posted in the project's code channel because its seat was gone. Kept on
  // the row, so a retry never posts it again, whatever the bus's 200-message history still holds. NULL until then.
  if (!columns.includes('channel_answer_at')) db.exec('ALTER TABLE ask_parks ADD COLUMN channel_answer_at TEXT');

  const insertStmt = db.prepare(
    `INSERT INTO ask_parks (tool_use_id, session_id, project, questions_json, nonce, selections_json, status, created_at, answered_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)`,
  );
  const selectStmt = db.prepare('SELECT * FROM ask_parks WHERE tool_use_id = ?');
  // Atomic single-shot answer: the status='pending' guard means a concurrent second answer (or an
  // answer racing a consume) flips zero rows on the loser (changes === 0). Single-use is enforced at
  // the DB write, not just by a prior read.
  const answerStmt = db.prepare(
    `UPDATE ask_parks SET selections_json = ?, status = ?, answered_at = ?, answered_by = ? WHERE tool_use_id = ? AND project = ? AND status = ?`,
  );
  // Atomic single-shot consume: the status='answered' guard in the WHERE clause means a concurrent
  // second claim cannot also flip an already-consumed row (changes === 0 on the loser). This is the
  // replay kill switch, enforced at the DB write, not just by a prior read.
  // reply_text (an Other reply's saved copy) is cleared on consume: the store keeps no human message text it no longer
  // needs. Every caller that delivers it reads it before this UPDATE.
  const consumeStmt = db.prepare(
    `UPDATE ask_parks SET status = ?, consumed_at = ?, reply_text = NULL WHERE tool_use_id = ? AND project = ? AND status = ?`,
  );

  // For the fleet card: newest first, so the limit keeps what can still be live, and only what a row shows.
  const pendingStmt = db.prepare(
    `SELECT tool_use_id, session_id, project, created_at, refs_json FROM ask_parks WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`,
  );
  const pendingCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM ask_parks WHERE status = 'pending'`);
  const listPending = (limit) => ({ rows: pendingStmt.all(limit), total: pendingCountStmt.get().n });
  // The open cards for the dashboard: pending rows with their stored questions, newest first. A row whose stored
  // questions do not parse is skipped rather than failing the list.
  const openStmt = db.prepare(
    `SELECT tool_use_id, session_id, project, created_at, questions_json FROM ask_parks WHERE status = 'pending' AND project = ? ORDER BY created_at DESC LIMIT ?`,
  );
  // Per project, so a busy project can never push another project's open cards past the limit.
  function listOpen(projects, limit = 100) {
    const out = [];
    const rows = [].concat(...[...new Set(projects)].map((p) => openStmt.all(String(p), Number(limit))));
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    for (const row of rows) {
      let questions;
      try { questions = JSON.parse(row.questions_json); } catch { continue; }
      out.push({ askId: row.tool_use_id, project: row.project, seat: row.session_id, createdAt: row.created_at, questions });
    }
    return out;
  }

  // ─── Cards nobody answers (vault plan docs/plans/2026-11-17-ask-cards-expire-after-24h-plan.md) ───
  // The sweep's selection: pending cards created at or before the cutoff, oldest first. A card is a row with at least one stored
  // Discord copy (refs_json a non-empty array), whatever its id looks like: only a posted dev_ask card has one, and a hook park
  // (AskUserQuestion, POST /api/ask/question) has none, so it is never closed with a label it did not offer. A refs_json that is
  // not valid JSON counts as no copy (the CASE keeps json_array_length from ever reading it). The rows are returned as stored; the
  // sweep reads each one's question itself, so one corrupt row cannot hide the others.
  const expirableStmt = db.prepare(
    `SELECT tool_use_id, session_id, project, questions_json, created_at FROM ask_parks
       WHERE status = 'pending' AND created_at <= ?
         AND (CASE WHEN refs_json IS NOT NULL AND json_valid(refs_json) AND json_type(refs_json) = 'array' THEN json_array_length(refs_json) ELSE 0 END) > 0
       ORDER BY created_at ASC LIMIT ?`,
  );
  function listExpirable(cutoffIso, limit) {
    return expirableStmt.all(String(cutoffIso), Number(limit)).map((row) => ({
      askId: row.tool_use_id, project: row.project, seat: row.session_id, createdAt: row.created_at, questionsJson: row.questions_json,
    }));
  }
  // The expiry close: ONE guarded UPDATE (status='pending', so a tap that got there first wins and this flips nothing) that writes
  // the selection, the status, who answered and the outstanding work (expiry_state 'owed') together. `consume` (a card past the
  // sweep's consume age) writes 'consumed' at once, so no line ever reaches its long-gone session. Throws only on a store error;
  // closed:false is a card that was no longer pending.
  const expireStmt = db.prepare(
    `UPDATE ask_parks SET selections_json = ?, status = ?, answered_at = ?, answered_by = ?, consumed_at = ?, expiry_state = 'owed', expiry_tries = 0
       WHERE tool_use_id = ? AND project = ? AND status = 'pending'`,
  );
  function expireIfPending({ toolUseId, project, selections, answeredBy, consume = false }) {
    const at = new Date().toISOString();
    const res = expireStmt.run(JSON.stringify(selections ?? {}), consume ? STATUS_CONSUMED : STATUS_ANSWERED, at, String(answeredBy), consume ? at : null, String(toolUseId), String(project));
    return { closed: res.changes > 0 };
  }
  // The closes with work still owed, oldest first (each pass takes these before closing anything new): a notice ('owed') or a copy
  // to close ('listed'). `state` says which.
  const owedStmt = db.prepare(
    `SELECT tool_use_id, session_id, project, questions_json, created_at, status, expiry_tries, expiry_state FROM ask_parks
       WHERE expiry_state IN ('owed', 'listed') ORDER BY created_at ASC LIMIT ?`,
  );
  function listExpiryOwed(limit) {
    return owedStmt.all(Number(limit)).map((row) => ({
      askId: row.tool_use_id, project: row.project, seat: row.session_id, createdAt: row.created_at, questionsJson: row.questions_json,
      status: row.status, tries: Number(row.expiry_tries) || 0, state: row.expiry_state,
    }));
  }
  // A notice attempt for the row starts: its generation goes up, only while the row is still owed (the attempt's re-read of the
  // row, fix round 3). -> the attempt's generation, or null when the row is no longer owed (no notice may be posted for it).
  const noticeAttemptStmt = db.prepare(
    `UPDATE ask_parks SET expiry_gen = COALESCE(expiry_gen, 0) + 1 WHERE tool_use_id = ? AND project = ? AND expiry_state = 'owed' RETURNING expiry_gen`,
  );
  function claimNoticeAttempt(askId, project) {
    const row = noticeAttemptStmt.get(String(askId), String(project));
    return row ? Number(row.expiry_gen) : null;
  }
  // `gen` (a notice attempt's generation) on the three writes a notice's result makes: the row moves only while that attempt is its
  // latest. null (a copy pass, which no notice attempt owns) checks nothing.
  const GEN = '(? IS NULL OR expiry_gen = ?)';
  const genArgs = (gen) => (gen === null || gen === undefined ? [null, null] : [Number(gen), Number(gen)]);
  // The notice listing the card has posted and its copies are closed (or the sweep's tries at them are used up): owed or listed ->
  // done, once.
  const expiryDoneStmt = db.prepare(`UPDATE ask_parks SET expiry_state = 'done' WHERE tool_use_id = ? AND project = ? AND expiry_state IN ('owed', 'listed') AND ${GEN}`);
  function markExpiryDone(askId, project, gen = null) {
    return { done: expiryDoneStmt.run(String(askId), String(project), ...genArgs(gen)).changes > 0 };
  }
  // The notice listing the card has posted but a copy is not closed: owed -> listed, its tries starting at `tries` (1 when this pass's
  // edit already failed, 0 when the copies are checked on the next pass).
  const expiryListedStmt = db.prepare(`UPDATE ask_parks SET expiry_state = 'listed', expiry_tries = ? WHERE tool_use_id = ? AND project = ? AND expiry_state = 'owed' AND ${GEN}`);
  function markExpiryListed(askId, project, tries = 1, gen = null) {
    return { listed: expiryListedStmt.run(Number(tries), String(askId), String(project), ...genArgs(gen)).changes > 0 };
  }
  // One more pass whose copies did not all close: the count goes up, and at `max` the row becomes 'done' anyway (the caller logs which
  // copies). tries:null when the row was not listed.
  const copyTryStmt = db.prepare(
    `UPDATE ask_parks SET expiry_tries = COALESCE(expiry_tries, 0) + 1,
       expiry_state = CASE WHEN COALESCE(expiry_tries, 0) + 1 >= ? THEN 'done' ELSE 'listed' END
       WHERE tool_use_id = ? AND project = ? AND expiry_state = 'listed' RETURNING expiry_tries, expiry_state`,
  );
  function noteCopyTry(askId, project, max) {
    const row = copyTryStmt.get(Number(max), String(askId), String(project));
    return row ? { tries: Number(row.expiry_tries), done: row.expiry_state === 'done' } : { tries: null, done: false };
  }
  // A reopened card's answer was posted in the code channel (fix round 4): recorded once, the first time. -> whether it was recorded now.
  const channelAnswerMarkStmt = db.prepare('UPDATE ask_parks SET channel_answer_at = ? WHERE tool_use_id = ? AND project = ? AND channel_answer_at IS NULL');
  function markChannelAnswerPosted(askId, project) {
    return { marked: channelAnswerMarkStmt.run(new Date().toISOString(), String(askId), String(project)).changes > 0 };
  }
  // When it was posted, or null when it never was (or there is no such row).
  const channelAnswerStmt = db.prepare('SELECT channel_answer_at FROM ask_parks WHERE tool_use_id = ?');
  function channelAnswerPostedAt(askId) {
    const row = channelAnswerStmt.get(String(askId));
    return row && row.channel_answer_at ? row.channel_answer_at : null;
  }
  // The row's expiry_state (null for a row the sweep never closed, or none).
  const expiryStateStmt = db.prepare('SELECT expiry_state FROM ask_parks WHERE tool_use_id = ?');
  function expiryStateOf(askId) {
    const row = expiryStateStmt.get(String(askId));
    return row && row.expiry_state ? row.expiry_state : null;
  }
  // A replacement card (some row's reopened_as) still pending with no stored copy, created at or before the cutoff, oldest first: its
  // post never landed (fix round 2, N5). The sweep closes these in the store without a notice.
  const copylessStmt = db.prepare(
    `SELECT tool_use_id, session_id, project, questions_json, created_at FROM ask_parks
       WHERE status = 'pending' AND created_at <= ?
         AND (CASE WHEN refs_json IS NOT NULL AND json_valid(refs_json) AND json_type(refs_json) = 'array' THEN json_array_length(refs_json) ELSE 0 END) = 0
         AND tool_use_id IN (SELECT reopened_as FROM ask_parks WHERE reopened_as IS NOT NULL)
       ORDER BY created_at ASC LIMIT ?`,
  );
  function listCopylessReplacements(cutoffIso, limit) {
    return copylessStmt.all(String(cutoffIso), Number(limit)).map((row) => ({
      askId: row.tool_use_id, project: row.project, seat: row.session_id, createdAt: row.created_at, questionsJson: row.questions_json,
    }));
  }
  // Its close: one guarded UPDATE, only while it is still pending with no stored copy, straight to consumed with the expiry label and
  // nothing owed (no notice, no seat line).
  const closeCopylessStmt = db.prepare(
    `UPDATE ask_parks SET selections_json = ?, status = ?, answered_at = ?, answered_by = ?, consumed_at = ?, expiry_state = 'done', expiry_tries = 0
       WHERE tool_use_id = ? AND project = ? AND status = 'pending'
         AND (CASE WHEN refs_json IS NOT NULL AND json_valid(refs_json) AND json_type(refs_json) = 'array' THEN json_array_length(refs_json) ELSE 0 END) = 0`,
  );
  function closeCopylessReplacement({ toolUseId, project, selections, answeredBy }) {
    const at = new Date().toISOString();
    return { closed: closeCopylessStmt.run(JSON.stringify(selections ?? {}), STATUS_CONSUMED, at, String(answeredBy), at, String(toolUseId), String(project)).changes > 0 };
  }
  // One notice that did not post: the count goes up, and at `max` the row becomes 'failed' (the caller logs that once: the
  // question was never listed). One guarded UPDATE; tries:null when the row was no longer owed.
  const expiryTryStmt = db.prepare(
    `UPDATE ask_parks SET expiry_tries = COALESCE(expiry_tries, 0) + 1,
       expiry_state = CASE WHEN COALESCE(expiry_tries, 0) + 1 >= ? THEN 'failed' ELSE 'owed' END
       WHERE tool_use_id = ? AND project = ? AND expiry_state = 'owed' AND ${GEN} RETURNING expiry_tries, expiry_state`,
  );
  function noteExpiryTry(askId, project, max, gen = null) {
    const row = expiryTryStmt.get(Number(max), String(askId), String(project), ...genArgs(gen));
    return row ? { tries: Number(row.expiry_tries), failed: row.expiry_state === 'failed' } : { tries: null, failed: false };
  }
  // Answer N on the notice: the new card's park and the old row's reopened_as, in one transaction, both or neither. The UPDATE
  // only matches a card the sweep closed (answered_by 'expiry') that has no reopened card yet, so two presses park one card.
  // reopened:false (nothing written) when it was already reopened, was not an expired card, or belongs to another project; a
  // store error rolls both back and throws.
  const reopenStmt = db.prepare(
    `UPDATE ask_parks SET reopened_as = ? WHERE tool_use_id = ? AND project = ? AND answered_by = 'expiry' AND status != 'pending' AND reopened_as IS NULL`,
  );
  function reopenWithPark(askId, project, { toolUseId, sessionId, questions }) {
    if (!toolUseId) throw new Error('ask-store: toolUseId is required on reopen');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (reopenStmt.run(String(toolUseId), String(askId), String(project)).changes === 0) { db.exec('ROLLBACK'); return { reopened: false }; }
      insertStmt.run(String(toolUseId), sessionId || null, String(project), JSON.stringify(questions ?? []), randomBytes(16).toString('hex'), STATUS_PENDING, new Date().toISOString());
      db.exec('COMMIT');
      return { reopened: true };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }
  // The expired card a reopened one came from (its askId), or null.
  const reopenedFromStmt = db.prepare('SELECT tool_use_id FROM ask_parks WHERE reopened_as = ? LIMIT 1');
  function reopenedFrom(askId) {
    const row = reopenedFromStmt.get(String(askId));
    return row ? row.tool_use_id : null;
  }
  // Whether an expired card was reopened (for the notice's disabled buttons): the new askId, or null.
  const reopenedAsStmt = db.prepare('SELECT reopened_as FROM ask_parks WHERE tool_use_id = ?');
  function reopenedAs(askId) {
    const row = reopenedAsStmt.get(String(askId));
    return row && row.reopened_as ? row.reopened_as : null;
  }

  // Park a question set. Mints a 32-hex server-side nonce (the reserved resume capability) stored in
  // the row but NEVER returned to the park() caller. Returns ONLY { questionId: toolUseId } — the
  // public correlation handle.
  function park({ toolUseId, sessionId, project, questions }) {
    if (!toolUseId) throw new Error('ask-store: toolUseId is required on park');
    const nonce = randomBytes(16).toString('hex'); // server-minted; reserved resume capability
    const createdAt = new Date().toISOString();
    try {
      insertStmt.run(
        toolUseId,
        sessionId || null,
        project || null,
        JSON.stringify(questions ?? []),
        nonce,
        STATUS_PENDING,
        createdAt,
      );
    } catch (err) {
      // Duplicate park on the same tool_use_id trips the PRIMARY KEY UNIQUE constraint. Do not leak
      // the raw driver error — surface a domain error naming the toolUseId.
      if (/UNIQUE|constraint/i.test(String(err?.message))) {
        throw new Error(`ask-store: duplicate park for '${toolUseId}'`);
      }
      throw err;
    }
    return { questionId: toolUseId }; // NEVER include nonce
  }

  // Record the operator's selections. Scope-gated: a row from a different project (or a missing row)
  // throws a 'scope' error. Operator authz is enforced at the HTTP endpoint layer, NOT here, so there
  // is no nonce parameter. The guarded UPDATE (status='pending') makes the write atomic + single-shot:
  // two concurrent same-project answers cannot both land (the loser flips zero rows and throws).
  // `answeredBy` is the operator name the caller resolved (the card tap); absent or empty stores NULL.
  function answer({ toolUseId, project, selections, answeredBy }) {
    const row = selectStmt.get(toolUseId);
    if (!row || row.project !== project) {
      throw new Error(`scope: no parked question '${toolUseId}' for project '${project}'`);
    }
    const res = answerStmt.run(
      JSON.stringify(selections ?? {}),
      STATUS_ANSWERED,
      new Date().toISOString(),
      typeof answeredBy === 'string' && answeredBy ? answeredBy : null,
      toolUseId,
      project,
      STATUS_PENDING,
    );
    if (res.changes === 0) {
      // Not pending (already answered/consumed) or lost a concurrent answer race.
      throw new Error(`ask-store: question '${toolUseId}' is not pending (status=${row.status})`);
    }
    return { questionId: toolUseId, status: STATUS_ANSWERED };
  }

  // Advance an answered row to 'consumed' for resume, EXACTLY ONCE, and return the data the resume
  // step needs. Scope-gated to the project. Replay is killed by the STATUS STATE-MACHINE: the flip to
  // 'consumed' is atomic (status='answered' guard in the UPDATE), so a racing or repeat claim loses.
  // Returns { selections, questions, nonce, answeredBy } to the IN-PROCESS server module ONLY. The hook
  // reconstructs the tool input from the SERVER-stored `questions` (never from the bus). `nonce` is
  // server-internal, STRIPPED at the HTTP boundary (per I3 it never crosses a process boundary), and
  // currently UNUSED by any resume path; it is returned here only so the server module can read it.
  function claimForResume(toolUseId, project) {
    const row = selectStmt.get(toolUseId);
    if (!row || row.project !== project) {
      throw new Error(`scope: no parked question '${toolUseId}' for project '${project}'`);
    }
    if (row.status === STATUS_CONSUMED) {
      throw new Error(`consumed: question '${toolUseId}' was already claimed (replay rejected)`);
    }
    if (row.status !== STATUS_ANSWERED) {
      throw new Error(`ask-store: question '${toolUseId}' is not answered yet (status=${row.status})`);
    }
    const res = consumeStmt.run(STATUS_CONSUMED, new Date().toISOString(), toolUseId, project, STATUS_ANSWERED);
    if (res.changes === 0) {
      // Lost a concurrent race: another claim flipped it to 'consumed' between our read and write.
      throw new Error(`consumed: question '${toolUseId}' was already claimed (replay rejected)`);
    }
    return {
      selections: parseStored(row.selections_json, toolUseId),
      questions: parseStored(row.questions_json, toolUseId),
      nonce: row.nonce,
      answeredBy: row.answered_by || null, // who tapped (item L3); null for a row answered without a name
    };
  }

  // Select all answered-but-undelivered parks for a seat+project (the reconnect-claim source).
  // session_id holds the askingSeat for dev_ask parks (dispatch stores it there). Ordered oldest-first
  // so a batch of stranded answers reaches the reconnecting seat in the order they were answered.
  // An Other tap still waiting for its human's reply is skipped (its answer is the reply, not the bare tap), and so is a
  // reply taken but not yet saved (its message is still being downloaded and sent). NULL-safe, so every legacy row and
  // every row without a wait stays claimable. An expired wait is claimable; an unfinished reply left by a crash or a failed
  // save is finished by the sweep (listUnfinishedReplies) and then claimable. A card the expiry sweep closed is skipped while it has
  // work owed ('owed' or 'listed'): it is claimable once that work is done ('done') or the sweep gave up on its notice ('failed'),
  // and the claim marks a 'failed' row so its line says the notice could not be posted.
  // The answer outbox: answered rows for a seat stay 'answered' until that seat acknowledges it injected the answer
  // (ackAnswer). Listing never consumes, so a lost response or a socket that closed mid-send cannot lose an answer.
  const outboxStmt = db.prepare(
    `SELECT * FROM ask_parks WHERE session_id = ? AND project = ? AND status = 'answered' ORDER BY answered_at ASC LIMIT 100`,
  );
  function listAnsweredForSeat(seat, project) {
    if (!seat) return [];
    return outboxStmt.all(String(seat), String(project)).map((row) => ({ askId: row.tool_use_id, ...questionAndLabel(row) }));
  }
  const ackStmt = db.prepare(
    `UPDATE ask_parks SET status = 'consumed', consumed_at = ? WHERE tool_use_id = ? AND project = ? AND session_id = ? AND status = 'answered'`,
  );
  function ackAnswer(askId, project, seat) {
    return { acked: ackStmt.run(new Date().toISOString(), String(askId), String(project), String(seat)).changes > 0 };
  }
  const undeliveredForSeatStmt = db.prepare(
    `SELECT * FROM ask_parks WHERE session_id = ? AND project = ? AND status = ?
       AND (reply_wait_until IS NULL OR reply_wait_until <= ?)
       AND (reply_msg_id IS NULL OR reply_text IS NOT NULL)
       AND (expiry_state IS NULL OR expiry_state IN ('done', 'failed')) ORDER BY answered_at ASC`,
  );

  // S2 — mark a live-delivered answer as consumed. Atomic answered -> consumed via the same status='answered'
  // guard as claimForResume, so a delivered answer can never later be re-claimed by the reconnect path
  // (exactly-once). Fire-and-forget from deliverAnswerToSeat: NEVER throws — a no-op (row not answered, or a
  // lost race to a concurrent claim) simply returns delivered:false. Never advances a pending row (the guard
  // requires status='answered').
  function markAnswerDelivered(askId, project) {
    const res = consumeStmt.run(STATUS_CONSUMED, new Date().toISOString(), askId, project, STATUS_ANSWERED);
    return { delivered: res.changes > 0 };
  }

  // S3 — claim EVERY answered-but-undelivered park for a seat, flipping each answered -> consumed atomically
  // (per-row status='answered' guard = consume-once). Returns [{ askId, question, label, answeredBy }] (answeredBy null for a
  // row answered without a name), plus `replyText` on a row whose Other reply was saved, for the rows THIS
  // call won; a row lost to a concurrent claim (changes === 0) is skipped, so a second call returns []. Scope
  // wall: session_id = seat AND project = project — a reconnecting seat pulls only its own project's answers,
  // never another seat's or another project's. question/label are derived server-side from the stored
  // questions/selections (never a client string), mirroring the deliver-back the live path builds.
  // `replyText`, present only on a row with a saved Other reply, is that reply's copy; the pending-answers route sends it instead
  // of the bare line. Every other row keeps the shape it had before the reply wait.
  function claimUndeliveredForSeat(seat, project, nowIso = new Date().toISOString()) {
    if (!seat) return [];
    const rows = undeliveredForSeatStmt.all(seat, project, STATUS_ANSWERED, nowIso);
    const claimed = [];
    for (const row of rows) {
      const res = consumeStmt.run(STATUS_CONSUMED, new Date().toISOString(), row.tool_use_id, project, STATUS_ANSWERED);
      if (res.changes === 0) continue; // lost the row to a concurrent claim; skip (exactly-once)
      const { question, label, answeredBy } = questionAndLabel(row);
      // Forward-guard (plan GAP 1): a pid-shaped session_id means the park was made under DEV_SYNC_SEAT=auto,
      // whose seat name changes on restart — the reconnecting seat would never match this row. Warn so a
      // stranded-answer misconfig is visible; bare/fixed seats (all current live sessions) never trip this.
      if (/^[a-z0-9_-]+\.\d+$/.test(String(row.session_id || ''))) {
        console.warn(`[ask-store] claimed a park with a pid-shaped seat '${row.session_id}' — reconnect-claim requires a STABLE DEV_SYNC_SEAT (not auto); this answer may have been stranded across a restart`);
      }
      claimed.push({ askId: row.tool_use_id, question, label, answeredBy, ...(row.reply_text != null ? { replyText: row.reply_text } : {}), ...(row.expiry_state === 'failed' ? { noticeFailed: true } : {}) });
    }
    return claimed;
  }

  // The question, the selected label and who answered, derived server-side from what was stored (never a client string).
  function questionAndLabel(row) {
    const questions = parseStored(row.questions_json, row.tool_use_id);
    const selections = parseStored(row.selections_json, row.tool_use_id);
    const question = questions?.[0]?.question ?? '';
    const chosen = selections?.[question];
    const label = Array.isArray(chosen) ? chosen.join(', ') : (chosen ?? '');
    return { question, label, answeredBy: row.answered_by || null };
  }
  const waitRow = (row) => ({ askId: row.tool_use_id, project: row.project, seat: row.session_id, ...questionAndLabel(row) });

  // ─── Other-button reply wait (vault plan docs/plans/2026-11-08-other-button-reply-plan.md rev 4) ───
  // Every write is one guarded UPDATE on the row's id, project and status='answered', so each transition is single-shot
  // and the store is the only state: no in-memory copy can disagree with it across a race or a restart.
  const openWaitsForKeyStmt = db.prepare(
    `SELECT * FROM ask_parks WHERE reply_channel_id = ? AND reply_operator = ? AND project = ? AND status = 'answered'
       AND reply_wait_until IS NOT NULL AND tool_use_id != ? ORDER BY answered_at ASC`,
  );
  const clearWaitStmt = db.prepare(
    `UPDATE ask_parks SET reply_wait_until = NULL WHERE tool_use_id = ? AND project = ? AND status = 'answered' AND reply_wait_until IS NOT NULL`,
  );
  const armStmt = db.prepare(
    `UPDATE ask_parks SET reply_wait_until = ?, reply_channel_id = ?, reply_operator = ?
       WHERE tool_use_id = ? AND project = ? AND status = 'answered' AND reply_msg_id IS NULL`,
  );
  const newestOpenWaitStmt = db.prepare(
    `SELECT * FROM ask_parks WHERE reply_channel_id = ? AND reply_operator = ? AND project = ? AND status = 'answered'
       AND reply_wait_until IS NOT NULL AND reply_wait_until > ? ORDER BY answered_at DESC, rowid DESC LIMIT 1`,
  );
  const takeStmt = db.prepare(
    `UPDATE ask_parks SET reply_msg_id = ?, reply_wait_until = NULL
       WHERE tool_use_id = ? AND project = ? AND status = 'answered' AND reply_wait_until IS NOT NULL AND reply_wait_until > ?`,
  );
  const setReplyTextStmt = db.prepare(
    `UPDATE ask_parks SET reply_text = ? WHERE tool_use_id = ? AND project = ? AND status = 'answered' AND reply_msg_id IS NOT NULL`,
  );
  const replaceReplyTextStmt = db.prepare(
    `UPDATE ask_parks SET reply_text = ? WHERE tool_use_id = ? AND project = ? AND status = 'answered' AND reply_text = ?`,
  );
  const expiredWaitsStmt = db.prepare(
    `SELECT * FROM ask_parks WHERE status = 'answered' AND reply_wait_until IS NOT NULL AND reply_wait_until <= ? ORDER BY answered_at ASC`,
  );
  const usedMsgIdStmt = db.prepare('SELECT 1 AS n FROM ask_parks WHERE reply_msg_id = ? LIMIT 1');
  const unfinishedStmt = db.prepare(
    `SELECT * FROM ask_parks WHERE status = 'answered' AND reply_msg_id IS NOT NULL AND reply_text IS NULL ORDER BY answered_at ASC`,
  );
  const setPromptStmt = db.prepare('UPDATE ask_parks SET reply_prompt_json = ? WHERE tool_use_id = ? AND project = ?');
  const closedPromptsStmt = db.prepare(
    `SELECT * FROM ask_parks WHERE reply_prompt_json IS NOT NULL
       AND (status != 'answered' OR reply_wait_until IS NULL OR reply_wait_until <= ?) ORDER BY answered_at ASC`,
  );

  // Open a wait on an answered Other tap, in one transaction. The target must be armable (answered, not yet taken)
  // before anything else is touched. Every other open wait for the same channel and operator is then closed and
  // returned, so the store never holds two for one key; the caller delivers each displaced one as it does today.
  function armReplyWait(askId, project, { channelId, operator, until }) {
    const target = selectStmt.get(askId);
    if (!target || target.project !== project || target.status !== STATUS_ANSWERED || target.reply_msg_id != null) return { armed: false, displaced: [] };
    const displaced = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of openWaitsForKeyStmt.all(String(channelId), String(operator), project, askId)) {
        if (clearWaitStmt.run(row.tool_use_id, project).changes > 0) displaced.push(waitRow(row));
      }
      const armed = armStmt.run(String(until), String(channelId), String(operator), askId, project).changes > 0;
      if (!armed) { db.exec('ROLLBACK'); return { armed: false, displaced: [] }; }
      db.exec('COMMIT');
      return { armed: true, displaced };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      console.warn(`[ask-store] reply wait for '${askId}' could not open: ${e.message}`);
      return { armed: false, displaced: [] };
    }
  }

  // Close an open wait (expiry, a failed prompt). cleared:false when it was already closed, taken or consumed.
  function clearReplyWait(askId, project) {
    return { cleared: clearWaitStmt.run(askId, project).changes > 0 };
  }

  // Reserve the newest open, unexpired wait for this channel, operator and project to one Discord message. Synchronous
  // and single-shot; once taken, no expiry, replacement or prompt failure can act on the row. Returns the row or null.
  function takeReplyWait({ channelId, operator, project, discordMsgId, nowIso }) {
    if (!channelId || !operator || !project || !discordMsgId) return null;
    const row = newestOpenWaitStmt.get(String(channelId), String(operator), project, nowIso);
    if (!row) return null; // the usual case: no open wait, so the dedup scan below is skipped
    if (usedMsgIdStmt.get(String(discordMsgId))) return null; // one Discord message answers at most one wait, ever
    if (takeStmt.run(String(discordMsgId), row.tool_use_id, project, nowIso).changes === 0) return null;
    return { ...waitRow(row), operator: row.reply_operator };
  }

  // Save the asker's copy of a taken reply. Done before the message fans out, so the reply is claimable from then on;
  // the park is consumed once a live socket of the asker took it, which clears the text (consumeStmt).
  function setReplyText(askId, project, text) {
    return { saved: setReplyTextStmt.run(String(text), askId, project).changes > 0 };
  }
  // Add a voice note's transcript to a saved reply that is still undelivered, keeping the whole within `max`
  // characters with a visible marker when cut. Compare-and-swap on the old text, so two appends cannot lose one.
  function appendReplyText(askId, project, text, max = 8000) {
    for (let i = 0; i < 3; i++) {
      const row = selectStmt.get(askId);
      if (!row || row.project !== project || row.status !== STATUS_ANSWERED || row.reply_text == null) return { appended: false };
      let next = `${row.reply_text}\n${String(text)}`;
      if (next.length > max) next = next.slice(0, Math.max(0, max - TRUNCATED.length)) + TRUNCATED;
      if (replaceReplyTextStmt.run(next, askId, project, row.reply_text).changes > 0) return { appended: true };
    }
    return { appended: false };
  }

  function listExpiredWaits(nowIso) {
    return expiredWaitsStmt.all(nowIso).map(waitRow);
  }
  // Replies taken but never saved: a crash between the take and the send, or a failed save, leaves one. The sweep saves
  // today's bare answer for each, so the seat's next connect claims it.
  function listUnfinishedReplies() {
    return unfinishedStmt.all().map(waitRow);
  }

  // The posted prompt's edit target, kept on the row so a later close can edit it across a restart.
  function setPromptRef(askId, project, ref) {
    return { saved: setPromptStmt.run(JSON.stringify({ ...ref, tries: 0 }), askId, project).changes > 0 };
  }
  function clearPromptRef(askId, project) {
    return { cleared: setPromptStmt.run(null, askId, project).changes > 0 };
  }
  // Count one failed edit of a closed prompt; returns the new count (the caller gives up after a few).
  function notePromptTry(askId, project) {
    const row = selectStmt.get(askId);
    if (!row || row.project !== project || !row.reply_prompt_json) return { tries: null };
    let ref; try { ref = JSON.parse(row.reply_prompt_json); } catch { ref = {}; }
    const tries = (Number(ref.tries) || 0) + 1;
    setPromptStmt.run(JSON.stringify({ ...ref, tries }), askId, project);
    return { tries };
  }
  // Prompts whose wait is no longer open (taken, replaced, expired, failed or consumed): each needs its closing edit.
  function listClosedPrompts(nowIso) {
    const out = [];
    for (const row of closedPromptsStmt.all(nowIso)) {
      let ref; try { ref = JSON.parse(row.reply_prompt_json); } catch { ref = null; }
      out.push({ askId: row.tool_use_id, project: row.project, taken: row.reply_msg_id != null, ref });
    }
    return out;
  }

  // open: a wait is open now. taken: a reply took it. Both false: closed (expired, replaced, failed) or never armed.
  function getReplyState(askId, project) {
    const row = selectStmt.get(askId);
    if (!row || row.project !== project) return null;
    return { open: row.status === STATUS_ANSWERED && row.reply_wait_until != null, taken: row.reply_msg_id != null };
  }

  // Non-mutating status probe for a project-matching row. Returns { status } or null if not found
  // (or scoped to a different project). Used by the hook's first-fire check.
  function getStatus(toolUseId, project) {
    const row = selectStmt.get(toolUseId);
    if (!row || row.project !== project) return null;
    return { status: row.status };
  }

  // Non-consuming peek of a parked row's PUBLIC fields. Returns { project, questions } (questions parsed
  // via the same parseStored guard as claimForResume) or null if the toolUseId is unknown. The answer
  // endpoint uses this for its authz scope-check + canonicalize. NEVER returns the nonce or any other
  // column — keeping the reserved resume capability server-side, never on a read path the endpoint touches.
  function peekQuestions(toolUseId) {
    const row = selectStmt.get(toolUseId);
    if (!row) return null;
    return { project: row.project, questions: parseStored(row.questions_json, toolUseId) };
  }

  // Deliver-back accessor for the non-blocking dev_ask bridge. The interactionCreate handler that
  // resolves a Discord button click needs three things off the parked row: the park's `project` (for the
  // [I2] operator-bind), the `askingSeat` (to route the answer back to the idle agent's session), and the
  // offered `questions` (to derive the selected label by the button's option-index, never from a client
  // string). `askingSeat` lives in the existing session_id slot (the dispatch endpoint stores it there at
  // park time). Non-consuming, no state transition; returns null for an unknown askId. Mirrors the column
  // names peekQuestions reads (questions_json via the same parseStored guard). NEVER returns the nonce.
  function getAskForDelivery(askId) {
    const row = selectStmt.get(askId);
    if (!row) return null;
    return {
      project: row.project,
      askingSeat: row.session_id,
      questions: parseStored(row.questions_json, askId),
    };
  }

  // Durable card refs for the answer-time cross-edit (decisions-mirror fix, 2026-07-22). The
  // in-memory askMessageRefs map in server.js stays as the fast path; this is the restart-proof
  // truth. Channel/message ids are Discord-observable, not secrets; the nonce is never touched.
  const setRefsStmt = db.prepare('UPDATE ask_parks SET refs_json = ? WHERE tool_use_id = ?');
  const getRefsStmt = db.prepare('SELECT refs_json FROM ask_parks WHERE tool_use_id = ?');

  // Fire-and-forget from the posting path: an unknown askId flips zero rows and reports
  // updated:false rather than throwing (posting must never fail on a refs bookkeeping miss).
  function setRefs(askId, refs) {
    const res = setRefsStmt.run(JSON.stringify(refs ?? []), askId);
    return { updated: res.changes > 0 };
  }

  // Best-effort by contract: unknown askId, unset refs, or corrupt JSON all return null (with a
  // warning for corruption) — the cross-edit degrades, the answer path never breaks on it.
  function getRefs(askId) {
    const row = getRefsStmt.get(askId);
    if (!row || !row.refs_json) return null;
    try {
      const refs = JSON.parse(row.refs_json);
      return Array.isArray(refs) && refs.length ? refs : null;
    } catch {
      console.warn(`[ask-store] corrupt refs_json for '${askId}' — cross-edit refs dropped`);
      return null;
    }
  }
  // The sweep's read (fix round 3): the stored copies, [] when the row has none, and a throw (name RefsUnreadable) when refs_json is
  // there but is not a JSON array, so a copy the sweep cannot read counts as not closed rather than as nothing to close.
  function getRefsStrict(askId) {
    const row = getRefsStmt.get(askId);
    if (!row || row.refs_json === null || row.refs_json === undefined || row.refs_json === '') return [];
    let refs;
    try { refs = JSON.parse(row.refs_json); } catch { refs = undefined; }
    if (!Array.isArray(refs)) throw Object.assign(new Error('stored refs are not a JSON array'), { name: 'RefsUnreadable' });
    return refs;
  }

  function close() { db.close(); }

  return { park, answer, claimForResume, markAnswerDelivered, claimUndeliveredForSeat, getStatus, peekQuestions, getAskForDelivery, listPending, listOpen, listAnsweredForSeat, ackAnswer, setRefs, getRefs,
    listExpirable, expireIfPending, listExpiryOwed, claimNoticeAttempt, markExpiryDone, markExpiryListed, noteCopyTry, noteExpiryTry, expiryStateOf, getRefsStrict, markChannelAnswerPosted, channelAnswerPostedAt,
    listCopylessReplacements, closeCopylessReplacement, reopenWithPark, reopenedFrom, reopenedAs,
    armReplyWait, clearReplyWait, takeReplyWait, setReplyText, appendReplyText, listExpiredWaits, listUnfinishedReplies, getReplyState,
    setPromptRef, clearPromptRef, notePromptTry, listClosedPrompts, close, _db: db };
}
