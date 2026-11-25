// People, roles and the owner list, from synapse.config.json. One module answers every "may this person do this"
// question, so the dashboard and any optional pack (Discord, batch 2) apply the same rule.
//
// Security property (kept from the live system, in general form): a human identity the config does not name is
// REFUSED, and only the configured owners (plus people given the `approver` role) may decide a card. A human proves
// who they are with a personal key whose scrypt hash is in the config; the plaintext never touches disk, so an agent
// that can read the Synapse home still cannot answer as a person.

import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export const ROLES = ['owner', 'approver', 'pingable'];
export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// A personal key travels in an HTTP header from the dashboard, so it is printable ASCII without spaces: 12 to 256 of
// the characters ! through ~. The same rule applies when it is set and when it is checked.
export const HUMAN_KEY_RE = /^[!-~]{12,256}$/;
export function humanKeyProblem(key) {
  if (typeof key !== 'string' || key.length < 12) return 'a personal key must be at least 12 characters';
  if (key.length > 256) return 'a personal key must be at most 256 characters';
  if (!HUMAN_KEY_RE.test(key)) return 'a personal key may use only printable ASCII characters without spaces (! through ~)';
  return null;
}
export function hashHumanKey(key, { salt = randomBytes(16) } = {}) {
  const problem = humanKeyProblem(key);
  if (problem) throw new Error(problem);
  const hash = scryptSync(key, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyHumanKeyHash(stored, key) {
  if (typeof stored !== 'string' || typeof key !== 'string' || !key) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n), R = Number(r), P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P) || N > 1 << 20) return false;
  const expected = Buffer.from(hashB64, 'base64');
  let got;
  try { got = scryptSync(key, Buffer.from(saltB64, 'base64'), expected.length, { N, r: R, p: P, maxmem: 256 * N * R }); }
  catch { return false; }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function createPeople(config) {
  const people = (config && config.people) || {};
  const owners = new Set(Array.isArray(config && config.owners) ? config.owners : []);
  const verified = new Map(); // name -> sha256(key) of the last key that verified, so scrypt runs once per key

  const exists = (name) => typeof name === 'string' && Object.hasOwn(people, name);
  // A person's account ids of one kind, by own property only: an inherited kind ("constructor") is never an account.
  const accountsOf = (p, kind) => (p && p.accounts && typeof p.accounts === 'object' && typeof kind === 'string' && Object.hasOwn(p.accounts, kind) ? p.accounts[kind] : undefined);
  const rolesOf = (name) => {
    if (!exists(name)) return new Set();
    const r = new Set(Array.isArray(people[name].roles) ? people[name].roles : []);
    if (owners.has(name)) r.add('owner');
    return r;
  };
  // A person with no `projects` list, or with "*", may act in every project.
  const allowedIn = (name, project) => {
    if (!exists(name)) return false;
    const list = people[name].projects;
    if (!Array.isArray(list) || list.length === 0) return true;
    return list.includes('*') || list.includes(project);
  };

  return {
    names: () => Object.keys(people),
    exists,
    isOwner: (name) => exists(name) && owners.has(name),
    rolesOf: (name) => [...rolesOf(name)],
    allowedIn,
    projectsOf: (name) => {
      if (!exists(name)) return [];
      const list = people[name].projects;
      return (!Array.isArray(list) || list.length === 0 || list.includes('*')) ? ['*'] : [...list];
    },
    // Who may decide a card in this project: owners and approvers allowed in it. Unknown names are never included.
    canAnswer: (name, project) => {
      const r = rolesOf(name);
      return (r.has('owner') || r.has('approver')) && allowedIn(name, project);
    },
    answerersFor: (project) => Object.keys(people).filter((n) => {
      const r = rolesOf(n);
      return (r.has('owner') || r.has('approver')) && allowedIn(n, project);
    }),
    // Who can answer RIGHT NOW: an answerer with a way to prove it is them (a personal key for the dashboard, or an
    // account for an enabled pack). A card nobody can reach is refused before it is parked.
    reachableAnswerersFor: (project, { providers = [] } = {}) => Object.keys(people).filter((n) => {
      const r = rolesOf(n);
      if (!((r.has('owner') || r.has('approver')) && allowedIn(n, project))) return false;
      if (typeof people[n].keyHash === 'string' && people[n].keyHash) return true;
      return providers.some((pv) => accountsOf(people[n], pv) !== undefined);
    }),
    // The @-tags a bot may use in this project: owners and pingable people allowed in it.
    pingableFor: (project) => Object.keys(people).filter((n) => {
      const r = rolesOf(n);
      return (r.has('owner') || r.has('pingable')) && allowedIn(n, project);
    }),
    humansIn: (project) => Object.keys(people).filter((n) => allowedIn(n, project)),
    // For an optional pack: map a provider account id (e.g. a Discord user id) to exactly one configured person.
    // Unknown ids and ids claimed by more than one person resolve to null; callers treat null as "refuse".
    byExternalId: (kind, id) => {
      if (id === undefined || id === null || id === '' || typeof kind !== 'string') return null;
      const hits = [];
      for (const [name, p] of Object.entries(people)) {
        const ids = accountsOf(p, kind);
        if (ids !== undefined && [].concat(ids).map(String).includes(String(id))) hits.push(name);
      }
      return hits.length === 1 ? hits[0] : null;
    },
    // True only when this exact key already verified for this person on this bus (a hash compare in memory, no scrypt).
    knownGood: (name, key) => exists(name) && typeof key === 'string' && !!key && verified.get(name) === sha(key),
    verifyKey: (name, key) => {
      if (!exists(name) || humanKeyProblem(key)) return false;
      const h = sha(key);
      if (verified.get(name) === h) return true;
      const ok = verifyHumanKeyHash(people[name].keyHash, key);
      if (ok) verified.set(name, h);
      return ok;
    },
  };
}
