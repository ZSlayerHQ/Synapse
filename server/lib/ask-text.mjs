// Text for decision cards (dev_ask): the standing buttons every card gets, and the line the asking seat receives when
// a person answers. Ported from the live card builder, without the Discord rendering (that belongs to the Discord pack).

import { sanitizeText } from './sanitize.mjs';

export const MAX_OPTIONS = 25;
export const DISCUSS_LABEL = '💬 Other (discuss further)';
export const DISMISS_LABEL = '✖ Dismiss (no decision)';
const DISMISS_INSTRUCTION = 'This card was closed with no decision. Do not go ahead with what it asked. Carry on with other work you are cleared for, and do not ask this again unless something changes.';
const ANSWER_QUESTION_MAX = 1000;
const ANSWER_LABEL_MAX = 1000;

// The caller's options minus any copy of the reserved Dismiss label, then Other unless a discuss-shaped option is
// offered, then Dismiss when `dismiss` is on and a slot is free. Stored indices match the order shown.
export function withStandingButtons(options, { dismiss = true } = {}) {
  const own = options.filter((o) => String(o) !== DISMISS_LABEL);
  const withOther = own.some((o) => /discuss/i.test(String(o))) ? own : [...own, DISCUSS_LABEL];
  return dismiss && withOther.length < MAX_OPTIONS ? [...withOther, DISMISS_LABEL] : withOther;
}

function fitUnits(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  const cut = /[\uD800-\uDBFF]/.test(s[max - 1]) ? max - 1 : max;
  return s.slice(0, cut);
}
function boundText(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${fitUnits(s, max)}…`;
}
const flatLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

// The MCP client drops any frame whose content contains `<channel` (its relay-loop guard); the asking seat's copy swaps
// `<` for a look-alike there, one character for one.
export function neutralizeChannelMarker(text) {
  return String(text ?? '').replaceAll('<channel', '‹channel');
}

// A fixed point of sanitize + neutralize, so the live send and the reconnect claim carry identical text.
export function wireSafeText(text, max) {
  let s = String(text ?? '');
  for (;;) {
    const next = neutralizeChannelMarker(sanitizeText(s, max));
    if (next === s) return s;
    s = next;
  }
}

export function buildDeliverBackMessage(askId, question, label, answeredBy, max = 8000) {
  const head = `📥 dev_ask answer [askId ${flatLine(askId)}] Question: ${boundText(flatLine(question), ANSWER_QUESTION_MAX)}`;
  const by = typeof answeredBy === 'string' && answeredBy ? ` | Answered by: ${flatLine(answeredBy)}` : '';
  const instruction = label === DISMISS_LABEL ? ` | ${DISMISS_INSTRUCTION}` : '';
  return wireSafeText(`${head} | Selected: ${boundText(flatLine(label), ANSWER_LABEL_MAX)}${by}${instruction}`, max);
}
