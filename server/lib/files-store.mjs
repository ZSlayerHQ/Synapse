// dev-sync/files-store.js
//
// Synapse attachment store. Persists every uploaded file to a local SQLite DB so any
// authorised bot can retrieve it from the bus, closing the "upload deleted right after the
// Discord relay" gap (old behaviour: server.js fs.unlinkSync after relay, file gone).
//
// ONE well-named `tier` per file is the SINGLE source of truth for BOTH:
//   (a) the human / AI-legible CATEGORY of the file, and
//   (b) the serve + read SECURITY POLICY applied to it.
// Category and policy on one field can never drift apart (team-rule 5: one source of truth),
// and a reviewing AI sees WHY each type is handled the way it is from the same field.
//
// Security model (controls live at the USE path, independent of where the bytes are stored):
//   - Per-project read-wall: every row is stamped with the SERVER-authenticated project on
//     write; retrieval is FAIL-CLOSED unless the requester's authProject matches (or super-scope).
//   - Stored-XSS containment: lives at the serve path in server.js (Content-Disposition: attachment
//     + X-Content-Type-Options: nosniff, universal for every tier) so a direct browser GET on a
//     file URL downloads, never executes embedded script (the svg / html risk). This module
//     classifies; server.js sets the headers. Both are universal, not per-tier, on purpose.
//   - Prompt-injection containment: inline text previews are wrapped as explicitly-untrusted
//     content (untrustedWrap) so a bot never treats attachment bytes as instructions.
//   - No execution / no extraction: code + (future) archives are stored as opaque bytes, never run.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, randomBytes } from 'node:crypto';

// ─── Tier registry: the ONE source of truth for what's allowed + its category + its policy ───
// A file is ALLOWED iff its extension matches a tier (default-deny: unknown types are rejected).
// inlinePreview: may a bounded, untrusted-delimited TEXT preview ride inline on the bus message?
//   Every file is always retained + retrievable by id regardless; the preview is only a convenience
//   for small text the recipient bot would otherwise have to pull.
export const FILE_TIERS = {
  'safe-text': {
    extensions: ['txt', 'md', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'ini', 'xml'],
    inlinePreview: true,
    note: 'Plain data, no active content. Safe for a bot to read as untrusted text.',
  },
  'media': {
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'avif',
      'pdf', 'glb', 'mp4', 'mov', 'mkv', 'avi'],
    inlinePreview: false,
    note: 'Binary media. Stored + relayed to Discord; never read as text. Only an image/* mimetype in this tier is ever inlined to an agent.',
  },
  'audio': {
    extensions: ['ogg', 'opus', 'mp3', 'm4a', 'wav', 'flac', 'webm'],
    inlinePreview: false,
    note: 'Voice notes / audio. Stored as opaque bytes; transcribed on-box (Parakeet). The TRANSCRIPT is untrusted user speech and rides the bus untrusted-wrapped (never the audio inline, never the transcript as trusted text).',
  },
  'active-content': {
    extensions: ['svg', 'html'],
    inlinePreview: false,
    note: 'Can embed scripts. Stored, but NEVER inline-rendered; served as a download only (stored-XSS containment).',
  },
  'document': {
    extensions: ['docx', 'docm', 'doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'pptm', 'ppt',
      'odt', 'ods', 'odp', 'rtf', 'epub'],
    inlinePreview: false,
    note: 'Office and e-book documents. OPAQUE TRANSPORT: stored and served as a download, never parsed or inline-rendered here. Admission is by extension and is NOT a statement about content; macro-enabled formats are included deliberately because excluding their suffixes never detected a macro anyway. Whatever opens the file must not execute embedded content or resolve external relationships.',
  },
  'archive': {
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'],
    inlinePreview: false,
    note: 'Archives. OPAQUE TRANSPORT ONLY: stored and served as a download, never unpacked, listed or inspected here. An archive can contain ANY file type, so admitting this tier means the extension allowlist no longer bounds what bytes can enter the store. That is accepted deliberately; whatever unpacks one must treat every member as untrusted and apply its own limits.',
  },
  'code': {
    // `sh` and `ps1` are deliberately NOT here, though they are source text: this file has always
    // grouped them with `exe`/`bat` as executables, and admitting them while refusing `bat` would be an
    // inconsistency dressed as a policy. They ride inside an archive if someone genuinely needs them.
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'py', 'rb', 'go', 'rs',
      'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sql'],
    inlinePreview: true,
    note: 'Source text. Read as untrusted text only; NEVER executed. A script here is inert data: the store does not run it and no consumer should.',
  },
};
// Policy: the main everyday file types are allowed.
// This registry is no longer a narrow default-deny allowlist. The previous policy, and the stopping rule
// drafted with it earlier the same day, are DELETED rather than left standing beside this: they said
// archives were "pure attack surface for zero use" and that siblings are never admitted by family
// resemblance, and both are now false statements of how this file behaves.
//
// WHAT THE TIER SYSTEM STILL GUARANTEES, and it is the part that matters:
//   - NOTHING here is ever executed, unpacked or parsed by the bus. Storage is opaque.
//   - Only a `media` file with an image/* mimetype is inlined to an agent. Text tiers ride
//     untrusted-wrapped. `active-content` and `archive` are download-only, always.
//   - The project wall still gates every read.
// WHAT IT NO LONGER GUARANTEES: that the extension describes the bytes. It never really did (a renamed
// .docm always carried its macros), and with `archive` admitted, ANY file type can enter inside a
// container. So the tier is a RENDERING CONTRACT, not a content control. Do not cite it as one.
//
// Executables stay out (exe, dll, msi, bat, cmd, com, scr, vbs, jar, apk, deb, rpm, iso): they are the one
// class with no transport use here and an unambiguous execution intent. Not in any tier = still refused.

// NULL-PROTOTYPE on purpose. With a plain `{}` the lookup below inherits Object.prototype, so
// `classifyTier('x.constructor')` returned the Object constructor: a TRUTHY non-tier that passed the
// allowlist gate at server.js's multer filter and only failed later at the insert. `constructor` was the
// single reachable name (extensionOf lowercases, sparing toString/valueOf/hasOwnProperty, and its
// [a-z0-9]+ pattern excludes __proto__). Found by the 2026-09-11 Astra review.
const EXT_TO_TIER = (() => {
  const map = Object.create(null);
  for (const [tier, def] of Object.entries(FILE_TIERS)) {
    for (const ext of def.extensions) map[ext] = tier;
  }
  return map;
})();

const PREVIEW_MAX_BYTES = 8 * 1024; // inline-preview cap; larger text is still stored, pulled by id.

export function extensionOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

// The operator-facing alarm text, built here (pure) so a test can prove it survives the bus write-boundary
// sanitiser with its mention intact. Two traps this encodes (coordination review, 2026-09-12):
//   - the mention is plain `@<owner>`, NEVER `<@id>`: sendToChannel runs sanitizeText, which strips every `<...>`,
//     and resolveDiscordMentions turns `@<owner>` into a real ping at relay time. The codebase already said so at
//     server.js (relay) and at the untrusted-wrap fence above; this was the third time the trap was walked into;
//   - every action named must exist today. There is no self-serve delete surface yet, so the text does not
//     pretend there is, and it says the env override is read once at boot and needs a restart.
export function filesPressureMessage({ total, maxBytes, ratio, rows, evicted = 0 }, { mention = '' } = {}) {
  // Units follow the BUDGET: GB at production scale, MB below 1 GiB, so a staged or small-budget store never
  // reports "0.00 GB of 0.00 GB" (seen on the first witness run with a 200,000-byte budget).
  const unit = maxBytes >= 1024 ** 3 ? ['GB', 1024 ** 3, 2] : ['MB', 1024 ** 2, 1];
  const fmt = (n) => `${(n / unit[1]).toFixed(unit[2])} ${unit[0]}`;
  const pct = Math.min(100, Math.round(ratio * 100));
  const head = `${mention} **The Synapse file store is ${pct}% full**: ${fmt(total)} of ${fmt(maxBytes)} across ${rows} files.`;
  const already = evicted > 0
    ? ` It has ALREADY deleted ${evicted} of the uploading project's oldest files to stay under the budget.`
    : ' At 100% an upload deletes its own project\'s OLDEST files first, never another project\'s.';
  const actions = ' To clean it out: there is no self-serve delete yet, so tell the Synapse maintainer what to prune,'
    + ' or raise SYNAPSE_FILES_MAX_BYTES in dev-sync/.env and restart :4100 (the value is read once at boot).';
  return head + already + actions;
}

// Tier name for an allowed file, or null if the type is not allowed at all (the allowlist gate).
export function classifyTier(filename) {
  return EXT_TO_TIER[extensionOf(filename)] || null;
}

// The Content-Disposition for a stored file's download (RFC 6266, with an RFC 8187 extended value). Node refuses a header
// character above U+00FF, so the old quoted-only form turned a filename with emoji or CJK into a 500 for every downloader
// (Sol, 2026-10-19). The name is made well-formed (a lone surrogate would make encodeURIComponent throw) and stripped of
// control characters; the quoted fallback keeps printable ASCII only, and filename* carries the real name as UTF-8.
export function contentDispositionAttachment(filename) {
  const name = String(filename ?? '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '') || 'file';
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Wrap inline preview / transcript text so a reading bot treats it as data, never instructions.
// The boundary is UNFORGEABLE: a per-wrap random nonce in the open + close fences. An attacker who controls
// the body cannot predict the nonce, so cannot close the wrapper early; any literal delimiter token in the
// body is also neutralised before interpolation.
//
// CRITICAL — the fence uses NON-angle-bracket sentinels (⟦ ⟧), NOT `<...>`. The bus write-boundary
// sanitizeText() strips `<...>` HTML tags, which would silently DELETE an angle-bracket fence and land the
// untrusted body as bare, trusted-looking text — the exact runtime no-op the audio-transcription audit
// caught (the wrap existed but was stripped before delivery, defeating its whole purpose). The ⟦ ⟧ fence
// survives sanitizeText + any HTML-escaper, so the wrap stays the real trust boundary end-to-end.
//
// The body is also capped so the WRAPPED result stays under the bus CONTENT_MAX (8000); otherwise the close
// fence would be clipped off by the downstream length-cap and the wrap silently broken again.
export function untrustedWrap(filename, text, { budget = 7400, truncationNote = '' } = {}) {
  const nonce = randomBytes(8).toString('hex');
  // The filename goes INSIDE the opening fence, so it is attacker-influenceable metadata (a Discord
  // attachment name / a crafted upload). Strip the fence sentinels (⟦ ⟧) + quotes + control/line chars so it
  // can't break out of the fence, and HARD-CAP it — a long filename would otherwise push the CLOSE fence past
  // the downstream bus CONTENT_MAX (8000) cap and clip it (the Codex post-scan caught both). Sibling to the
  // body neutralisation below.
  const safeName = String(filename).replace(/[⟦⟧"]/g, '').replace(/[\x00-\x1f\x80-\x9f]/g, '').slice(0, 160); // strip C0 and C1 control chars
  // Budget-aware body cap. `budget` is the WRAPPED-result allowance for the DELIVERY PATH, not a security
  // property of the fence (nonce + neutralisation are unconditional below). The default 7400 serves every
  // bus-bound path: the wrapped result must stay under the bus CONTENT_MAX (8000) or sanitizeText's length
  // cap would clip the CLOSE fence downstream and silently break the trust boundary. Direct HTTP responses
  // (the MCP agent-read view) never traverse the bus, so they may pass their own larger budget — before
  // this parameter existed, dev_get_file inherited the bus cap and every text file over ~7.4KB arrived
  // truncated no matter what AGENT_TEXT_MAX_CHARS promised .
  // truncationNote lets the call site make the cut actionable (where to fetch the remainder); it is
  // server-composed text, never attacker input.
  const bodyMax = Math.max(500, budget - safeName.length);
  let body = String(text);
  if (body.length > bodyMax) body = body.slice(0, bodyMax) + `\n…[truncated${truncationNote}]`;
  const safeBody = body.replace(/⟦\/?untrusted-attachment-content/gi, '[attachment-tag]');
  return `⟦untrusted-attachment-content nonce="${nonce}" filename="${safeName}"⟧\n${safeBody}\n⟦/untrusted-attachment-content nonce="${nonce}"⟧`;
}

// ─── Agent-read view: the JSON an MCP agent gets for a stored file, keyed by tier + mimetype ───
// This is the READ counterpart of storeFile's tier policy. The SAME `tier` field that gates the serve path
// (server.js download headers) decides what an AGENT may see inline, so category and read-policy can never
// drift apart. `kind` is derived HERE, server-side, from the stored tier + mimetype — NEVER a client hint —
// so the security posture matches the download endpoint:
//   - only a media-tier image (mimetype image/*) is inlined as base64 (an svg carrying an image/svg+xml
//     mimetype is tier active-content, NOT media, so it is refused inline — stored-XSS containment holds);
//   - text tiers ride untrusted-wrapped (prompt-injection containment);
//   - a large image is refused inline (size cap), pointed at the download route instead.
// `file` is a getFile() result (non-null; content is a Buffer). Returns a plain JSON-serialisable object.
const AGENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // above this, refuse the base64 inline (kind:'too_large')
const AGENT_TEXT_MAX_CHARS = 200 * 1024;        // text slice cap before untrustedWrap's own budget applies

export function agentReadPayload(file) {
  const base = { id: file.id, filename: file.filename, mimetype: file.mimetype, tier: file.tier, size: file.size };
  const mimetype = String(file.mimetype || '');
  // Image: media tier AND an image/* mimetype (the pdf/glb siblings in `media` are NOT images).
  if (file.tier === 'media' && mimetype.startsWith('image/')) {
    if (file.size > AGENT_IMAGE_MAX_BYTES) {
      return { ...base, kind: 'too_large', note: `Image "${file.filename}" is ${file.size} bytes, over the ${AGENT_IMAGE_MAX_BYTES}-byte inline cap. Not inlined; download at /api/files/${file.id}.` };
    }
    return { ...base, kind: 'image', base64: file.content.toString('base64') };
  }
  // Text tiers: untrusted-wrapped so a reading agent treats the bytes as data, never instructions.
  // This is a direct HTTP response (never a bus message), so it carries its OWN wrap budget: without it,
  // the wrap's bus-default 7400 silently overrode AGENT_TEXT_MAX_CHARS and dev_get_file could never
  // return more than ~7.4KB of any text file. If the file exceeds even the agent budget, the cut names
  // the download route so the reader knows where the rest lives.
  if (file.tier === 'safe-text' || file.tier === 'code') {
    const full = file.content.toString('utf8');
    const note = full.length > AGENT_TEXT_MAX_CHARS
      ? `: showing ~${AGENT_TEXT_MAX_CHARS} of ${full.length} chars — full file at /api/files/${file.id}`
      : '';
    // The wrap does the cutting (not a pre-slice here): only a body the wrap itself sees as
    // over-budget gets the truncation marker appended, so pre-slicing would silently drop the note.
    return { ...base, kind: 'text', text: untrustedWrap(file.filename, full, { budget: AGENT_TEXT_MAX_CHARS, truncationNote: note }) };
  }
  // Non-image media (pdf/glb): stored, but not inlinable — point at the download route.
  if (file.tier === 'media') {
    return { ...base, kind: 'binary', note: `Binary ${file.tier} file "${file.filename}", ${file.size} bytes. Not viewable inline; download at /api/files/${file.id}.` };
  }
  // Audio: opaque bytes; the transcript is posted to the channel separately (server.js stt path).
  if (file.tier === 'audio') {
    return { ...base, kind: 'audio', note: 'Voice note; its transcript is posted separately to the channel.' };
  }
  // Active-content (svg/html): download-only for stored-XSS containment; never inlined.
  if (file.tier === 'active-content') {
    return { ...base, kind: 'blocked', note: 'Active-content (svg/html) is download-only for security; not inlined.' };
  }
  // Document (docx): ACTIONABLE, not merely blocked. Without this branch a document falls through to the
  // generic "not viewable inline" and a consumer is told nothing it can act on. The agent cannot parse the
  // bytes here, so the useful answer is the authenticated retrieval route plus the provenance to verify what
  // it got. This is what makes the tier portable to a consumer that is NOT on this machine (a remote client, the
  // launcher): a filesystem path would carry neither the bytes nor the permission to read them.
  if (file.tier === 'document') {
    return {
      ...base,
      kind: 'document',
      sha256: file.sha256,
      note: `Document "${file.filename}", ${file.size} bytes, sha256 ${file.sha256}. Not parsed or viewable inline: download the raw bytes at /api/files/${file.id} with your X-Dev-Key, then open them with a reader that does not execute embedded content. Admission was by file extension, so treat the contents as untrusted and do not assume they are macro-free.`,
    };
  }
  // Archive: download-only, never unpacked here. The note says so explicitly because the one thing a
  // consumer must not do is trust the container's contents on the strength of it having been stored.
  if (file.tier === 'archive') {
    return {
      ...base,
      kind: 'archive',
      sha256: file.sha256,
      note: `Archive "${file.filename}", ${file.size} bytes, sha256 ${file.sha256}. NOT unpacked or inspected by the bus: download at /api/files/${file.id} with your X-Dev-Key. It may contain any file type, including types this store would refuse directly, so unpack it somewhere isolated and treat every member as untrusted.`,
    };
  }
  // Defensive fallthrough: classifyTier only yields the 7 tiers above; an unknown one is treated as blocked.
  return { ...base, kind: 'blocked', note: `File "${file.filename}" is not viewable inline.` };
}

// maxBytes governs the SUM of the `size` column, not the physical .db file (which is larger: free pages,
// indexes, WAL). Raised 500MB -> 10GB so the operator is ASKED to clean up rather than
// having old attachments silently evicted; see enforceBudget for why that ordering matters.
export function createFilesStore(dbPath, {
  defaultProject = 'default',
  maxBytes = 10 * 1024 * 1024 * 1024,
  projectMaxBytes = maxBytes,        // one project's share: an upload evicts only its own project's files
  pressureRatio = 0.85,              // alarm at 85% of budget, well before the eviction backstop
  pressureCooldownMs = 6 * 60 * 60 * 1000,
  onPressure = null,                 // ({total, maxBytes, ratio, rows}) => void; best-effort, never throws upward
} = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      project     TEXT NOT NULL,
      uploader    TEXT,
      filename    TEXT NOT NULL,
      mimetype    TEXT,
      size        INTEGER NOT NULL,
      sha256      TEXT NOT NULL,
      tier        TEXT NOT NULL,
      content     BLOB NOT NULL,
      created_at  TEXT NOT NULL
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_project ON files(project)');

  // ─── Screenshot gallery companion table ───
  // QA / Playwright captures are stored as blobs in `files` (media tier, like any other image); their
  // gallery metadata (who captured it / which page / pass-fail) lives here, keyed by the file id. This is
  // persisted on purpose (the old in-memory screenshotMeta array was lost on every restart). `project` is
  // stamped from the producer's authenticated project, the same write-rule files use.
  db.exec(`
    CREATE TABLE IF NOT EXISTS screenshots (
      file_id     TEXT PRIMARY KEY,
      project     TEXT NOT NULL,
      developer   TEXT,
      page        TEXT,
      passed      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_screenshots_project ON screenshots(project)');

  const insertStmt = db.prepare(
    `INSERT INTO files (id, project, uploader, filename, mimetype, size, sha256, tier, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectStmt = db.prepare('SELECT * FROM files WHERE id = ?');
  const existsStmt = db.prepare('SELECT 1 AS present FROM files WHERE id = ?');
  const sumStmt = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM files');
  const projectSumStmt = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE project = ?');
  // rowid = reliable insertion order (created_at can tie at sub-ms). Never the file being stored, never another project's.
  const oldestOwnStmt = db.prepare('SELECT id, size FROM files WHERE project = ? AND id != ? ORDER BY rowid ASC LIMIT 1');
  const deleteStmt = db.prepare('DELETE FROM files WHERE id = ?');

  const insertShotStmt = db.prepare(
    `INSERT OR REPLACE INTO screenshots (file_id, project, developer, page, passed, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // JOIN files so a screenshot whose blob was budget-evicted automatically drops out of the gallery
  // (the metadata row may briefly outlive its blob; the JOIN is the orphan-safety net, eviction cleanup
  // below is the tidy-up). Newest-first by insertion order (rowid), createdAt can tie at sub-ms.
  const SHOT_COLS = 's.file_id, s.project, s.developer, s.page, s.passed, s.created_at, f.filename, f.mimetype, f.tier';
  const listShotsAllStmt = db.prepare(
    `SELECT ${SHOT_COLS} FROM screenshots s JOIN files f ON f.id = s.file_id ORDER BY s.rowid DESC LIMIT ?`,
  );
  const listShotsProjStmt = db.prepare(
    `SELECT ${SHOT_COLS} FROM screenshots s JOIN files f ON f.id = s.file_id WHERE s.project = ? ORDER BY s.rowid DESC LIMIT ?`,
  );
  const deleteShotStmt = db.prepare('DELETE FROM screenshots WHERE file_id = ?');

  // Bound the DB. Two mechanisms :
  //   1. ASK A HUMAN once usage is at or over `pressureRatio` of the budget. An alarm the operator can act on is the
  //      intended mechanism.
  //   2. Evict oldest-first as the backstop, ONLY within the uploading project: when that project passes its share
  //      (projectMaxBytes) or the store passes the whole budget. One project's uploads never delete another project's
  //      files; when the project's own older files cannot make room, the new file is refused (OVER_BUDGET) instead.
  // Evaluation order: the backstop runs FIRST so the alarm reports POST-eviction numbers. A pre-eviction read
  // could say "114% full", self-contradictory exactly when it matters most (reviewer finding 9, 2026-09-12).
  // The alarm still fires then, since a store that just evicted is by definition over the line, and `evicted`
  // tells the operator deletion has already started.
  // Rate-limited; re-arms only when usage is seen back under the threshold. That is only observed on the next
  // storeFile call (the sole caller), so after a cleanup with no upload the flag stays down and the cooldown,
  // not the re-arm, bounds the next alarm to within `pressureCooldownMs`.
  let pressureNotifiedAt = 0;
  let pressureArmed = true;
  const overBudget = (message) => Object.assign(new Error(`files-store: ${message}`), { code: 'OVER_BUDGET' });
  function enforceBudget(project, newId) {
    if (!maxBytes && !projectMaxBytes) return;
    let total = sumStmt.get().total;
    let own = projectSumStmt.get(project).total;
    let evicted = 0;
    while ((projectMaxBytes && own > projectMaxBytes) || (maxBytes && total > maxBytes)) {
      const oldest = oldestOwnStmt.get(project, newId);
      if (!oldest) break;
      deleteStmt.run(oldest.id);
      deleteShotStmt.run(oldest.id); // drop any gallery metadata for the evicted blob (no-op if not a screenshot)
      total -= oldest.size;
      own -= oldest.size;
      evicted++;
    }
    if ((projectMaxBytes && own > projectMaxBytes) || (maxBytes && total > maxBytes)) {
      deleteStmt.run(newId); // room only by deleting another project's files: refuse this one instead
      throw overBudget('no room in the store without deleting another project\'s files');
    }
    if (!maxBytes) return;
    if (total >= maxBytes * pressureRatio) {
      const now = Date.now();
      if (pressureArmed || now - pressureNotifiedAt >= pressureCooldownMs) {
        pressureArmed = false;
        pressureNotifiedAt = now;
        // A notification failure must never break an upload: the store's job is storage. But it must be
        // SAID, or a broken alarm is undiagnosable until the store is full (reviewer finding 8).
        try { onPressure?.({ total, maxBytes, ratio: total / maxBytes, rows: countStmt.get().n, evicted }); }
        catch (e) { console.warn('[files-store] onPressure alarm threw; the upload is unaffected:', e?.message || e); }
      }
    } else {
      pressureArmed = true;
    }
  }

  // Current usage, exposed on the AUTHENTICATED /api/health payload (server.js) and used by tests. Cheap: two
  // indexed aggregates. Without a reader this was dead code and the operator had no view of the budget before
  // the alarm fired (reviewer finding 7).
  function usage() {
    const total = sumStmt.get().total;
    return { total, maxBytes, ratio: maxBytes ? total / maxBytes : 0, rows: countStmt.get().n,
      pressureRatio, underPressure: !!maxBytes && total >= maxBytes * pressureRatio };
  }

  // Persist a file. `project` MUST be the server-authenticated project (never a body-supplied value).
  // Throws if project is missing or the file type is not allowed. Returns metadata + (for
  // inlinePreview tiers, under the byte cap) an untrusted-wrapped text preview for the bus message.
  // A file larger than its project's share (or the whole budget) is refused BEFORE it is written (OVER_BUDGET). A file
  // within the share survives its own enforcement: eviction never picks the file being stored, and a file that would need
  // another project's files deleted is removed again and refused.
  // An error after that point carries `storedFileId` only when the row is read back present, so a caller can tell a stored
  // file from one that never landed.
  function storeFile({ project, uploader, filename, mimetype, buffer, createdAt }) {
    if (!project) throw new Error('files-store: project (authProject) is required on write');
    const tier = classifyTier(filename);
    if (!tier) throw new Error('files-store: file type not allowed');
    const size = buffer.length;
    if ((maxBytes && size > maxBytes) || (projectMaxBytes && size > projectMaxBytes)) throw overBudget('file exceeds the project\'s share of the store');
    const id = randomUUID();
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const ts = createdAt || new Date().toISOString();
    try {
      insertStmt.run(id, project, uploader || null, filename, mimetype || null, size, sha256, tier, buffer, ts);
      enforceBudget(project, id);
      const def = FILE_TIERS[tier];
      let preview = null;
      if (def.inlinePreview && size <= PREVIEW_MAX_BYTES) {
        // Bus-bound (default budget). A 7.4-8KB file still truncates here; the note points the reader
        // at dev_get_file, which now returns the full text under its own agent budget.
        preview = untrustedWrap(filename, buffer.toString('utf8'), { truncationNote: `: full file via dev_get_file(fileId="${id}")` });
      }
      return { id, tier, size, sha256, createdAt: ts, inlinePreview: def.inlinePreview, previewIncluded: preview != null, preview };
    } catch (e) {
      try { if (existsStmt.get(id) && e && typeof e === 'object') e.storedFileId = id; } catch {}
      throw e;
    }
  }

  // Retrieve a file, FAIL-CLOSED on the per-project read-wall.
  // requesterProject = the SERVER-authenticated project of the caller (never a request param).
  // superScope = the operator/dashboard cross-project carve-out (same as the bus read-wall).
  // Returns the row (incl. content Buffer + tier) or null if not found OR walled off (caller -> 404).
  function getFile(id, requesterProject, { superScope = false } = {}) {
    const row = selectStmt.get(id);
    if (!row) return null;
    if (!superScope) {
      // Fail-closed: deny when the caller has no project, or the row's project does not match.
      // project is NOT NULL at write time; we never COALESCE a blank row to the default (that would
      // leak an unstamped row to the default project) — a blank/null row is denied to all but super-scope.
      if (!requesterProject || !row.project || row.project !== requesterProject) return null;
    }
    const def = FILE_TIERS[row.tier] || {};
    return {
      id: row.id,
      project: row.project,
      uploader: row.uploader,
      filename: row.filename,
      mimetype: row.mimetype,
      size: row.size,
      sha256: row.sha256,
      tier: row.tier,
      createdAt: row.created_at,
      content: Buffer.from(row.content),
      inlinePreview: !!def.inlinePreview,
    };
  }

  // Agent-read wrapper over getFile: SAME fail-closed read-wall, returns { status, body } so the server
  // route (GET /api/files/:id/agent) is a thin passthrough — res.status(status).json(body) — and this whole
  // decision (wall + 404 + tier/mimetype kind derivation) is unit-testable without booting express.
  function getFileForAgent(id, requesterProject, { superScope = false } = {}) {
    const file = getFile(id, requesterProject, { superScope });
    if (!file) return { status: 404, body: { error: 'File not found' } };
    return { status: 200, body: agentReadPayload(file) };
  }

  // Persist gallery metadata for a stored screenshot blob. `fileId` references files.id (store the blob
  // FIRST via storeFile, then record its gallery metadata here). `project` MUST be the producer's
  // server-authenticated project (never a body value) — same write-rule as storeFile.
  function storeScreenshotMeta({ fileId, project, developer, page, passed, createdAt }) {
    if (!fileId) throw new Error('files-store: fileId is required on screenshot meta');
    if (!project) throw new Error('files-store: project (authProject) is required on screenshot meta');
    const ts = createdAt || new Date().toISOString();
    insertShotStmt.run(fileId, project, developer || null, page || null, passed ? 1 : 0, ts);
    return { fileId, project, developer: developer || null, page: page || null, passed: !!passed, createdAt: ts };
  }

  // List gallery screenshots, newest first. FAIL-CLOSED on the per-project wall: a caller with no project
  // and no super-scope gets nothing (never a default-project fallback that would leak rows). super-scope is
  // the operator dashboard's sanctioned cross-project view (same carve-out as the bus read-wall).
  function listScreenshots({ project, superScope = false, limit = 100 } = {}) {
    const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
    const rows = superScope ? listShotsAllStmt.all(lim) : (project ? listShotsProjStmt.all(project, lim) : []);
    return rows.map((r) => ({
      fileId: r.file_id, project: r.project, developer: r.developer, page: r.page,
      passed: !!r.passed, createdAt: r.created_at, filename: r.filename, mimetype: r.mimetype, tier: r.tier,
    }));
  }

  function close() { db.close(); }

  return { storeFile, getFile, getFileForAgent, storeScreenshotMeta, listScreenshots, classifyTier, untrustedWrap, agentReadPayload, usage, FILE_TIERS, close, _db: db };
}
