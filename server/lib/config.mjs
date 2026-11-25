// Load and check synapse.config.json and projects.json. Pure checks (checkConfig, checkRegistry) return findings so
// the server's boot, `synapse doctor` and the tests share one rule set. A finding with level 'fatal' stops the boot.

import fs from 'node:fs';
import { DEFAULT_HOST, DEFAULT_PORT, readJson } from './home.mjs';
import { NAME_RE, ROLES } from './people.mjs';

export const DEFAULT_CHANNELS = ['code', 'build', 'qa', 'reports', 'tasks', 'alerts'];
export const RESERVED_CHANNELS = ['all', 'direct'];
export const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const BOT_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
export const MIN_KEY_LENGTH = 24;
// Discord ids (users, channels) are snowflakes: 17 to 20 digits.
export const DISCORD_ID_RE = /^\d{17,20}$/;
export const DEFAULT_DISCORD_TOKEN_ENV = 'SYNAPSE_DISCORD_TOKEN';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fatal = (message) => ({ level: 'fatal', message });
const warn = (message) => ({ level: 'warn', message });

// Defaults applied to a config that passed checkConfig. Never invents people or owners.
export function withDefaults(config) {
  const c = { ...config };
  c.server = { host: DEFAULT_HOST, port: DEFAULT_PORT, ...(isObj(config.server) ? config.server : {}) };
  c.channels = Array.isArray(config.channels) && config.channels.length ? [...config.channels] : [...DEFAULT_CHANNELS];
  c.corsOrigins = Array.isArray(config.corsOrigins) ? [...config.corsOrigins] : [];
  c.systemSender = typeof config.systemSender === 'string' && config.systemSender ? config.systemSender : 'synapse';
  c.discord = { enabled: false, tokenEnv: DEFAULT_DISCORD_TOKEN_ENV, projects: {}, ...(isObj(config.discord) ? config.discord : {}) };
  c.dashboard = { public: false, ...(isObj(config.dashboard) ? config.dashboard : {}) };
  c.people = isObj(config.people) ? config.people : {};
  c.owners = Array.isArray(config.owners) ? config.owners : [];
  return c;
}

export function checkConfig(config) {
  const f = [];
  if (!isObj(config)) return [fatal('synapse.config.json must be a JSON object')];
  if (config.version !== 2) f.push(fatal('synapse.config.json: "version" must be 2'));
  if (config.server !== undefined) {
    if (!isObj(config.server)) f.push(fatal('"server" must be an object'));
    else {
      const { port, host, allowRemote, allowedHosts } = config.server;
      if (allowRemote !== undefined && typeof allowRemote !== 'boolean') f.push(fatal('"server.allowRemote" must be true or false'));
      if (allowedHosts !== undefined && (!Array.isArray(allowedHosts) || allowedHosts.some((h) => typeof h !== 'string' || !/^[A-Za-z0-9.:-]+$/.test(h)))) f.push(fatal('"server.allowedHosts" must be a list of host names (optionally with :port)'));
      if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) f.push(fatal('"server.port" must be an integer from 1 to 65535'));
      if (host !== undefined && (typeof host !== 'string' || !host)) f.push(fatal('"server.host" must be a non-empty string'));
      if (allowRemote === true && !(Array.isArray(allowedHosts) && allowedHosts.length)) f.push(fatal('"server.allowRemote" is true but "server.allowedHosts" is empty. List the host names the bus is reached by (for example the TLS proxy\'s name); every other Host header is refused.'));
      if (typeof host === 'string' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
        if (allowRemote !== true) f.push(fatal(`"server.host" is ${host}, which other machines can reach. Keep 127.0.0.1, or set "server.allowRemote": true and put a TLS proxy in front: keys travel in plain HTTP headers.`));
        else f.push(warn(`"server.host" is ${host}: the bus is reachable from other machines. Serve it only behind TLS on a private network.`));
      }
    }
  }
  const people = config.people;
  if (!isObj(people)) f.push(fatal('"people" must be an object of name -> { roles, projects, keyHash }'));
  else {
    const seenAccounts = new Map();
    const discordOn = isObj(config.discord) && config.discord.enabled === true; // a bad Discord id stops the boot only when the pack is on
    for (const [name, p] of Object.entries(people)) {
      if (!NAME_RE.test(name)) f.push(fatal(`person "${name}": names are lowercase letters, digits, "_" or "-", starting with a letter, at most 32`));
      if (!isObj(p)) { f.push(fatal(`person "${name}" must be an object`)); continue; }
      if (p.roles !== undefined && (!Array.isArray(p.roles) || p.roles.some((r) => !ROLES.includes(r)))) f.push(fatal(`person "${name}": roles must be a list of ${ROLES.join(', ')}`));
      if (p.projects !== undefined && (!Array.isArray(p.projects) || p.projects.some((x) => typeof x !== 'string'))) f.push(fatal(`person "${name}": projects must be a list of project ids or "*"`));
      if (p.keyHash !== undefined && (typeof p.keyHash !== 'string' || !p.keyHash.startsWith('scrypt$'))) f.push(fatal(`person "${name}": keyHash must be a value written by "synapse set-human-key"`));
      if (p.accounts !== undefined && !isObj(p.accounts)) f.push(fatal(`person "${name}": accounts must be an object (for example { "discord": "<user id>" })`));
      else if (isObj(p.accounts)) {
        for (const [kind, ids] of Object.entries(p.accounts)) {
          for (const id of [].concat(ids)) {
            if (typeof id !== 'string' || !id) { f.push(fatal(`person "${name}": accounts.${kind} must be a non-empty string or a list of them`)); continue; }
            if (kind === 'discord' && !DISCORD_ID_RE.test(id)) { f.push((discordOn ? fatal : warn)(`person "${name}": accounts.discord must be a Discord user id (17 to 20 digits; Discord: User Settings > Advanced > Developer Mode, then right-click your name > Copy User ID)`)); continue; }
            const k = `${kind}:${id}`;
            if (seenAccounts.has(k)) f.push(fatal(`accounts.${kind}: one id is listed for both "${seenAccounts.get(k)}" and "${name}"; an account must map to one person`));
            else seenAccounts.set(k, name);
          }
        }
      }
    }
  }
  if (!Array.isArray(config.owners) || config.owners.length === 0) f.push(fatal('"owners" must list at least one person: owners decide cards, and an unknown person is always refused'));
  else for (const o of config.owners) if (!isObj(people) || !Object.prototype.hasOwnProperty.call(people, o)) f.push(fatal(`owner "${o}" is not in "people"`));
  if (isObj(people) && Array.isArray(config.owners) && config.owners.length && !config.owners.some((o) => people[o] && people[o].keyHash)) {
    f.push(warn('no owner has a key yet (run "synapse set-human-key <name>" in your own terminal); until one does, nobody can answer a card on the dashboard'));
  }
  if (config.channels !== undefined) {
    if (!Array.isArray(config.channels) || config.channels.some((c) => typeof c !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(c))) f.push(fatal('"channels" must be a list of lowercase channel names'));
    else for (const c of config.channels) if (RESERVED_CHANNELS.includes(c)) f.push(fatal(`channel "${c}" is reserved`));
  }
  if (config.corsOrigins !== undefined && (!Array.isArray(config.corsOrigins) || config.corsOrigins.some((o) => typeof o !== 'string' || !/^https?:\/\/[^/\s]+$/.test(o)))) {
    f.push(fatal('"corsOrigins" must be a list of origins such as "http://localhost:3000" (scheme, host, optional port; no path)'));
  }
  if (config.systemSender !== undefined && (typeof config.systemSender !== 'string' || !BOT_RE.test(config.systemSender))) f.push(fatal('"systemSender" must be a lowercase name'));
  return f;
}

// The registry is checked together with the config (default/admin project, name clashes) and the environment (keys).
export function checkRegistry(registry, config, env = process.env) {
  const f = [];
  if (!isObj(registry) || !isObj(registry.projects)) return [fatal('projects.json must be an object with a "projects" object')];
  const ids = Object.keys(registry.projects);
  const people = isObj(config && config.people) ? Object.keys(config.people) : [];
  const systemSender = (config && config.systemSender) || 'synapse';
  const keyOwners = new Map(); // key value -> label (values never printed)
  const noteKey = (envName, label) => {
    if (!envName) return;
    if (!ENV_NAME_RE.test(envName)) { f.push(fatal(`${label}: keyEnv "${envName}" is not a valid environment variable name`)); return; }
    const v = env[envName];
    if (!v) { f.push(fatal(`${label}: ${envName} is not set (in the environment or <home>/.env)`)); return; }
    if (v.length < MIN_KEY_LENGTH) f.push(fatal(`${label}: ${envName} is shorter than ${MIN_KEY_LENGTH} characters`));
    if (keyOwners.has(v)) f.push(fatal(`${label}: ${envName} has the same value as ${keyOwners.get(v)}; every key must be unique`));
    else keyOwners.set(v, `${label} (${envName})`);
  };
  if (ids.length === 0) f.push(warn('projects.json has no projects yet (run "synapse add-project <dir>")'));
  for (const id of ids) {
    const p = registry.projects[id];
    if (!PROJECT_RE.test(id)) f.push(fatal(`project "${id}": ids are lowercase letters, digits, "_" or "-", at most 48`));
    if (!isObj(p)) { f.push(fatal(`project "${id}" must be an object`)); continue; }
    if (!p.keyEnv) f.push(fatal(`project "${id}": "keyEnv" is required (a project with no key could not authenticate)`));
    noteKey(p.keyEnv, `project "${id}"`);
    const bots = Array.isArray(p.assertableBots) ? p.assertableBots : [];
    if (p.assertableBots !== undefined && !Array.isArray(p.assertableBots)) f.push(fatal(`project "${id}": assertableBots must be a list`));
    for (const b of bots) {
      if (typeof b !== 'string' || !BOT_RE.test(b)) f.push(fatal(`project "${id}": bot name "${b}" is not valid`));
      if (people.includes(b)) f.push(fatal(`project "${id}": bot "${b}" has the same name as a person; a bot must never be able to post as a person`));
      if (b === systemSender) f.push(fatal(`project "${id}": bot "${b}" uses the system sender name`));
    }
    for (const [bot, r] of Object.entries(isObj(p.roster) ? p.roster : {})) if (isObj(r) && r.keyEnv) noteKey(r.keyEnv, `project "${id}" bot "${bot}"`);
    if (p.sharedFiles !== undefined && (!Array.isArray(p.sharedFiles) || p.sharedFiles.some((s) => typeof s !== 'string'))) f.push(fatal(`project "${id}": sharedFiles must be a list of paths`));
  }
  // Cross-project service keys ("super-scopes") are not part of this release: every key belongs to one project.
  if (isObj(registry.superScopes) && Object.keys(registry.superScopes).length) f.push(fatal('projects.json: "superScopes" are not supported in this version; remove them (people read across their projects with their personal key)'));
  if (config) {
    if (config.defaultProject !== undefined && !registry.projects[config.defaultProject]) f.push(fatal(`defaultProject "${config.defaultProject}" is not in projects.json`));
    if (config.adminProject !== undefined && !registry.projects[config.adminProject]) f.push(fatal(`adminProject "${config.adminProject}" is not in projects.json`));
    for (const [name, p] of Object.entries(isObj(config.people) ? config.people : {})) {
      for (const pr of (isObj(p) && Array.isArray(p.projects) ? p.projects : [])) if (pr !== '*' && !registry.projects[pr]) f.push(warn(`person "${name}": project "${pr}" is not in projects.json`));
    }
  }
  return f;
}

// A Discord bot token, by its shape: three base64url parts joined by dots, the first of which encodes the bot's
// numeric id. A shape check only (validity is the connection check); null when it fits, else the problem.
export function discordTokenProblem(token) {
  if (typeof token !== 'string' || !token) return 'it is empty';
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return 'a bot token has three parts joined by dots, made of letters, digits, "-" and "_"';
  if (parts[0].length < 16 || parts[1].length < 4 || parts[2].length < 20) return 'one of its parts is too short for a bot token';
  let id = '';
  try { id = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch { id = ''; }
  if (!DISCORD_ID_RE.test(id)) return 'its first part does not encode a Discord application id';
  return null;
}

// The variables that hold bus keys (projects and per-bot keys), so the token can never share one. Environment names
// are case-insensitive on Windows, so there they are compared in one case.
const envName = (n) => (process.platform === 'win32' ? String(n).toUpperCase() : String(n));
function keyEnvNames(registry) {
  const names = new Set();
  for (const p of Object.values((registry && isObj(registry.projects)) ? registry.projects : {})) {
    if (isObj(p) && typeof p.keyEnv === 'string') names.add(envName(p.keyEnv));
    for (const r of Object.values(isObj(p && p.roster) ? p.roster : {})) if (isObj(r) && typeof r.keyEnv === 'string') names.add(envName(r.keyEnv));
  }
  return names;
}

// The optional Discord pack's block. While the pack is off, a problem in it is a warning (the bus never reads it);
// once enabled, the same problem stops the boot. Pure: no discord.js, no network. Boot, doctor and setup share it.
//   discord: { enabled, tokenEnv?, projects: { <project>: { channels: { <bus channel>: <Discord channel id> }, cards?: <bus channel> } } }
//   `cards` names the mapped bus channel whose Discord channel gets the project's cards (default: code, else the first).
export function checkDiscord(config, registry, env = process.env) {
  const f = [];
  const d = config && config.discord;
  if (d === undefined) return f;
  const on = isObj(d) && d.enabled === true;
  const bad = on ? fatal : (message) => warn(`${message} (the Discord pack is off, so this does not stop the bus; it will once the pack is enabled)`);
  if (!isObj(d)) return [bad('"discord" must be an object')];
  const known = ['enabled', 'tokenEnv', 'projects'];
  for (const k of Object.keys(d)) if (!known.includes(k)) f.push(bad(`discord: unknown field "${k}" (known: ${known.join(', ')})`));
  if (d.enabled !== undefined && typeof d.enabled !== 'boolean') f.push(bad('"discord.enabled" must be true or false'));
  if (d.tokenEnv !== undefined && (typeof d.tokenEnv !== 'string' || !ENV_NAME_RE.test(d.tokenEnv))) f.push(bad('"discord.tokenEnv" must be an environment variable name'));
  const tokenEnv = typeof d.tokenEnv === 'string' && d.tokenEnv ? d.tokenEnv : DEFAULT_DISCORD_TOKEN_ENV;
  const keyNames = keyEnvNames(registry);
  if (keyNames.has(envName(tokenEnv))) f.push(bad(`"discord.tokenEnv" is ${tokenEnv}, which holds a bus key; the bot token needs a variable of its own`));
  const channels = new Set(Array.isArray(config.channels) && config.channels.length ? config.channels : DEFAULT_CHANNELS);
  const owner = new Map(); // Discord channel id -> the one project that owns it (inbound messages need a unique route)
  const claim = (id, project, label) => {
    if (typeof id !== 'string' || !DISCORD_ID_RE.test(id)) { f.push(bad(`discord.projects.${project}.${label} must be a Discord channel id (17 to 20 digits)`)); return; }
    const prev = owner.get(id);
    if (prev && prev.project !== project) f.push(bad(`discord: one Discord channel is mapped to both project "${prev.project}" and project "${project}"; each Discord channel belongs to one project`));
    else if (prev) f.push(bad(`discord.projects.${project}: one Discord channel is mapped to both ${prev.label} and ${label}; inbound messages need one bus channel`));
    else owner.set(id, { project, label });
  };
  let mapped = 0;
  if (d.projects !== undefined && !isObj(d.projects)) f.push(bad('"discord.projects" must be an object of project id -> { channels, cards }'));
  for (const [project, p] of Object.entries(isObj(d.projects) ? d.projects : {})) {
    if (registry && isObj(registry.projects) && !registry.projects[project]) f.push(bad(`discord.projects: project "${project}" is not in projects.json`));
    if (!isObj(p)) { f.push(bad(`discord.projects.${project} must be an object`)); continue; }
    for (const k of Object.keys(p)) if (!['channels', 'cards'].includes(k)) f.push(bad(`discord.projects.${project}: unknown field "${k}" (known: channels, cards)`));
    if (p.channels !== undefined && !isObj(p.channels)) { f.push(bad(`discord.projects.${project}.channels must be an object of bus channel -> Discord channel id`)); continue; }
    for (const [ch, id] of Object.entries(p.channels || {})) {
      if (!channels.has(ch)) f.push(bad(`discord.projects.${project}.channels: "${ch}" is not a bus channel (${[...channels].join(', ')})`));
      claim(id, project, `channels.${ch}`);
      mapped++;
    }
    if (p.cards !== undefined && !(typeof p.cards === 'string' && Object.prototype.hasOwnProperty.call(p.channels || {}, p.cards))) f.push(bad(`discord.projects.${project}.cards must name one of that project's mapped bus channels (${Object.keys(p.channels || {}).join(', ') || 'none mapped'})`));
    if (!Object.keys(p.channels || {}).length) f.push(warn(`discord.projects.${project} maps no channel, so nothing of that project reaches Discord`));
  }
  if (on) {
    const token = env[tokenEnv];
    const problem = token ? discordTokenProblem(token) : null;
    if (!token) f.push(fatal(`discord.enabled is true but ${tokenEnv} is not set (run "synapse discord setup" in your own terminal; it stores the bot token in <home>/.env)`));
    else if (problem) f.push(fatal(`${tokenEnv} does not look like a Discord bot token (${problem}); copy it again from the Developer Portal (Bot > Reset Token)`));
    else if ([...keyNames].some((n) => env[n] === token)) f.push(fatal(`${tokenEnv} has the same value as a bus key; the bot token must be its own value`));
    if (!mapped) f.push(warn('discord.enabled is true but no Discord channel is mapped (discord.projects), so nothing is posted'));
    const people = isObj(config.people) ? config.people : {};
    const owners = new Set(Array.isArray(config.owners) ? config.owners : []);
    const deciders = Object.entries(people).filter(([n, p]) => isObj(p) && (owners.has(n) || (Array.isArray(p.roles) && (p.roles.includes('owner') || p.roles.includes('approver')))));
    if (!deciders.some(([, p]) => isObj(p.accounts) && p.accounts.discord !== undefined)) f.push(warn('discord.enabled is true but no owner or approver has a Discord account id (people.<name>.accounts.discord), so nobody can answer a card on Discord'));
  }
  return f;
}

// Read both files. Never throws: a missing or broken file is a fatal finding.
export function loadHomeConfig(paths, env = process.env) {
  const findings = [];
  let config = null;
  let registry = null;
  if (!fs.existsSync(paths.config)) findings.push(fatal(`${paths.config} is missing (run "synapse init")`));
  else {
    try { config = readJson(paths.config); } catch (e) { findings.push(fatal(`synapse.config.json is not valid JSON (${e.message})`)); }
  }
  if (!fs.existsSync(paths.projects)) findings.push(fatal(`${paths.projects} is missing (run "synapse init")`));
  else {
    try { registry = readJson(paths.projects); } catch (e) { findings.push(fatal(`projects.json is not valid JSON (${e.message})`)); }
  }
  if (config) findings.push(...checkConfig(config));
  const full = config ? withDefaults(config) : null;
  if (registry && full) findings.push(...checkRegistry(registry, full, env));
  if (config) findings.push(...checkDiscord(config, registry, env));
  return { config: full, registry, findings };
}

export function hasFatal(findings) {
  return findings.some((x) => x.level === 'fatal');
}
