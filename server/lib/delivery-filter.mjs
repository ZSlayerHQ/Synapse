// delivery-filter.mjs — pure per-seat delivery classification + digest formatting.
// Per-seat delivery filter: which messages wake a seat live and which wait in its digest.
//
// classifyDelivery decides, for ONE (channel message, seat) pair, whether the seat's live WS
// socket gets the frame now ('live') or the message batches into the seat's digest ('digest').
// It sits ONLY in sendToChannel's push loop — DMs (sendDirect), alerts (deliverAlertWs), and
// event frames (broadcastWs) never traverse it, which makes the R1 floor for DMs / urgent
// alerts / dev_ask answers STRUCTURAL: those paths cannot be filtered by construction (this
// note: no askId tracking is needed, the answer rides sendDirect —
// and note 4 — the digest itself is delivered via sendDirect, so it can never self-defer).
//
// The always-live floor below is CODE, not config (spec R4): a projects.json typo can widen
// the digest set only within digestChannels; it can never silence a human sender or an
// @mention. Absent/empty config = 'live' for everything = today's behavior (dark ship).

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// msg: { channel, sender, content }   seat: connection's developer name (may be dotted)
// cfg:  the seat's delivery config from projects.json, e.g.
//       { digestChannels: ['code','build','tasks'], liveChannels: ['qa'] } — or undefined
// helpers: { seatBase: fn(seat)->base, humans: Set<lowercased human roster names> }
export function classifyDelivery(msg, seat, cfg, { seatBase, humans }) {
  if (!cfg || !Array.isArray(cfg.digestChannels) || cfg.digestChannels.length === 0) return 'live';
  // Defensive floor: direct + alerts are live even if a future refactor routes them here.
  if (msg.channel === 'direct' || msg.channel === 'alerts') return 'live';
  // Explicit live lane wins over a contradictory digest listing (belt + braces, spec R1 per-seat).
  if (Array.isArray(cfg.liveChannels) && cfg.liveChannels.includes(msg.channel)) return 'live';
  if (!cfg.digestChannels.includes(msg.channel)) return 'live';
  // Human sender bypass — non-negotiable (spec R1.2).
  if (humans.has(String(msg.sender || '').toLowerCase())) return 'live';
  // @mention of the seat's base name, case-insensitive, word-bounded (spec R1.1).
  const base = seatBase(seat) || seat;
  if (new RegExp(`@${escapeRe(String(base))}\\b`, 'i').test(String(msg.content || ''))) return 'live';
  return 'digest';
}

// One deterministic digest message from the withheld entries (spec R2). Entries render one line
// each: [HH:MM] sender→#channel: first ~160 code points, newlines flattened, LOUD ellipsis on
// truncation. Full text stays on the bus (dev_msg_history) — the digest is a pointer, not a copy.
const LINE_CAP = 160;

export function formatDigest(entries) {
  const lines = entries.map((e) => {
    const hhmm = String(e.timestamp || '').slice(11, 16) || '--:--';
    const flat = String(e.content || '').replace(/\s*\n\s*/g, ' ');
    const cps = Array.from(flat);
    const body = cps.length <= LINE_CAP ? flat : cps.slice(0, LINE_CAP - 1).join('') + '…';
    return `[${hhmm}] ${e.sender}→#${e.channel}: ${body}`;
  });
  return `📰 Digest — ${entries.length} message(s) while filtered (full text via dev_msg_history):\n${lines.join('\n')}`;
}
