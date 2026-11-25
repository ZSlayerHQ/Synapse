// Identity binding: which names a presented credential may assert. Ported from the live bus's auth core; the rules are
// the same except where noted (v2 is stricter: a project key never asserts a person, and enforcement is always on).
//
// Principals (exactly one per request):
//   project key   -> may assert a bot in the project's assertableBots (or a seat of one, `<bot>.<suffix>`);
//                    a bot whose roster entry names its own keyEnv may only be asserted with that bot's own key
//   per-bot key   -> may assert ONLY that bot (or a seat of it)
//   human         -> a configured person, authenticated by their personal key; may assert ONLY their own name, and only
//                    in projects they are allowed in
// Pseudo-emitters (the system sender, 'dashboard', 'unknown') are never assertable by a client: the server's own
// in-process sends set them directly and never pass through this gate.

export const ACTOR_FIELDS = ['developer', 'sender', 'from', 'createdBy', 'initiator', 'updatedBy', 'reviewer'];

// A seat is `<base>.<suffix>`: parallel sessions of one bot. Auth resolves the base; delivery keys on the full name.
// Fail-closed: at most one dot, suffix [a-z0-9][a-z0-9_-]{0,23}; anything else is null and every branch rejects it.
export function seatBase(name) {
  if (typeof name !== 'string' || !name.length) return null;
  const dot = name.indexOf('.');
  if (dot === -1) return name;
  const base = name.slice(0, dot);
  const suffix = name.slice(dot + 1);
  if (!base.length || !/^[a-z0-9][a-z0-9_-]{0,23}$/.test(suffix)) return null;
  return base;
}

// ABSENT (missing/null/undefined) -> the handler's server-side default applies. PRESENT-INVALID (array, object, number,
// boolean, empty string) -> reject, never skip: a skipped non-string would later be stringified into an actor position.
export function isAbsentActor(v) { return v === undefined || v === null; }
export function isPresentInvalidActor(v) { return typeof v !== 'string' || v.length === 0; }

export function createAuth({ registry, env = process.env, people }) {
  const projects = () => registry.projects || {};

  function projectKey(projectId) {
    const p = projects()[projectId];
    const v = p && p.keyEnv ? env[p.keyEnv] : undefined;
    return v || null; // no global fallback in v2: a project without its own key cannot authenticate
  }

  function matchBotKey(projectId, key) {
    if (!key) return null;
    const p = projects()[projectId];
    if (!p) return null;
    const roster = p.roster || {};
    for (const name of p.assertableBots || []) {
      const ke = roster[name] && roster[name].keyEnv;
      const val = ke && env[ke];
      if (val && key === val) return name;
    }
    return null;
  }

  function bindIdentity(authProject, name, req) {
    if (isAbsentActor(name)) return true;
    if (isPresentInvalidActor(name)) return false;
    const proj = projects()[authProject];
    if (!proj) return false;
    const bots = proj.assertableBots || [];
    const presentedKey = req && req.headers && req.headers['x-dev-key'];
    if (req && req.humanPrincipal) {
      return name === req.humanPrincipal && people.allowedIn(name, authProject);
    }
    if (req && req.botPrincipal) return seatBase(name) === req.botPrincipal;
    const botBase = seatBase(name);
    if (botBase && bots.includes(botBase)) {
      const ke = proj.roster && proj.roster[botBase] && proj.roster[botBase].keyEnv;
      const botKeyVal = ke && env[ke];
      if (botKeyVal) return presentedKey === botKeyVal;
      return true;
    }
    return false; // includes every person name: a project key is a bot credential
  }

  function extractAssertedActors(body) {
    const names = [];
    for (const f of ACTOR_FIELDS) {
      if (!body || typeof body !== 'object' || !(f in body)) continue;
      const v = body[f];
      if (isAbsentActor(v)) continue;
      if (isPresentInvalidActor(v)) return { reject: true };
      names.push(v);
    }
    return { names };
  }

  // Validate EVERY present actor field (not the first match), so a valid decoy in one field cannot carry a spoof in another.
  function rejectForgedActor(req) {
    const asserted = extractAssertedActors(req.body);
    if (asserted.reject) return true;
    return asserted.names.some((n) => !bindIdentity(req.authProject, n, req));
  }

  // A secondary actor ("X did this to a resource owned by Y", e.g. updatedBy on a task) binds to the resource's owner.
  function bindSecondaryActor(authProject, claimedName, resourceOwner, presentedKey) {
    if (isAbsentActor(claimedName)) return true;
    if (isPresentInvalidActor(claimedName)) return false;
    const proj = projects()[authProject];
    const ke = proj && proj.roster && proj.roster[claimedName] && proj.roster[claimedName].keyEnv;
    const botKeyVal = ke && env[ke];
    if (botKeyVal) return presentedKey === botKeyVal;
    if (!resourceOwner) return !!(proj && (proj.assertableBots || []).includes(claimedName));
    return claimedName === resourceOwner;
  }

  return { projectKey, matchBotKey, bindIdentity, extractAssertedActors, rejectForgedActor, bindSecondaryActor };
}
