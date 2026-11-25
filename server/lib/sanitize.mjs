// dev-sync/sanitize.js
//
// S1 B-1 stored-XSS backstop: length-cap + neuter dangerous HTML in stored free-form sender/content at the
// bus write boundary, so an injected <script>/<img onerror=...> never persists in messageHistory and replays
// into the operator dashboard. Strips tags + the javascript:/on*= execution surface; the cap bounds memory
// on the uncapped sender/content fields.
//
// Extracted from server.js into its own module so the cross-module invariant "the untrusted-wrap fence MUST
// survive this pass" is unit-testable (transcribe.test.mjs / files-store.test.mjs import the REAL function).
// The audio-transcription audit caught that the old `<...>` wrap fence was being SILENTLY STRIPPED here,
// defeating the whole untrusted boundary — the wrap now uses ⟦ ⟧ sentinels that this pass does not touch.

export function sanitizeText(v, max) {
  // HARD, non-optional (the design's stored-XSS backstop). NOT gated on ENFORCE_IDENTITY: it only strips
  // dangerous HTML / length-caps, never rejects a request, so it carries no backward-compat cost and the
  // pre-S1 suites stay green. A rollback of SYNAPSE_ENFORCE_IDENTITY must NOT drop this backstop.
  if (v === undefined || v === null) return v;
  let s = String(v);
  if (s.length > max) s = s.slice(0, max);
  return s
    .replace(/<\s*(script|iframe|object|embed|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')            // strip any remaining tags (incl. <img ... onerror=...>)
    .replace(/javascript:/gi, '')
    .replace(/\son\w+\s*=/gi, ' ');     // strip inline event-handler attributes if any survive
}

// Text a bot wrote, posted by the system sender through the relay (batch 3 fix round 1, H and E): every `@` and `#` becomes its
// full-width form (＠ ＃), so neither the relay's mention resolver (`@<name>`) nor its channel-link rewrite (`#<name>`) can fire on
// it, and Discord parses no mention, channel or heading from it. The text still reads the same.
export function inertMentions(v) {
  return String(v ?? '').replace(/@/g, '＠').replace(/#/g, '＃');
}

// A longer text the system sender posts that a bot or a person wrote (batch 3 fix round 2, the coordination gate's point on the
// "Answer to a reopened question" line), given the escaping a restart reason gets (launcher-control.mjs serviceReasonText, whose
// copy stays there while the restart part ships on its own): Discord markdown escaped with a backslash, `<` and `>` given full-width
// forms, `@` and `#` broken (inertMentions), control characters made spaces and invisible format characters (zero-width,
// bidirectional) removed. Unlike a reason it keeps its line breaks. `max` (fix round 3, finding 6) is the cut, made on the ESCAPED
// text (the header included, as the caller passes it): escaping can make a text that fit the bus limit longer than it, so a longer
// result is cut before the character that would cross `max` less the marker, and ends with INERT_CUT. A cut never splits an escape
// or a surrogate pair. With no `max` nothing is cut.
const INERT_MARKS = new Set(['\\', '*', '_', '~', '`', '|', '[', ']']);
const INERT_WIDE = { '<': '＜', '>': '＞' };
const INERT_CONTROLS = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');
const INERT_INVISIBLE = new RegExp('[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]', 'g');
export const INERT_CUT = ' … (cut to fit)';
export function inertDiscordText(v, max = Infinity) {
  const s = inertMentions(String(v ?? '').replace(/\r\n?/g, '\n').replace(INERT_CONTROLS, ' ').replace(INERT_INVISIBLE, ''));
  const pieces = [];
  let total = 0;
  for (const ch of s) { const p = INERT_MARKS.has(ch) ? `\\${ch}` : (INERT_WIDE[ch] || ch); pieces.push(p); total += p.length; }
  if (!(total > max)) return pieces.join('');
  const room = Math.max(0, max - INERT_CUT.length);
  let out = '';
  for (const p of pieces) { if (out.length + p.length > room) break; out += p; }
  return `${out}${INERT_CUT}`.slice(0, Math.max(0, max));
}
