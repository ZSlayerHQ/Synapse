// DM receipts (vault plan docs/plans/2026-11-11-dm-receipts-missed-notice-plan.md, section 2; Sol-reviewed).
// POST /api/message/direct used to answer {ok,id} whether or not anyone could receive the DM, and the MCP client
// printed "Sent" on every 200, so a DM to a channel name or an offline bot vanished silently (
// 2026-11-11: four posts to `to: "code"`). The route still stores and sends exactly as before; this classifier
// only describes what happened, as additive fields. `error` is set for the kinds that delivered nothing, because
// every client version prints a body `error` even on HTTP 200 (dev-sync-channel/index.js api()), so old clients
// stop saying "Sent" without an update. Pure: no registry or socket access; the route passes everything in.
//
// First match wins:
//   human        the project's human roster names `to` (the route mirrors it to Discord, unconfirmed)
//   connected    at least one live connection took the frame (connections, not seats or sessions)
//   unrecognized `to` is not a string (the route accepts any truthy value; never normalise it)
//   self         `to` is the sender's own identity: the bus never echoes a message to its sender
//   known_offline a roster bot (or a valid seat of one) or a fleet identity, with no live connection
//   channel_name `to` is a channel name, which no bot holds
//   unrecognized anything else

// The caller's own `to` is echoed back, clipped so a long value cannot bloat the response.
const clip = (s) => (s.length > 64 ? `${s.slice(0, 64)}...` : s);
const targetLabel = (to) => (typeof to === 'string' ? `"${clip(to)}"` : '"that target"');

export function directReceipt({ to, from, recipients, humanTo, rosterBots, fleet, knownChannels, seatBase }) {
  const n = Number.isFinite(recipients) ? recipients : 0;
  if (humanTo) return { recipients: n, recipientKind: 'human' };
  if (n > 0) return { recipients: n, recipientKind: 'connected' };
  const label = targetLabel(to);
  const unrecognized = {
    recipients: n,
    recipientKind: 'unrecognized',
    error: `Not delivered: ${label} is not a seat, roster bot or person this project's bus knows. It is stored, but nothing delivers it unless a seat with that name connects. dev_sync_status lists the seats; for a channel, use channel instead of to.`,
  };
  if (typeof to !== 'string') return unrecognized;
  if (to === from) {
    return {
      recipients: n,
      recipientKind: 'self',
      error: `Not delivered: ${label} is your own identity, and the bus never delivers a message back to the identity that sent it. Sessions sharing one name do not hear each other; give each its own seat with DEV_SYNC_SEAT.`,
    };
  }
  const botBase = seatBase(to);
  const known = (botBase && Array.isArray(rosterBots) && rosterBots.includes(botBase))
    || (Array.isArray(fleet) && fleet.includes(to));
  if (known) {
    return {
      recipients: n,
      recipientKind: 'known_offline',
      error: `Not delivered live: no connection that can receive it is open for ${label}. It is stored in bus history; catch-up when it reconnects is best effort and may not happen. Do not resend automatically; if it matters, post in a channel or tell the human.`,
    };
  }
  const lower = to.toLowerCase();
  if (lower === 'direct' || (knownChannels && knownChannels.has(lower))) {
    // Each text names a remedy the bus accepts: there is no postable #direct (POST /api/message refuses it), and
    // "all" is reached with dev_msg_broadcast, which every client version has.
    let error = `Not delivered: "${lower}" is a channel, not a bot or person. To post in #${lower}, send again with channel "${lower}" and no "to".`;
    if (lower === 'direct') error = 'Not delivered: "direct" is not a channel you can post in, and no bot or person has that name. For a direct message, put the recipient\'s name in "to"; to post in a channel, use channel (for example "code") and no "to".';
    if (lower === 'all') error = 'Not delivered: "all" is the all-bots channel, not a bot or person. To post to every bot, use dev_msg_broadcast.';
    return { recipients: n, recipientKind: 'channel_name', error };
  }
  return unrecognized;
}

// The route's call: a classifier failure must never turn a stored, sent DM into an error response, so it answers no
// receipt fields (today's body) and reports the failure through `warn`. `args` may be a function, so building the
// arguments (registry lookups) happens inside the guard too. `classify` is a test seam.
export function safeDirectReceipt(args, { classify = directReceipt, warn = () => {} } = {}) {
  try {
    return classify(typeof args === 'function' ? args() : args);
  } catch (err) {
    try { warn(err); } catch {}
    return {};
  }
}
