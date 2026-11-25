// The one file that talks to discord.js. It is imported only when discord.enabled is true, and it loads discord.js
// itself with a dynamic import, so a missing optional dependency is a clear boot error and the core never loads it.
//
// The pack talks to a small transport, so the tests can put a stub in its place and never contact Discord:
//   start(), stop(), connected() -> boolean, botUserId() -> string | null
//   onMessage(fn)  fn({ id, channelId, authorId, authorIsBot, webhookId, system, content })
//   onButton(fn)   fn({ id, customId, userId, channelId, messageId, messageAuthorId, reply(text), update({ content, components }) })
//   send(channelId, { content, components, allowedMentions }) -> Promise<{ id }>
//   edit(channelId, messageId, { content, components }) -> Promise<void>

import { errorCategory } from './text.mjs';

export const MISSING_PACKAGES = 'discord.enabled is true, but the discord.js package is not installed. Install the optional dependencies (run "npm install" in the Synapse source folder, then "synapse init" again), or set "discord": { "enabled": false } in synapse.config.json.';

export async function loadDiscordJs(importer = (spec) => import(spec)) {
  try {
    const mod = await importer('discord.js');
    const djs = mod && (mod.Client ? mod : mod.default);
    if (!djs || typeof djs.Client !== 'function') throw new Error('discord.js has no Client export');
    return djs;
  } catch (err) {
    const e = new Error(MISSING_PACKAGES);
    e.cause = err;
    throw e;
  }
}

export async function createDiscordJsTransport({ token, log, importer }) {
  const djs = await loadDiscordJs(importer);
  const { Client, GatewayIntentBits, Events, MessageFlags } = djs;
  const messageFns = [];
  const buttonFns = [];
  let client = null;
  let stopping = false;
  const safe = (fn, arg) => { Promise.resolve().then(() => fn(arg)).catch((e) => log(`[discord] a handler failed (${errorCategory(e)})`)); };

  async function channelFor(channelId) {
    const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (!ch || typeof ch.isTextBased !== 'function' || !ch.isTextBased() || typeof ch.send !== 'function') throw Object.assign(new Error('not a text channel the bot can post in'), { code: 'NOT_TEXT_CHANNEL' });
    return ch;
  }

  return {
    async start() {
      stopping = false;
      // Guilds: the channel cache. GuildMessages + MessageContent (a privileged intent, switched on in the Developer
      // Portal): read what people type in the mapped channels. Nothing else.
      client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
        allowedMentions: { parse: [] },
      });
      client.on(Events.MessageCreate, (m) => {
        const msg = { id: m.id, channelId: m.channelId, authorId: m.author && m.author.id, authorIsBot: !!(m.author && m.author.bot), webhookId: m.webhookId || null, system: !!m.system, content: m.content || '' };
        for (const fn of messageFns) safe(fn, msg);
      });
      client.on(Events.InteractionCreate, (i) => {
        if (!i.isButton || !i.isButton()) return;
        const b = {
          id: i.id, customId: i.customId, userId: i.user && i.user.id, channelId: i.channelId,
          messageId: i.message && i.message.id, messageAuthorId: i.message && i.message.author && i.message.author.id,
          reply: (text) => i.reply({ content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }),
          update: ({ content, components }) => i.update({ content, components, allowedMentions: { parse: [] } }),
        };
        for (const fn of buttonFns) safe(fn, b);
      });
      client.on(Events.ClientReady, () => log('[discord] connected'));
      client.on(Events.Error, (e) => log(`[discord] client error (${errorCategory(e)})`));
      client.on(Events.ShardDisconnect, () => { if (!stopping) log('[discord] disconnected; discord.js reconnects on its own'); });
      // The bus does not wait for Discord: a bad token or no network is logged and shown in /api/health and the doctor.
      client.login(token).catch((e) => log(`[discord] login failed (${errorCategory(e)}); check the bot token (synapse discord setup --new-token) and the Message Content intent`));
    },
    async stop() {
      stopping = true;
      if (client) { try { await client.destroy(); } catch {} client = null; }
    },
    connected: () => !!(client && client.isReady()),
    botUserId: () => (client && client.user ? client.user.id : null),
    onMessage(fn) { messageFns.push(fn); },
    onButton(fn) { buttonFns.push(fn); },
    async send(channelId, { content, components, allowedMentions }) {
      const ch = await channelFor(channelId);
      const m = await ch.send({ content, components: components || [], allowedMentions: allowedMentions || { parse: [] } });
      return { id: m.id };
    },
    async edit(channelId, messageId, { content, components }) {
      const ch = await channelFor(channelId);
      await ch.messages.edit(messageId, { content, components: components || [], allowedMentions: { parse: [] } });
    },
  };
}
