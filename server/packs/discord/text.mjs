// Pure builders for the Discord pack: message text, button rows, button ids and log-safe error categories. No
// discord.js import and no I/O, so everything that decides what a button carries or what leaves the machine is
// testable without a gateway.
//
// A button's custom id carries only an opaque card id and an option index: `ask|<askId>|<option index>`. No label, name
// or secret. The core takes the label from the parked card by index.
//
// Redaction rule: every caller-supplied field is passed through `redact` BEFORE it is clipped, escaped or put into a
// heading, so a clip can never cut a secret in two and leave a prefix behind; the finished text gets one more pass.

import { DISMISS_LABEL, DISCUSS_LABEL } from '../../lib/ask-text.mjs';

export const CONTENT_MAX = 2000; // Discord's message limit
export const STORED_QUESTION_MAX = 300; // the question kept with a card for its closed text
const LABEL_MAX = 80; // Discord's button label limit
const PER_ROW = 5;
const MAX_BUTTONS = 25;
const ROW = 1;
const BUTTON = 2;
const STYLE = { primary: 1, secondary: 2 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DISCORD_EPOCH = 1420070400000n;
const identity = (s) => String(s ?? '');

// The longest prefix of at most `max` UTF-16 units that does not split a surrogate pair, with an ellipsis when cut.
export function fit(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let cut = max - 1;
  if (/[\uD800-\uDBFF]/.test(s[cut - 1])) cut--;
  return `${s.slice(0, cut)}…`;
}
const oneLine = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
// Markdown and mention marks shown as written, for names and other short single-line text.
export function escapeMd(text) {
  return oneLine(text).replace(/[\\*_~|`>#[\]()<@:]/g, (c) => `\\${c}`);
}
// One field, safe to show: redacted first, then clipped, then (for single-line fields) escaped.
const field = (redact, v, max) => fit(redact(v), max);
const name = (redact, v, max = 80) => escapeMd(field(redact, v, max));
// The finished message: one more redaction pass over everything, then Discord's limit.
const finish = (redact, text) => fit(redact(text), CONTENT_MAX);

export function askCustomId(askId, index) { return `ask|${askId}|${index}`; }
// -> { kind: 'ask', askId, optionIndex } | null. Fail closed on any deviation.
export function parseCustomId(customId) {
  if (typeof customId !== 'string' || customId.length > 100) return null;
  const parts = customId.split('|');
  if (parts.length !== 3 || parts[0] !== 'ask' || !UUID.test(parts[1])) return null;
  if (!/^(?:0|[1-9]\d?)$/.test(parts[2]) || Number(parts[2]) >= MAX_BUTTONS) return null;
  return { kind: 'ask', askId: parts[1], optionIndex: Number(parts[2]) };
}
// When Discord created this id (an interaction id is a snowflake), in ms since 1970, or null.
export function snowflakeTime(id) {
  if (typeof id !== 'string' || !/^\d{17,20}$/.test(id)) return null;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

// What a log line may say about an external error: a known code, an HTTP status, or a known error class. Never the
// error's message or the request behind it, which can carry ids, URLs or credential-shaped text.
const KNOWN_CODES = new Set([10003, 10008, 40005, 50001, 50013, 50035, 'TokenInvalid', 'DisallowedIntents', 'ECONNRESET',
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'NOT_TEXT_CHANNEL']);
const KNOWN_NAMES = new Set(['RateLimitError', 'AbortError', 'TimeoutError', 'DiscordAPIError', 'HTTPError']);
export function errorCategory(e) {
  if (!e || typeof e !== 'object') return 'unknown';
  if (KNOWN_CODES.has(e.code)) return `code ${e.code}`;
  if (Number.isInteger(e.status) && e.status >= 100 && e.status < 600) return `http ${e.status}`;
  if (KNOWN_NAMES.has(e.name)) return e.name;
  return 'other';
}

const mentionLine = (ids) => ids.map((id) => `<@${id}>`).join(' ');
const rows = (buttons) => {
  const out = [];
  for (let i = 0; i < buttons.length; i += PER_ROW) out.push({ type: ROW, components: buttons.slice(i, i + PER_ROW) });
  return out;
};

// The question as stored with a card for its closed text: redacted, then clipped.
export function storedQuestion(question, redact = identity) {
  return field(redact, question, STORED_QUESTION_MAX);
}

// The open card: mentions, heading, question, origin, background, recommendation, and one button per option.
export function buildCardMessage({ askId, project, askingSeat, question, options, context, recommendation, series }, { mentionIds = [], redact = identity } = {}) {
  const opts = (Array.isArray(options) ? options : []).slice(0, MAX_BUTTONS);
  const head = [
    mentionIds.length ? mentionLine(mentionIds) : '',
    `### 🔘 Decision needed${series ? ` · ${name(redact, series, 60)}` : ''}`,
    `**${name(redact, question, 300)}**`,
    `From ${name(redact, askingSeat || 'a session')} in ${name(redact, project)}`,
  ].filter(Boolean).join('\n');
  const rec = recommendation ? `\n\n⭐ **Recommendation**\n${field(redact, recommendation, 500)}` : '';
  const room = CONTENT_MAX - head.length - rec.length - '\n\n📋 **Context**\n'.length - 40;
  const ctx = context && room > 50 ? `\n\n📋 **Context**\n${field(redact, context, room)}` : '';
  const buttons = opts.map((label, i) => ({
    type: BUTTON,
    style: label === DISMISS_LABEL || label === DISCUSS_LABEL ? STYLE.secondary : STYLE.primary,
    label: fit(redact(label), LABEL_MAX) || `Option ${i + 1}`,
    custom_id: askCustomId(askId, i),
  }));
  return { content: finish(redact, `${head}${ctx}${rec}`), components: rows(buttons), allowedMentions: { users: [...mentionIds] } };
}

// The card once it is closed: the outcome under the question, no buttons, no mentions. `question` is the stored one.
export function buildClosedCardText({ question, label, answeredBy, redact = identity }) {
  const q = `**${name(redact, question || 'Decision card', STORED_QUESTION_MAX + 1)}**`;
  const who = name(redact, answeredBy || 'someone');
  let text;
  if (label === DISMISS_LABEL) text = `### ✖ Dismissed\n${q}\nDismissed by ${who}: no decision`;
  else {
    const line = `Answered by ${who}: ${name(redact, label, 300)}`;
    text = label === DISCUSS_LABEL ? `### 💬 Discussion\n${q}\n${line}\nReply in this channel; the session reads it.` : `### ✅ Answered\n${q}\n${line}`;
  }
  return finish(redact, text);
}

// A channel post mirrored to Discord: who, from which bus channel, then the text. Mentions never ping (allowedMentions).
export function buildRelayText({ sender, channel, content }, { redact = identity } = {}) {
  const head = `**${name(redact, sender || 'unknown')}** · #${name(redact, channel || 'code', 40)}\n`;
  return finish(redact, head + field(redact, content, CONTENT_MAX));
}

export function buildNotifyText({ sender, message, priority }, { mentionIds = [], redact = identity } = {}) {
  const icon = priority === 'urgent' ? '🚨' : priority === 'action' ? '🔔' : 'ℹ️';
  return finish(redact, `${mentionIds.length ? `${mentionLine(mentionIds)} ` : ''}${icon} **${name(redact, sender || 'a session')}**: ${field(redact, message, CONTENT_MAX)}`);
}

// Why a tap was refused, as the person who tapped sees it (only they see it).
export function refusalText(error) {
  switch (error) {
    case 'unknown_account': return 'Synapse does not know your Discord account, so it cannot take this answer. Ask the owner to add your account id to synapse.config.json.';
    case 'not_an_answerer': return 'You are not an owner or approver for this project, so this answer was not taken.';
    case 'wrong_project': return 'This card belongs to another project, so it cannot be answered here.';
    case 'already_answered': return 'This was already answered.';
    case 'not_found': return 'Synapse no longer has this card (it may have closed).';
    case 'not_registered': return 'This card is still being posted, or is not the card Synapse posted. Tap again on the card in its channel.';
    case 'stale': return 'This tap is too old to accept. Tap the button again.';
    case 'not_ours': return 'This button is not on a Synapse card.';
    default: return 'Synapse could not take this answer.';
  }
}
