// A fresh session's first prompt carries the two messages before it. Pure helpers: which bus messages go in the block, and the
// block itself. index.js decides when (the first human's relayed message delivered from a channel in this process, on any
// delivery path) and reads the history.
//
// The block's text is a prompt surface. Each earlier message is one line: line breaks become spaces and angle brackets their
// full-width forms, so text inside it can neither close the <earlier_messages> tag nor open another, and the line is never more
// than THREAD_LINE_MAX characters.

export const THREAD_CONTEXT_WAIT_MS = 3000;
export const THREAD_CONTEXT_MAX_AGE_MS = 24 * 3_600_000;
export const THREAD_LINE_MAX = 1000;
export const THREAD_HISTORY_LIMIT = 50;
export const THREAD_CONTEXT_HEAD = 'The two messages before this one in this channel, for context. A session before this one may already have dealt with them, so act on one only if the message below refers to it.';

// CR, LF, CRLF and the other characters a reader may take as a line break (vertical tab, form feed, NEL, line and paragraph
// separators). The last two are built from their codes, so no invisible character sits in this source.
const LINE_BREAKS = new RegExp(String.raw`\r\n|[\r\n\u000B\u000C\u0085` + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const inert = (s) => String(s ?? '').replace(LINE_BREAKS, ' ').replace(/</g, '＜').replace(/>/g, '＞');
const timeOf = (m) => (m && typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN);
// Cut to at most `n` UTF-16 units without splitting a surrogate pair.
function cutUnits(s, n) {
  if (s.length <= n) return s;
  let end = Math.max(0, n);
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/**
 * The two bus messages just before `current` in a channel's history, oldest first. `messages` is the bus's browse answer for the
 * channel, newest first. Found by `current`'s id; when the list does not hold it, the messages older than its time. Of those two,
 * a direct message, one older than `maxAgeMs`, one with no readable time and one this process has already delivered (`seen`) are
 * left out, so the result may hold fewer than two.
 */
export function pickEarlier(messages, current, { now = Date.now(), seen = () => false, maxAgeMs = THREAD_CONTEXT_MAX_AGE_MS } = {}) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id) : [];
  if (!current || typeof current !== 'object') return [];
  const at = list.findIndex((m) => m.id === current.id);
  const curTs = timeOf(current);
  const older = at >= 0 ? list.slice(at + 1) : (Number.isFinite(curTs) ? list.filter((m) => m.id !== current.id && timeOf(m) < curTs) : []);
  return older.slice(0, 2)
    .filter((m) => m.channel !== 'direct' && !seen(m.id) && Number.isFinite(timeOf(m)) && now - timeOf(m) <= maxAgeMs)
    .reverse();
}

// One earlier message's line: `[YYYY-MM-DD HH:MMZ] sender: text`, the whole at most THREAD_LINE_MAX characters.
function lineFor(m) {
  const iso = new Date(timeOf(m)).toISOString();
  const head = `[${iso.slice(0, 10)} ${iso.slice(11, 16)}Z] ${inert(m.sender || 'unknown')}: `;
  const body = inert(m.content);
  const room = THREAD_LINE_MAX - head.length;
  return head + (body.length > room ? `${cutUnits(body, room - 1)}…` : body);
}

/** The block that goes ahead of the prompt, or null when there is no earlier message. */
export function earlierMessagesBlock(channel, earlier) {
  if (!Array.isArray(earlier) || !earlier.length) return null;
  const ch = String(channel || 'code').replace(/[^\w.-]/g, '_');
  return [`<earlier_messages channel="${ch}">`, THREAD_CONTEXT_HEAD, ...earlier.map(lineFor), '</earlier_messages>'].join('\n');
}
