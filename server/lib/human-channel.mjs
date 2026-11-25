// The human-channel boundary: how the core bus reaches people, and how a person's answer comes back.
//
// The core ships one implementation, the dashboard channel: cards and notifications wait on the local dashboard, and a
// configured person answers there with their personal key. The optional Discord pack (server/packs/discord/) plugs in
// behind the same interface. The core loads a pack only when its config switch is on, with a dynamic import, so the
// core never imports discord.js.
//
// The rule for every decision: the pack reports facts it verified (which account acted, on which of its surfaces);
// the CORE decides who that is and whether they may. Nothing in a pack decides who may answer.
//
// A pack module exports:
//
//   export async function createHumanChannel(ctx) -> HumanChannel
//
// ctx (frozen; the pack gets views, never the core's own objects):
//   config        a deep-frozen copy of synapse.config.json without key hashes; the pack reads its block, e.g. config.discord
//   registry      a deep-frozen copy of projects.json
//   secret        the value of the pack's own credential (the variable config.discord.tokenEnv names, from the environment
//                 or <home>/.env), or null; no other key reaches the pack. Never logged or posted.
//   people        { canAnswer(name, project), isOwner(name), allowedIn(name, project), pingableFor(project),
//                   answerersFor(project), resolveAccount(provider, accountId) -> name | null }
//   answerAskByAccount({ provider, accountId, askId, optionIndex, project }) -> { ok, status, error?, delivered?, label?, answeredBy? }
//                 the pack passes the provider ('discord'), the account id IT VERIFIED (the interaction's user id, never a
//                 display name), the button's option index, and the project its surface belongs to (the project of the
//                 channel the click came from). A provider the channel did not list in `providers` is refused
//                 ('undeclared_provider'). The core resolves exactly one configured person (unknown or ambiguous ids are
//                 refused), refuses a click from another project's surface ('wrong_project'), checks that person may
//                 answer in the CARD's project, takes the label from the parked card by index (never from the pack),
//                 checks the card is still open, then delivers the answer once. The dashboard uses the same rule.
//                 (`label` instead of `optionIndex` is accepted for a pack whose surface carries labels.)
//   postAsPerson({ provider, accountId, project, channel, content }) -> { ok, id?, error? }
//                 a person's message arriving from the pack, posted under that person's name after the same
//                 provider check and lookup, only into a project that person is allowed in
//   cardRefs      { set(askId, refs[]), get(askId) -> refs[] | null }: where the pack posted a card (its own message ids),
//                 stored with the card so an edit still finds it after a restart. Not used for any decision.
//   redact(text) -> text with every key the bus knows, and anything shaped like a credential, replaced by [redacted].
//                 A pack runs every text it sends off the machine through it.
//   log(line)
//
// HumanChannel (validated by loadHumanChannel; a missing optional method gets a default):
//   name: string                                                       required
//   providers: string[]                                                account kinds it can verify, e.g. ['discord']
//   start(): Promise<void>, stop(): Promise<void>
//   reaches(project) -> boolean                                        can it put a card for this project in front of a
//                                                                      person right now? (default true)
//   status() -> object                                                 shown in /api/health, e.g. { connected: true }
//   deliverAsk(card) -> Promise<{ delivery: 'posted' | 'dashboard' | 'unknown', mentioned?: boolean }>
//       card = { askId, project, askingSeat, question, options, context?, recommendation?, series?, answerers }
//   askClosed({ askId, project, label, answeredBy, via }) -> void      (edit or close the card on the pack's surface)
//   notify({ project, sender, message, tags, priority }) -> Promise<{ delivered: boolean, via: string, dm?: object }>
//   relayMessage(msg) -> void                                          (mirror a channel post; fire and forget)

const OPTIONAL = {
  start: async () => {},
  stop: async () => {},
  reaches: () => true,
  status: () => ({}),
  deliverAsk: async () => ({ delivery: 'unknown' }),
  askClosed: () => {},
  notify: async () => ({ delivered: false, via: 'none' }),
  relayMessage: () => {},
};

// The core's own channel: nothing is pushed anywhere; the dashboard reads the open cards and notifications from the bus.
export function createDashboardChannel() {
  return normalizeChannel({
    name: 'dashboard',
    providers: [],
    async deliverAsk() { return { delivery: 'dashboard' }; },
    async notify() { return { delivered: false, via: 'dashboard' }; },
  });
}

// Check the contract and return a frozen channel with every method present.
export function normalizeChannel(ch) {
  if (!ch || typeof ch !== 'object') throw new Error('the human channel is not an object');
  if (typeof ch.name !== 'string' || !ch.name) throw new Error('the human channel has no name');
  if (ch.providers !== undefined && (!Array.isArray(ch.providers) || ch.providers.some((p) => typeof p !== 'string' || !p))) {
    throw new Error(`human channel "${ch.name}": providers must be a list of account kinds`);
  }
  const out = { name: ch.name, providers: Object.freeze([...(ch.providers || [])]) };
  for (const [method, fallback] of Object.entries(OPTIONAL)) {
    if (ch[method] === undefined) out[method] = fallback;
    else if (typeof ch[method] !== 'function') throw new Error(`human channel "${ch.name}": ${method} must be a function`);
    else out[method] = ch[method].bind(ch);
  }
  return Object.freeze(out);
}

// Load the channel the config asks for. A pack that is switched on but missing stops the boot with a clear message.
export async function loadHumanChannel(config, ctx, { importer = (spec) => import(spec) } = {}) {
  if (config.discord && config.discord.enabled === true) {
    let mod;
    try {
      mod = await importer(new URL('../packs/discord/index.mjs', import.meta.url).href);
    } catch (err) {
      const e = new Error('discord.enabled is true, but the Discord pack is not installed in this build. Set "discord": { "enabled": false } in synapse.config.json, or install the pack.');
      e.cause = err;
      throw e;
    }
    if (!mod || typeof mod.createHumanChannel !== 'function') throw new Error('the Discord pack does not export createHumanChannel(ctx)');
    return normalizeChannel(await mod.createHumanChannel(ctx));
  }
  return createDashboardChannel();
}
