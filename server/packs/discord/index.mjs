// The Discord pack: an optional human channel (server/lib/human-channel.mjs) that mirrors project channels to
// Discord channels both ways, posts decision cards with buttons, and turns notifications into pings.
//
// Loaded by the core only when synapse.config.json has "discord": { "enabled": true }. It decides nothing about
// people: it reports what Discord verified (the account that sent a message or tapped a button, and the channel it
// was in) and the core resolves that account to one configured person and checks their role and project.
//
// What the pack itself enforces, before it asks the core:
//   - only mapped channels count; everything else Discord sends is ignored;
//   - a message from a bot, a webhook or the system is never posted to the bus (this also stops relay loops);
//   - a tap counts only on the exact message this bot posted for that card, in that card's channel, once per
//     interaction id, and only while it is fresh;
//   - every text it posts goes through ctx.redact field by field before any clipping, and no post can ping anyone
//     except the people it names;
//   - its log lines are fixed text plus an allowlisted error category: never an external error message or an id.

import { createDiscordJsTransport } from './transport.mjs';
import {
  parseCustomId, snowflakeTime, buildCardMessage, buildClosedCardText, buildRelayText, buildNotifyText,
  refusalText, storedQuestion, errorCategory,
} from './text.mjs';

const PROVIDER = 'discord';
const TAP_MAX_AGE_MS = 15 * 60 * 1000; // Discord's own limit for answering an interaction
const SEEN_MAX = 5000;
const RELAY_IN_FLIGHT_MAX = 50;

export async function createHumanChannel(ctx, { transport: injected = null, importer } = {}) {
  const log = (line) => { try { ctx.log(line); } catch {} };
  const d = (ctx.config && ctx.config.discord) || {};
  const redact = typeof ctx.redact === 'function' ? ctx.redact : (s) => String(s ?? '');

  // Routes, from config (checked by the core: each Discord channel belongs to one project and one bus channel).
  const out = new Map(); // `${project}|${busChannel}` -> Discord channel id
  const inbound = new Map(); // Discord channel id -> { project, channel }
  const cardsChannel = new Map(); // project -> Discord channel id
  for (const [project, p] of Object.entries(d.projects || {})) {
    const chans = (p && p.channels) || {};
    for (const [busChannel, id] of Object.entries(chans)) {
      out.set(`${project}|${busChannel}`, id);
      inbound.set(id, { project, channel: busChannel });
    }
    const cardsOn = (p && p.cards) || (chans.code ? 'code' : Object.keys(chans)[0]);
    if (cardsOn && chans[cardsOn]) cardsChannel.set(project, chans[cardsOn]);
  }
  const accountOf = (personName) => {
    const p = ctx.config.people && ctx.config.people[personName];
    const ids = p && p.accounts && p.accounts[PROVIDER];
    const first = [].concat(ids || [])[0];
    return typeof first === 'string' ? first : null;
  };
  const mentionIdsFor = (names) => [...new Set((names || []).map(accountOf).filter(Boolean))];

  if (!injected && !ctx.secret) throw new Error(`discord.enabled is true but the bot token is missing (${d.tokenEnv || 'SYNAPSE_DISCORD_TOKEN'} in <home>/.env); run "synapse discord setup"`);
  const transport = injected || await createDiscordJsTransport({ token: ctx.secret, log, importer });

  const seen = new Map(); // interaction id -> time handled (a redelivered or replayed tap is refused)
  const tapping = new Set(); // askIds being closed by a tap: that tap edits the message itself
  let inFlight = 0;

  function remember(id) {
    seen.set(id, Date.now());
    if (seen.size > SEEN_MAX) for (const k of seen.keys()) { seen.delete(k); if (seen.size <= SEEN_MAX / 2) break; }
  }

  transport.onMessage((m) => {
    const route = m && inbound.get(m.channelId);
    if (!route) return; // not a mapped channel
    if (m.authorIsBot || m.webhookId || m.system) return; // bots, webhooks (our own posts too) never come back in
    const content = String(m.content || '').trim();
    if (!content) return;
    const r = ctx.postAsPerson({ provider: PROVIDER, accountId: m.authorId, project: route.project, channel: route.channel, content: content.slice(0, 4000) });
    if (!r.ok) log(`[discord] refused a message in ${route.project} #${route.channel} (${r.error}): its author is not a configured person allowed in that project`);
  });

  transport.onButton(async (b) => {
    const refuse = async (error) => {
      log(`[discord] refused a tap (${error})`);
      try { await b.reply(refusalText(error)); } catch {}
    };
    if (!b || typeof b.id !== 'string' || seen.has(b.id)) { log('[discord] ignored a tap already handled (replayed interaction)'); return; }
    remember(b.id);
    const born = snowflakeTime(b.id);
    if (born === null || Date.now() - born > TAP_MAX_AGE_MS || born - Date.now() > 60_000) return refuse('stale');
    const bot = transport.botUserId();
    if (!bot || b.messageAuthorId !== bot) return refuse('not_ours');
    const route = inbound.get(b.channelId);
    if (!route) return refuse('not_ours');
    const parsed = parseCustomId(b.customId);
    if (!parsed) return refuse('not_ours');
    // The tap must be on the exact message this pack posted for that card, in its channel. A card whose post is not
    // registered yet (a tap racing the post) is refused; the person taps again.
    const ref = (ctx.cardRefs.get(parsed.askId) || [])[0];
    if (!ref || ref.channelId !== b.channelId || ref.messageId !== b.messageId) return refuse('not_registered');
    tapping.add(parsed.askId);
    let r;
    try { r = ctx.answerAskByAccount({ provider: PROVIDER, accountId: b.userId, askId: parsed.askId, optionIndex: parsed.optionIndex, project: route.project }); }
    finally { tapping.delete(parsed.askId); }
    if (!r.ok) return refuse(r.error);
    try { await b.update({ content: buildClosedCardText({ question: ref.question, label: r.label, answeredBy: r.answeredBy, redact }), components: [] }); }
    catch (e) { log(`[discord] the answered card could not be updated (${errorCategory(e)}); the answer was delivered`); }
  });

  const reaches = (project) => cardsChannel.has(project) && transport.connected();

  return {
    name: 'discord',
    providers: [PROVIDER],
    async start() { await transport.start(); },
    async stop() { await transport.stop(); },
    reaches,
    status: () => ({ connected: transport.connected() }),

    async deliverAsk(card) {
      if (!reaches(card.project)) return { delivery: 'dashboard' };
      const mentionIds = mentionIdsFor(card.answerers);
      const msg = buildCardMessage(card, { mentionIds, redact });
      const channelId = cardsChannel.get(card.project);
      try {
        const posted = await transport.send(channelId, msg);
        // Stored with the card: where it is (a tap must match it), and the question already redacted and clipped.
        ctx.cardRefs.set(card.askId, [{ channelId, messageId: posted.id, question: storedQuestion(card.question, redact) }]);
        return { delivery: 'posted', mentioned: mentionIds.length > 0 };
      } catch (e) {
        log(`[discord] a card could not be posted (${errorCategory(e)}); it waits on the dashboard`);
        return { delivery: 'dashboard' };
      }
    },

    askClosed({ askId, label, answeredBy }) {
      if (tapping.has(askId)) return; // the tap that closed it updates the message itself
      const ref = (ctx.cardRefs.get(askId) || [])[0];
      if (!ref || !ref.channelId || !ref.messageId) return;
      transport.edit(ref.channelId, ref.messageId, { content: buildClosedCardText({ question: ref.question, label, answeredBy, redact }), components: [] })
        .catch((e) => log(`[discord] a closed card could not be edited (${errorCategory(e)})`));
    },

    async notify({ project, sender, message, tags, priority }) {
      if (!reaches(project)) return { delivered: false, via: 'dashboard' };
      const mentionIds = mentionIdsFor(tags);
      try {
        await transport.send(cardsChannel.get(project), { content: buildNotifyText({ sender, message, priority }, { mentionIds, redact }), components: [], allowedMentions: { users: mentionIds } });
        return { delivered: mentionIds.length > 0, via: 'discord' };
      } catch (e) {
        log(`[discord] a notification could not be posted (${errorCategory(e)})`);
        return { delivered: false, via: 'dashboard' };
      }
    },

    relayMessage(msg) {
      if (!msg || (msg.meta && msg.meta.via === PROVIDER)) return; // it came from Discord: never echo it back
      // Only a mapped bus channel is mirrored. A project broadcast ("all") has no mapping and stays on the bus.
      const channelId = out.get(`${msg.project}|${msg.channel}`);
      if (!channelId || !transport.connected()) return;
      if (inFlight >= RELAY_IN_FLIGHT_MAX) { log('[discord] relay is behind; a message was not mirrored'); return; }
      inFlight++;
      // A file announcement is mirrored as its first line (name and caption) only: never the inline preview of its content.
      const shown = msg.meta && msg.meta.type === 'file' ? { ...msg, content: String(msg.content || '').split('\n')[0] } : msg;
      transport.send(channelId, { content: buildRelayText(shown, { redact }), components: [], allowedMentions: { parse: [] } })
        .catch((e) => log(`[discord] relay failed (${errorCategory(e)})`))
        .finally(() => { inFlight--; });
    },
  };
}
