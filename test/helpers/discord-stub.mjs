// A stub Discord transport for the pack tests (the interface in server/packs/discord/transport.mjs). It records every
// post, edit, reply and update, and lets a test deliver messages and button taps as Discord would. Nothing here opens a
// socket: the pack under test never contacts Discord.
//
// Every id is a made-up snowflake; none is a real account or channel.

export const BOT_ID = '700000000000000001';
export const ids = {
  owner: '700000000000000101',
  approverBeta: '700000000000000102',
  pingable: '700000000000000103',
  stranger: '700000000000000199',
  alphaCode: '700000000000000201',
  alphaBuild: '700000000000000202',
  betaCode: '700000000000000203',
  unmapped: '700000000000000299',
};
const EPOCH = 1420070400000n;
// A made-up bot token with the real shape (an application id, then two random parts), built at run time so no source
// file holds token-shaped text.
export function fakeToken() {
  const r = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) % 251)).toString('base64url');
  return [Buffer.from(BOT_ID).toString('base64url'), r(5), r(24)].join('.');
}
let counter = 0n;
// An interaction id made `ageMs` ago, as Discord would issue it.
export function interactionId(ageMs = 0) {
  return String(((BigInt(Date.now() - ageMs) - EPOCH) << 22n) | (counter++ & 0xfffn));
}

export function createStubTransport() {
  let seq = 0n;
  const t = {
    posts: [], edits: [], replies: [], updates: [], started: 0, stopped: 0, isConnected: true,
    msgFns: [], btnFns: [],
    async start() { t.started++; },
    async stop() { t.stopped++; },
    connected: () => t.isConnected,
    botUserId: () => BOT_ID,
    onMessage(fn) { t.msgFns.push(fn); },
    onButton(fn) { t.btnFns.push(fn); },
    failNext: null, // an Error the next send or edit throws, as discord.js would
    async send(channelId, payload) {
      if (t.failNext) { const e = t.failNext; t.failNext = null; throw e; }
      const id = String(800000000000000000n + (seq++));
      t.posts.push({ channelId, id, ...payload });
      return { id };
    },
    async edit(channelId, messageId, payload) { if (t.failNext) { const e = t.failNext; t.failNext = null; throw e; } t.edits.push({ channelId, messageId, ...payload }); },
    // Deliver a message as the gateway would.
    async message({ channelId, authorId, content, authorIsBot = false, webhookId = null, system = false }) {
      for (const fn of t.msgFns) await fn({ id: interactionId(), channelId, authorId, authorIsBot, webhookId, system, content });
    },
    // Deliver a button tap. Returns the interaction id used.
    async tap({ userId, customId, channelId, messageId = null, messageAuthorId = BOT_ID, id = interactionId() }) {
      const b = {
        id, customId, userId, channelId, messageId, messageAuthorId,
        reply: async (text) => { t.replies.push({ id, text }); },
        update: async (p) => { t.updates.push({ id, ...p }); },
      };
      for (const fn of t.btnFns) await fn(b);
      return id;
    },
    customIds(post) {
      return (post.components || []).flatMap((row) => row.components.map((c) => c.custom_id));
    },
    reset() { t.posts.length = 0; t.edits.length = 0; t.replies.length = 0; t.updates.length = 0; },
  };
  return t;
}
