#!/usr/bin/env node
// Synapse bus server: one HTTP API and one WebSocket (/ws) on one port, for the Claude Code sessions on this machine.
//
// Core features: key auth and identity binding, project scope walls, channel and direct messages with reconnect
// replay, the per-seat delivery filter and digest, cooperative file locks and the pre-edit check, activity, alerts,
// tasks, file attachments, decision cards (dev_ask) answered by a configured person on the dashboard, notifications,
// error and log feeds, and health.
//
// Everything lives under the Synapse home (SYNAPSE_HOME, default ~/.synapse); see server/lib/home.mjs. People reach
// the bus through a human channel (server/lib/human-channel.mjs): the core ships the dashboard channel, and an
// optional pack (Discord) plugs in behind the same interface when its config switch is on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { WebSocketServer } from 'ws';

import { resolveHome, homePaths, loadEnvFile, writeJsonAtomic, readJson } from './lib/home.mjs';
import { loadHomeConfig, hasFatal, DEFAULT_DISCORD_TOKEN_ENV } from './lib/config.mjs';
import { createRedactor } from './lib/redact.mjs';
import { createPeople } from './lib/people.mjs';
import { createAuth, seatBase, isAbsentActor } from './lib/auth.mjs';
import { sanitizeText } from './lib/sanitize.mjs';
import { classifyDelivery, formatDigest } from './lib/delivery-filter.mjs';
import { openDigestStore } from './lib/digest-store.mjs';
import { safeDirectReceipt } from './lib/direct-receipt.mjs';
import { listProjects } from './lib/projects-api.mjs';
import { openAskStore } from './lib/ask-store.mjs';
import { createFilesStore, classifyTier, contentDispositionAttachment } from './lib/files-store.mjs';
import { multipartBoundary } from './lib/upload-errors.mjs';
import { withStandingButtons, buildDeliverBackMessage, DISMISS_LABEL } from './lib/ask-text.mjs';
import { loadHumanChannel } from './lib/human-channel.mjs';
import lockKeys from '../shared/lock-key.cjs';

const { lockKey, foldKey, caseInsensitiveAt } = lockKeys;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = (() => { try { return readJson(path.join(__dirname, '..', 'package.json')); } catch { return { version: '0.0.0' }; } })();

const ACTOR_MAX = 80;
const CONTENT_MAX = 8000;
const MESSAGE_HISTORY_MAX = 200;
const ACTIVITY_MAX = 500;
const TASK_MAX = 200;
const ERROR_MAX = 200;
const LOG_BUFFER_MAX = 200;
const NOTIFY_MAX = 200;
const LOCK_EXPIRE_MS = 30 * 60 * 1000;
const RECENT_EDIT_WARNING_MS = 10 * 60 * 1000;
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const REPLAY_TIME_BOUND_MS = 60 * 60 * 1000;
const DIGEST_FLUSH_MAX = 25;
const DIGEST_FLUSH_AGE_MS = 30 * 60 * 1000;
const PRIORITIES = new Set(['info', 'action', 'urgent']);

const CASE_INSENSITIVE_FS_EARLY = process.platform === 'win32' || process.platform === 'darwin';
const isLoopback = (addr) => typeof addr === 'string' && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function timeSince(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function timeUntil(ms) {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

function numericId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).replace(/^msg-/, '');
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export async function createBus({ home, env = process.env, port, host, log = (line) => console.log(line), channelImporter } = {}) {
  const HOME = home || resolveHome({ env, moduleDir: __dirname });
  const paths = homePaths(HOME);
  loadEnvFile(paths.env, env);
  const { config, registry, findings } = loadHomeConfig(paths, env);
  for (const f of findings) if (f.level === 'warn') log(`[synapse] warning: ${f.message}`);
  if (hasFatal(findings)) {
    const err = new Error(`cannot start:\n${findings.filter((f) => f.level === 'fatal').map((f) => `  - ${f.message}`).join('\n')}`);
    err.findings = findings;
    throw err;
  }
  const PORT = Number(port ?? env.SYNAPSE_PORT ?? config.server.port);
  const HOST = host ?? env.SYNAPSE_HOST ?? config.server.host;
  const people = createPeople(config);
  const auth = createAuth({ registry, env, people });
  const projectIds = () => Object.keys(registry.projects || {});
  const DEFAULT_PROJECT = config.defaultProject || projectIds()[0] || null;
  const SYSTEM = config.systemSender;
  const CHANNELS = new Set([...config.channels, 'all']);
  fs.mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  // Every key the bus knows, so text leaving the machine through a pack can never carry one (server/lib/redact.mjs).
  const PACK_SECRET_ENV = config.discord.tokenEnv || DEFAULT_DISCORD_TOKEN_ENV;
  const knownSecrets = [env[PACK_SECRET_ENV]];
  for (const p of Object.values(registry.projects || {})) {
    if (p && p.keyEnv) knownSecrets.push(env[p.keyEnv]);
    for (const r of Object.values((p && p.roster) || {})) if (r && r.keyEnv) knownSecrets.push(env[r.keyEnv]);
  }
  const redact = createRedactor(knownSecrets);

  // ─── Persistent state (one JSON file, written atomically) ───
  const STATE_FILE = path.join(paths.data, 'state.json');
  let loaded = {};
  try { if (fs.existsSync(STATE_FILE)) loaded = readJson(STATE_FILE); } catch (e) { log(`[synapse] state.json unreadable (${e.message}); starting empty`); }
  const developers = new Map((loaded.developers || []).map((d) => [`${d.project}|${d.name}`, d]));
  const locks = new Map();
  const alerts = loaded.alerts || [];
  const activity = loaded.activity || [];
  const messageHistory = loaded.messages || [];
  const tasks = loaded.tasks || [];
  let taskIdCounter = loaded.taskIdCounter || 0;
  let alertIdCounter = loaded.alertIdCounter || 0;
  let msgIdCounter = Math.max(loaded.msgIdCounter || 0, ...messageHistory.map((m) => numericId(m?.id) ?? 0));
  if (msgIdCounter > 0) msgIdCounter += 1000; // a crash can lose the last autosave; never reissue an id a client has seen
  const errors = [];
  const pendingLocks = loaded.locks || [];
  const logBuffers = {};
  const notifications = [];
  const evictedMax = loaded.evictedMax && typeof loaded.evictedMax === 'object' ? loaded.evictedMax : {};

  function saveState() {
    try {
      writeJsonAtomic(STATE_FILE, {
        version: 1,
        developers: [...developers.values()],
        locks: [...locks.values()],
        alerts: alerts.filter((a) => !a.acknowledged),
        activity: activity.slice(0, ACTIVITY_MAX),
        messages: messageHistory,
        msgIdCounter,
        tasks,
        taskIdCounter,
        alertIdCounter,
        evictedMax,
      });
      return true;
    } catch (e) {
      log(`[synapse] state save failed: ${e.message}`);
      return false;
    }
  }
  const timers = [];
  const every = (ms, fn) => { const t = setInterval(() => { try { fn(); } catch (e) { log(`[synapse] tick failed: ${e.message}`); } }, ms); t.unref(); timers.push(t); };
  every(10_000, saveState);
  for (const l of pendingLocks) if (l && l.project && l.file) locks.set(`${l.project}|${CASE_INSENSITIVE_FS_EARLY ? String(l.file).toLowerCase() : l.file}`, l);

  // ─── Stores ───
  const askStore = openAskStore(path.join(paths.data, 'ask.db'));
  const filesStore = createFilesStore(path.join(paths.data, 'files.db'), {
    defaultProject: DEFAULT_PROJECT || 'default',
    maxBytes: Number(env.SYNAPSE_FILES_MAX_BYTES) || 2 * 1024 * 1024 * 1024,
    onPressure: () => {},
  });
  const digestStore = openDigestStore({ file: path.join(paths.data, 'digest-state.json') });

  // ─── Scope helpers ───
  // Who may act in a project: a person in the projects they are allowed in, any key in its own project only. Reads and
  // writes use this one rule, and every write checks it against the project of the resource it changes.
  const inScope = (req, project) => {
    const p = project || DEFAULT_PROJECT;
    if (req.humanPrincipal) return people.allowedIn(req.humanPrincipal, p);
    return p === req.authProject;
  };
  const scopeFilter = (req) => (row) => inScope(req, row.project);

  function addActivity(developer, action, file, message, project = DEFAULT_PROJECT) {
    activity.unshift({ id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, developer, action, file, message, project, timestamp: new Date().toISOString() });
    if (activity.length > ACTIVITY_MAX) activity.length = ACTIVITY_MAX;
  }
  // Lock keys come from shared/lock-key.cjs, the one policy the hooks use too: relative to the project root when inside
  // it, the full absolute path otherwise, case-matched as the project's own folder is. Locks are advisory: an edit made
  // outside the hooks (a shell command) or while the bus is down is not checked.
  const rootOf = (project) => (registry.projects[project] && registry.projects[project].root) || null;
  const ciOf = (project) => caseInsensitiveAt(rootOf(project));
  const lockPath = (project, file) => lockKey(rootOf(project), file, { caseInsensitive: ciOf(project) });
  const lockId = (project, p) => `${project}|${foldKey(p, ciOf(project))}`;
  const sameFile = (project, a, b) => foldKey(a, ciOf(project)) === foldKey(b, ciOf(project));
  function cleanExpiredLocks() {
    const now = Date.now();
    for (const [k, lock] of locks) {
      if (now > lock.expiresAt) { locks.delete(k); addActivity(lock.developer, 'unlock', lock.file, `Auto-expired lock on ${lock.file}`, lock.project); }
    }
  }

  // ─── Delivery ───
  const wsClients = new Map(); // ws -> { developer, channels, project, superScope, connId, effort, model }
  let humanChannel = null; // set before listen
  const relay = (msg) => { try { humanChannel && humanChannel.relayMessage && humanChannel.relayMessage(msg); } catch (e) { log(`[synapse] relay failed: ${e.message}`); } };

  const deliveryCfgFor = (project, seat) => registry.projects[project]?.delivery?.[seatBase(seat)];
  const projectHumansLower = (project) => new Set(people.humansIn(project).map((h) => h.toLowerCase()));
  const humanNameFor = (project, to) => {
    if (!to) return null;
    const t = String(to).toLowerCase();
    return people.humansIn(project).find((n) => n.toLowerCase() === t) || null;
  };
  function onlineNames(filter) {
    const names = new Set();
    for (const [ws, info] of wsClients) if (ws.readyState === 1 && filter(info)) names.add(info.developer);
    return [...names];
  }
  // Each project keeps its own last MESSAGE_HISTORY_MAX messages, so a busy project cannot evict a quiet one's backlog.
  // evictedMax remembers the newest id each project lost, which is how a replay cursor learns it fell behind.
  function trimRing(project) {
    let count = 0;
    for (let i = 0; i < messageHistory.length; i++) {
      if (messageHistory[i].project !== project) continue;
      if (++count > MESSAGE_HISTORY_MAX) {
        const [gone] = messageHistory.splice(i, 1);
        i--;
        const n = numericId(gone.id);
        if (n !== null && n > (evictedMax[project] || 0)) evictedMax[project] = n;
      }
    }
  }

  function broadcastWs(event, data, excludeDev, project) {
    const payload = JSON.stringify({ event, ...data, timestamp: new Date().toISOString() });
    for (const [ws, info] of wsClients) {
      if (info.developer === excludeDev) continue;
      if (info.project !== project) continue;
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  // What leaves the machine through a pack: redacted from the full text first, and only then capped, so a cap can never
  // cut a key in two and leave a piece the redactor cannot recognise. The bus's own stored copy is unchanged.
  const outboundText = (sender, content) => ({ sender: sanitizeText(redact(String(sender ?? '')), ACTOR_MAX), content: sanitizeText(redact(String(content ?? '')), CONTENT_MAX) });
  function sendToChannel(channel, sender, content, meta, project) {
    const msg = {
      id: `msg-${++msgIdCounter}`,
      channel,
      sender: sanitizeText(sender, ACTOR_MAX),
      content: sanitizeText(content, CONTENT_MAX),
      project,
      meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
      timestamp: new Date().toISOString(),
    };
    messageHistory.unshift(msg);
    trimRing(msg.project);
    const payload = JSON.stringify({ event: 'message', ...msg });
    for (const [ws, info] of wsClients) {
      if (info.developer === msg.sender) continue; // never echo back to the sending identity
      if (info.project !== msg.project) continue; // project wall
      if (!(info.channels.includes(channel) || info.channels.includes('all'))) continue;
      const cfg = deliveryCfgFor(msg.project, info.developer);
      if (cfg && classifyDelivery(msg, info.developer, cfg, { seatBase, humans: projectHumansLower(msg.project) }) === 'digest') {
        digestStore.push(msg.project, info.developer, { id: msg.id, channel, sender: msg.sender, content: msg.content, timestamp: msg.timestamp });
        continue;
      }
      if (ws.readyState === 1) ws.send(payload);
    }
    if (meta?.type !== 'file') relay({ ...msg, ...outboundText(sender, content) });
    return msg;
  }

  // A direct message addressed to a base bot name reaches every connected seat of it; an exact seat only that seat.
  // Direct messages stay private even from a super-scope observer.
  function isDirectRecipient(info, from, to, project) {
    if (info.developer === from) return false;
    return (info.developer === to || seatBase(info.developer) === to) && info.project === project;
  }
  function sendDirect(from, to, content, source, project, id = null) {
    const msg = {
      id: id || `msg-${++msgIdCounter}`,
      channel: 'direct',
      sender: sanitizeText(from, ACTOR_MAX),
      to,
      content: sanitizeText(content, CONTENT_MAX),
      project,
      timestamp: new Date().toISOString(),
      ...(source ? { source } : {}),
    };
    messageHistory.unshift(msg);
    trimRing(msg.project);
    const payload = JSON.stringify({ event: 'message', ...msg });
    let recipients = 0;
    for (const [ws, info] of wsClients) {
      if (isDirectRecipient(info, msg.sender, to, project) && ws.readyState === 1) { ws.send(payload); recipients++; }
    }
    return { msg, recipients };
  }
  function deliverAlertWs(alert) {
    const payload = JSON.stringify({ event: 'alert', from: alert.from, to: alert.to, message: alert.message, priority: alert.priority, timestamp: alert.timestamp });
    let delivered = false;
    for (const [ws, info] of wsClients) {
      if (ws.readyState !== 1) continue;
      const isRecipient = (info.developer === alert.to || seatBase(info.developer) === alert.to) && info.project === alert.project && info.developer !== alert.from;
      if (isRecipient) { ws.send(payload); delivered = true; }
    }
    return delivered;
  }
  // A seat's pending digest goes out as ONE direct message, acked only once it has a durable home.
  function flushDigestFor(project, seat) {
    const entries = digestStore.peek(project, seat);
    if (!entries.length) return;
    const { recipients } = sendDirect(SYSTEM, seat, formatDigest(entries), 'digest', project);
    if (recipients > 0 || saveState()) digestStore.ack(project, seat, entries.length);
  }
  every(60_000, () => {
    for (const { project, seat } of digestStore.pending()) {
      const oldest = digestStore.oldestTs(project, seat);
      if (digestStore.size(project, seat) >= DIGEST_FLUSH_MAX || (oldest && Date.now() - Date.parse(oldest) >= DIGEST_FLUSH_AGE_MS)) flushDigestFor(project, seat);
    }
  });
  function noteForPeople(project, entry) {
    notifications.unshift({ id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, project, timestamp: new Date().toISOString(), ...entry });
    if (notifications.length > NOTIFY_MAX) notifications.length = NOTIFY_MAX;
  }

  // ─── The one answer path for decision cards (dashboard now, any pack later) ───
  // `surfaceProject` (from a pack): the project of the surface the answer came from; it must be the card's own.
  // `optionIndex` (from a pack): the label is taken from the parked card by index, never from the caller.
  function answerAsk({ askId, label, optionIndex, answeredBy, via = 'dashboard', surfaceProject }) {
    if (typeof askId !== 'string' || !askId) return { ok: false, status: 400, error: 'bad_request' };
    const ask = askStore.getAskForDelivery(askId);
    if (!ask) return { ok: false, status: 404, error: 'not_found' };
    if (surfaceProject !== undefined && surfaceProject !== ask.project) return { ok: false, status: 403, error: 'wrong_project' };
    if (!people.canAnswer(answeredBy, ask.project)) return { ok: false, status: 403, error: 'not_an_answerer' };
    const q = Array.isArray(ask.questions) ? ask.questions[0] : null;
    const offered = (q && Array.isArray(q.options) ? q.options : []).map((o) => o && o.label);
    if (optionIndex !== undefined) {
      if (label !== undefined || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= offered.length) return { ok: false, status: 400, error: 'not_offered' };
      label = offered[optionIndex];
    }
    if (typeof label !== 'string' || !offered.includes(label)) return { ok: false, status: 400, error: 'not_offered' };
    try {
      askStore.answer({ toolUseId: askId, project: ask.project, selections: { [q.question]: [label] }, answeredBy });
    } catch {
      return { ok: false, status: 409, error: 'already_answered' };
    }
    const line = buildDeliverBackMessage(askId, q.question, label, answeredBy, CONTENT_MAX);
    const { recipients } = sendDirect('ask-bridge', ask.askingSeat, line, 'dev_ask', ask.project, `askans-${askId}`);
    // No consume here: the answer stays in the outbox until the seat acks it (POST /api/ask/:askId/ack).
    const chosen = q.options.find((o) => o && o.label === label);
    const shownLabel = chosen && typeof chosen.display === 'string' ? chosen.display : redact(label);
    try { humanChannel && humanChannel.askClosed && humanChannel.askClosed({ askId, project: ask.project, label: shownLabel, answeredBy, via }); } catch (e) { log(`[synapse] askClosed failed: ${e.message}`); }
    addActivity(answeredBy, 'ask:answer', null, `${answeredBy} answered card ${askId.slice(0, 8)} via ${via}`, ask.project);
    return { ok: true, status: 200, delivered: recipients > 0, label: shownLabel, answeredBy };
  }
  // For a pack: it passes the provider and the account id it verified; the core resolves exactly one person (unknown
  // or ambiguous ids are refused) and then applies the same answer rule as the dashboard.
  // A pack may vouch only for the account kinds its channel declared (humanChannel.providers); an id under any other
  // provider in the roster is refused, even when it maps to a person.
  const declaredProvider = (provider) => !!humanChannel && Array.isArray(humanChannel.providers) && humanChannel.providers.includes(provider);
  function answerAskByAccount({ provider, accountId, askId, label, optionIndex, project }) {
    if (!declaredProvider(provider)) return { ok: false, status: 403, error: 'undeclared_provider' };
    const person = people.byExternalId(provider, accountId);
    if (!person) return { ok: false, status: 403, error: 'unknown_account' };
    if (project !== undefined && typeof project !== 'string') return { ok: false, status: 400, error: 'bad_request' };
    return answerAsk({ askId, label, optionIndex, answeredBy: person, via: String(provider), surfaceProject: project });
  }
  function postAsPerson({ provider, accountId, project, channel, content }) {
    if (!declaredProvider(provider)) return { ok: false, error: 'undeclared_provider' };
    const person = people.byExternalId(provider, accountId);
    if (!person) return { ok: false, error: 'unknown_account' };
    if (!registry.projects[project] || !people.allowedIn(person, project)) return { ok: false, error: 'not_allowed' };
    if (!CHANNELS.has(channel)) return { ok: false, error: 'unknown_channel' };
    if (typeof content !== 'string' || !content) return { ok: false, error: 'empty' };
    const msg = sendToChannel(channel, person, content, { via: String(provider) }, project);
    return { ok: true, id: msg.id };
  }

  // ─── App ───
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const OWN_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);
  const originAllowed = (origin) => !origin || OWN_ORIGINS.has(origin) || config.corsOrigins.includes(origin);
  // Host allowlist (DNS-rebinding guard): the bus answers only to its own loopback names, plus server.allowedHosts.
  // Always on: a remote bus (allowRemote) must list its names in allowedHosts; the config check refuses an empty list.
  const OWN_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  const extraHosts = (config.server.allowedHosts || []).map((h) => String(h).toLowerCase());
  const hostAllowed = (h) => {
    const host = String(h || '').toLowerCase();
    return OWN_HOSTS.has(host) || extraHosts.includes(host) || extraHosts.includes(host.replace(/:\d+$/, ''));
  };
  const hasBody = (req) => Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  const isHealthProbe = (req) => req.path === '/health' && (req.method === 'GET' || req.method === 'HEAD') && !hasBody(req);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
    if (!hostAllowed(req.headers.host)) return res.status(421).json({ error: 'host_not_allowed' });
    const origin = req.headers.origin;
    if (!originAllowed(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dev-Key, X-Dev-Project, X-Synapse-Human');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Dashboard: loopback only unless config.dashboard.public. The API behind it still needs a key either way.
  const dashboardDir = path.join(__dirname, '..', 'dashboard');
  const dashboardGate = (req, res, next) => (config.dashboard.public || isLoopback(req.socket.remoteAddress) ? next() : res.status(404).end());
  app.get('/', dashboardGate, (req, res) => res.sendFile(path.join(dashboardDir, 'index.html')));
  app.use('/dashboard', dashboardGate, express.static(dashboardDir, { index: 'index.html', maxAge: 0 }));

  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: 'draft-7', legacyHeaders: false, skip: isHealthProbe });
  // Failed personal-key attempts are limited per address: 20 per 15 minutes.
  const humanLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false });
  app.use('/api', apiLimiter);
  app.use('/api', (req, res, next) => (req.headers['x-synapse-human'] !== undefined ? humanLimiter(req, res, next) : next()));

  // ─── Authentication: one principal per request ───
  app.use('/api', (req, res, next) => {
    if (isHealthProbe(req)) return next();
    const key = req.headers['x-dev-key'];
    const human = req.headers['x-synapse-human'];
    const asserted = req.headers['x-dev-project'];
    if (asserted !== undefined && (typeof asserted !== 'string' || !registry.projects[asserted])) {
      return res.status(400).json({ error: 'unknown_project', message: 'Unknown X-Dev-Project header' });
    }
    if (human !== undefined) {
      // A person: the name must be configured and the personal key must verify. Unknown names are refused.
      if (typeof human !== 'string' || typeof key !== 'string' || !people.verifyKey(human, key)) {
        return res.status(401).json({ error: 'unauthorized', message: 'Unknown person or wrong personal key' });
      }
      const project = asserted || (people.allowedIn(human, DEFAULT_PROJECT) ? DEFAULT_PROJECT : projectIds().find((p) => people.allowedIn(human, p)));
      if (!project || !people.allowedIn(human, project)) return res.status(403).json({ error: 'forbidden', message: 'This person is not allowed in that project' });
      req.humanPrincipal = human;
      req.authProject = project;
      return next();
    }
    const project = asserted || DEFAULT_PROJECT;
    if (!project || !registry.projects[project]) return res.status(400).json({ error: 'unknown_project', message: 'Unknown X-Dev-Project header' });
    const bot = auth.matchBotKey(project, key);
    if (bot) { req.botPrincipal = bot; req.authProject = project; return next(); }
    if (!safeEqual(key, auth.projectKey(project) || '')) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-Dev-Key header' });
    req.authProject = project;
    next();
  });
  // Bodies are parsed only after authentication, so an unauthenticated caller never makes the bus read a body.
  app.use(express.json({ limit: '1mb' }));
  app.use((err, req, res, next) => {
    const status = Number(err?.status || err?.statusCode);
    if (!(status >= 400 && status < 500)) return next(err);
    return res.status(status === 413 ? 413 : 400).json({ ok: false, error: status === 413 ? 'body_too_large' : 'invalid_json' });
  });
  // Identity gate: every present actor field must be assertable by this principal. Always on in v2.
  const forged = (res) => res.status(403).json({ error: 'identity_not_in_project_roster', message: 'The presented credential may not post as this identity.' });
  app.use('/api', (req, res, next) => (isHealthProbe(req) || !auth.rejectForgedActor(req) ? next() : forged(res)));
  const actorOf = (req, field) => req.humanPrincipal || req.body?.[field];

  // ─── Health and identity ───
  const startedAt = Date.now();
  const INSTANCE = randomUUID(); // lets the CLI prove a pid belongs to this bus before it stops it
  app.get('/api/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime(), busUptime: (Date.now() - startedAt) / 1000, pid: process.pid, instance: INSTANCE, version: PKG.version, humanChannel: humanChannel ? humanChannel.name : null, humanChannelStatus: channelStatus() }));
  function channelStatus() {
    try {
      const s = humanChannel ? humanChannel.status() : null;
      return s && typeof s === 'object' ? { ...(typeof s.connected === 'boolean' ? { connected: s.connected } : {}), ...(typeof s.state === 'string' ? { state: s.state.slice(0, 40) } : {}) } : {};
    } catch { return {}; }
  }
  app.get('/api/whoami', (req, res) => {
    const kind = req.humanPrincipal ? 'human' : req.botPrincipal ? 'bot' : 'project';
    const projects = projectIds().filter((p) => inScope(req, p));
    res.json({ kind, name: req.humanPrincipal || req.botPrincipal || null, project: req.authProject, projects,
      ...(req.humanPrincipal ? { roles: people.rolesOf(req.humanPrincipal) } : {}) });
  });
  app.get('/api/channels', (req, res) => res.json({ channels: [...config.channels] }));

  // ─── Developer status ───
  app.post('/api/checkin', (req, res) => {
    const { developer, branch, workingOn } = req.body || {};
    if (!developer) return res.status(400).json({ error: 'developer required' });
    developers.set(`${req.authProject}|${developer}`, { name: developer, project: req.authProject, status: 'active', workingOn: workingOn || '', branch: branch || 'main', filesEditing: [], lastSeen: new Date().toISOString(), lastAction: 'Checked in' });
    addActivity(developer, 'checkin', null, `${developer} checked in on branch ${branch || 'main'}`, req.authProject);
    const otherDevelopers = [...developers.values()].filter((d) => d.project === req.authProject && d.name !== developer);
    const pendingAlerts = alerts.filter((a) => (a.to === developer || a.to === seatBase(developer)) && !a.acknowledged && a.project === req.authProject);
    if (pendingAlerts.length) { for (const a of pendingAlerts) a.acknowledged = true; saveState(); }
    res.json({ ok: true, otherDevelopers, pendingAlerts, activeLocks: [...locks.values()].filter((l) => l.project === req.authProject) });
  });
  app.post('/api/checkout', (req, res) => {
    const { developer } = req.body || {};
    if (!developer) return res.status(400).json({ error: 'developer required' });
    let locksReleased = 0;
    for (const [k, lock] of locks) if (lock.developer === developer && lock.project === req.authProject) { locks.delete(k); locksReleased++; }
    const d = developers.get(`${req.authProject}|${developer}`);
    if (d) { d.status = 'offline'; d.lastSeen = new Date().toISOString(); }
    addActivity(developer, 'checkout', null, `${developer} checked out (${locksReleased} locks released)`, req.authProject);
    saveState();
    res.json({ ok: true, locksReleased });
  });
  app.get('/api/status', (req, res) => {
    cleanExpiredLocks();
    const connections = {};
    for (const [ws, info] of wsClients) if (ws.readyState === 1 && inScope(req, info.project)) connections[info.developer] = (connections[info.developer] || 0) + 1;
    res.json({
      online: onlineNames((info) => inScope(req, info.project)),
      connections,
      developers: [...developers.values()].filter(scopeFilter(req)),
      activeLocks: [...locks.values()].filter(scopeFilter(req)),
      recentActivity: activity.filter(scopeFilter(req)).slice(0, 10),
    });
  });
  app.get('/api/status/:name', (req, res) => {
    const dev = developers.get(`${req.authProject}|${req.params.name}`);
    if (!dev) return res.status(404).json({ error: 'Developer not found' });
    res.json(dev);
  });
  app.get('/api/projects', (req, res) => {
    const data = [];
    for (const [pid, p] of Object.entries(registry.projects)) {
      if (!inScope(req, pid)) continue;
      const online = onlineNames((info) => info.project === pid).length;
      let last = 0;
      for (const a of activity) if (a.project === pid) { const t = +new Date(a.timestamp); if (t > last) last = t; }
      const lastTs = last ? new Date(last).toISOString() : null;
      const age = lastTs ? Date.now() - last : Infinity;
      data.push({ id: pid, displayName: p.displayName || pid, online_count: online, last_activity_ts: lastTs,
        health_signal: online > 0 ? 'online' : age <= 30 * 60_000 ? 'recent' : age <= IDLE_TIMEOUT_MS ? 'quiet' : 'stale',
        roster: Object.keys(p.roster || {}), assertableBots: p.assertableBots || [], humans: people.humansIn(pid) });
    }
    res.json({ success: true, data, projects: listProjects({ projects: Object.fromEntries(Object.entries(registry.projects).filter(([pid]) => inScope(req, pid))) }), meta: { count: data.length } });
  });
  app.get('/api/projects/:id/roster', (req, res) => {
    const pid = req.params.id;
    const p = registry.projects[pid];
    if (!p) return res.status(404).json({ success: false, error: 'unknown project' });
    if (!inScope(req, pid)) return res.status(403).json({ success: false, error: 'forbidden' });
    const bots = p.assertableBots || [];
    const roster = Object.entries(p.roster || {}).map(([name, r]) => ({ name, displayName: (r && r.displayName) || name, isBot: bots.includes(name) }));
    res.json({ success: true, data: { id: pid, displayName: p.displayName || pid, roster, assertableBots: bots, humans: people.humansIn(pid) } });
  });

  // ─── File locks and the pre-edit check ───
  app.post('/api/lock', (req, res) => {
    const { developer, file, reason } = req.body || {};
    if (!developer || !file) return res.status(400).json({ error: 'developer and file required' });
    cleanExpiredLocks();
    const normalized = lockPath(req.authProject, file);
    const k = lockId(req.authProject, normalized);
    const existing = locks.get(k);
    if (existing && existing.developer !== developer) {
      return res.json({ ok: false, conflict: true, lockedBy: existing.developer, reason: existing.reason, lockedAt: existing.lockedAt, expiresAt: existing.expiresAt });
    }
    locks.set(k, { file: normalized, project: req.authProject, developer, reason: reason || '', lockedAt: new Date().toISOString(), expiresAt: Date.now() + LOCK_EXPIRE_MS });
    if (!saveState()) { if (existing) locks.set(k, existing); else locks.delete(k); return res.status(503).json({ ok: false, error: 'persist_failed' }); }
    addActivity(developer, 'lock', normalized, `${developer} locked ${normalized}: ${reason || 'editing'}`, req.authProject);
    res.json({ ok: true });
  });
  app.delete('/api/lock', (req, res) => {
    const { developer, file } = req.body || {};
    if (!developer || !file) return res.status(400).json({ error: 'developer and file required' });
    const normalized = lockPath(req.authProject, file);
    const k = lockId(req.authProject, normalized);
    const existing = locks.get(k);
    if (existing && existing.developer === developer) {
      locks.delete(k);
      if (!saveState()) { locks.set(k, existing); return res.status(503).json({ ok: false, error: 'persist_failed' }); }
      addActivity(developer, 'unlock', normalized, `${developer} released ${normalized}`, req.authProject);
    }
    res.json({ ok: true });
  });
  app.get('/api/locks', (req, res) => { cleanExpiredLocks(); res.json({ locks: [...locks.values()].filter(scopeFilter(req)) }); });
  app.post('/api/will-edit', (req, res) => {
    const { developer, file } = req.body || {};
    if (!developer || !file) return res.status(400).json({ error: 'developer and file required' });
    cleanExpiredLocks();
    const normalized = lockPath(req.authProject, file);
    const lock = locks.get(lockId(req.authProject, normalized));
    if (lock && lock.developer !== developer) {
      return res.json({ safe: false, severity: 'blocked', message: `BLOCKED: ${normalized} is locked by ${lock.developer} (${lock.reason || 'editing'}). Locked ${timeSince(lock.lockedAt)} ago, expires in ${timeUntil(lock.expiresAt)}.` });
    }
    // Point-to-one advisory: strictly this project, no super-scope widening.
    const recent = activity.find((a) => a.file && sameFile(req.authProject, a.file, normalized) && a.developer !== developer && a.project === req.authProject && (a.action === 'edit' || a.action === 'create') && Date.now() - new Date(a.timestamp).getTime() < RECENT_EDIT_WARNING_MS);
    if (recent) return res.json({ safe: true, severity: 'warning', message: `WARNING: ${normalized} was edited by ${recent.developer} ${timeSince(recent.timestamp)} ago.` });
    const shared = registry.projects[req.authProject]?.sharedFiles || [];
    if (shared.some((x) => sameFile(req.authProject, lockPath(req.authProject, x), normalized))) return res.json({ safe: true, severity: 'caution', message: `CAUTION: ${normalized} is a shared file. Coordinate with the other sessions.` });
    res.json({ safe: true, severity: 'none' });
  });
  app.post('/api/did-edit', (req, res) => {
    const { developer, file, summary } = req.body || {};
    if (!developer || !file) return res.status(400).json({ error: 'developer and file required' });
    const normalized = lockPath(req.authProject, file);
    const d = developers.get(`${req.authProject}|${developer}`);
    if (d) {
      d.lastSeen = new Date().toISOString();
      d.lastAction = `Edited ${normalized}`;
      if (!d.filesEditing.some((x) => sameFile(req.authProject, x, normalized))) { d.filesEditing.push(normalized); if (d.filesEditing.length > 10) d.filesEditing.shift(); }
    }
    addActivity(developer, 'edit', normalized, summary || `${developer} edited ${normalized}`, req.authProject);
    res.json({ ok: true });
  });

  // ─── Activity and alerts ───
  app.get('/api/activity', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, ACTIVITY_MAX);
    let entries = activity.filter(scopeFilter(req));
    if (typeof req.query.developer === 'string') entries = entries.filter((a) => a.developer === req.query.developer);
    res.json({ entries: entries.slice(0, limit) });
  });
  app.post('/api/alert', (req, res) => {
    const { from, to, message, priority } = req.body || {};
    const fromActor = actorOf(req, 'from');
    if (!fromActor || !to || !message) return res.status(400).json({ error: 'from, to, and message required' });
    const alert = { id: `alert-${++alertIdCounter}`, from: fromActor, to: String(to), message: sanitizeText(message, CONTENT_MAX), priority: PRIORITIES.has(priority) || priority === 'warning' || priority === 'critical' ? priority : 'info', project: req.authProject, timestamp: new Date().toISOString(), acknowledged: false };
    alerts.push(alert);
    addActivity(fromActor, 'alert', null, `${fromActor} → ${to}: ${alert.message}`, req.authProject);
    if (deliverAlertWs(alert)) alert.acknowledged = true;
    saveState();
    res.json({ ok: true, alertId: alert.id });
  });
  app.get('/api/alerts/:developer', (req, res) => {
    const d = req.params.developer;
    res.json({ alerts: alerts.filter((a) => (a.to === d || a.to === seatBase(d)) && !a.acknowledged && inScope(req, a.project)) });
  });
  app.post('/api/alerts/:id/ack', (req, res) => {
    const a = alerts.find((x) => x.id === req.params.id && inScope(req, x.project));
    if (a) { a.acknowledged = true; saveState(); }
    res.json({ ok: true });
  });

  // ─── Messages ───
  const knownChannel = (c) => typeof c === 'string' && CHANNELS.has(c);
  app.post('/api/message', (req, res) => {
    const { channel, content, meta } = req.body || {};
    const fromActor = actorOf(req, 'sender');
    if (!fromActor || !channel || !content) return res.status(400).json({ error: 'sender, channel, and content required' });
    if (!knownChannel(channel)) return res.status(400).json({ error: 'unknown_channel', message: `Unknown channel "${channel}". Valid: ${[...CHANNELS].join(', ')}` });
    const msg = sendToChannel(channel, fromActor, content, meta, req.authProject);
    flushDigestFor(req.authProject, fromActor);
    res.json({ ok: true, id: msg.id });
  });
  app.post('/api/message/broadcast', (req, res) => {
    const { content, meta } = req.body || {};
    const fromActor = actorOf(req, 'sender');
    if (!fromActor || !content) return res.status(400).json({ error: 'sender and content required' });
    const msg = sendToChannel('all', fromActor, content, meta, req.authProject);
    res.json({ ok: true, id: msg.id });
  });
  app.post('/api/wake', (req, res) => {
    const { seat, reason } = req.body || {};
    const fromActor = actorOf(req, 'sender');
    if (!fromActor || !seat) return res.status(400).json({ error: 'sender and seat required' });
    const { recipients } = sendDirect(fromActor, String(seat), `⏰ WAKE from ${fromActor}: ${sanitizeText(String(reason || 'attention needed'), CONTENT_MAX)}`, 'wake', req.authProject);
    flushDigestFor(req.authProject, String(seat));
    addActivity(fromActor, 'wake', null, `${fromActor} woke ${seat}: ${String(reason || '').slice(0, 60)}`, req.authProject);
    res.json({ result: recipients > 0 ? 'delivered_live' : 'seat_offline', recipients });
  });
  app.post('/api/message/direct', (req, res) => {
    const { to, content, source } = req.body || {};
    const fromActor = actorOf(req, 'from');
    if (!fromActor || !to || !content) return res.status(400).json({ error: 'from, to, and content required' });
    const { msg, recipients } = sendDirect(fromActor, String(to), content, typeof source === 'string' ? source.slice(0, 32) : undefined, req.authProject);
    // A person holds no seat: a direct message to one waits on the dashboard.
    const humanTo = humanNameFor(req.authProject, to);
    if (humanTo) noteForPeople(req.authProject, { kind: 'dm', to: humanTo, sender: msg.sender, message: msg.content, priority: 'info' });
    const receipt = safeDirectReceipt(() => ({ to, from: fromActor, recipients, humanTo, rosterBots: registry.projects[req.authProject]?.assertableBots || [], fleet: [], knownChannels: CHANNELS, seatBase }),
      { warn: (err) => log(`[synapse] direct receipt skipped: ${err && err.message}`) });
    res.json({ ok: true, id: msg.id, ...receipt });
  });
  app.get('/api/messages', (req, res) => {
    const channel = typeof req.query.channel === 'string' ? req.query.channel : null;
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, MESSAGE_HISTORY_MAX);
    const channelMatch = (m) => !channel || m.channel === channel || m.channel === 'all';
    const replayIntent = req.query.since_id !== undefined || ['1', 'true', 'on'].includes(req.query.replay);
    if (replayIntent) {
      // Replay after a reconnect: strictly id > since_id, this project only, oldest first, bounded. A lost cursor is an
      // observable resync_required, never a silent gap. Direct messages replay only for the bound ?developer= claim.
      const replayDev = typeof req.query.developer === 'string' && req.query.developer.length ? req.query.developer : null;
      if (replayDev && !auth.bindIdentity(req.authProject, replayDev, req)) return forged(res);
      const dmMatch = (m) => m.channel !== 'direct' || (replayDev !== null && (m.sender === replayDev || m.to === replayDev || (seatBase(replayDev) !== replayDev && m.to === seatBase(replayDev))));
      const scoped = messageHistory.filter((m) => m.project === req.authProject && channelMatch(m) && dmMatch(m));
      const headId = scoped.length ? scoped[0].id : null;
      const cursorN = numericId(req.query.since_id);
      if (cursorN === null) return res.json({ kind: 'resync_required', resync_required: true, project: req.authProject, head_id: headId, gap: scoped.length, reason: 'cursor_missing' });
      const replayCap = Number.isFinite(registry.projects[req.authProject]?.replayCap) ? registry.projects[req.authProject].replayCap : MESSAGE_HISTORY_MAX;
      const evictedPast = cursorN < (evictedMax[req.authProject] || 0);
      const newer = scoped.filter((m) => (numericId(m.id) ?? -1) > cursorN).sort((a, b) => numericId(a.id) - numericId(b.id));
      const tooOld = newer.length && Date.now() - new Date(newer[0].timestamp).getTime() > REPLAY_TIME_BOUND_MS;
      if (evictedPast || newer.length > replayCap || tooOld) {
        return res.json({ kind: 'resync_required', resync_required: true, project: req.authProject, head_id: headId, gap: newer.length, reason: 'cursor_too_old' });
      }
      let deliverNow = newer;
      const cfg = replayDev ? deliveryCfgFor(req.authProject, replayDev) : null;
      if (cfg) {
        const humans = projectHumansLower(req.authProject);
        deliverNow = [];
        for (const m of newer) {
          if (classifyDelivery(m, replayDev, cfg, { seatBase, humans }) === 'digest') digestStore.push(req.authProject, replayDev, { id: m.id, channel: m.channel, sender: m.sender, content: m.content, timestamp: m.timestamp });
          else deliverNow.push(m);
        }
      }
      return res.json({ messages: deliverNow, cursor: headId });
    }
    const requestedProject = req.humanPrincipal && typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
    if (requestedProject && !registry.projects[requestedProject]) return res.status(400).json({ error: 'unknown_project' });
    if (requestedProject && !inScope(req, requestedProject)) return res.status(403).json({ error: 'forbidden' });
    let msgs = messageHistory.filter((m) => inScope(req, m.project) && (!requestedProject || m.project === requestedProject) && channelMatch(m));
    // Direct messages are seat-private and filtered here, not by the client. A key sees only the DMs of the identity it
    // binds in ?developer= (from it, to it, or to its base bot); a person sees their own; no claim means no DMs.
    const browseDev = typeof req.query.developer === 'string' && req.query.developer ? req.query.developer : null;
    if (browseDev && !req.humanPrincipal && !auth.bindIdentity(req.authProject, browseDev, req)) return forged(res);
    const viewer = req.humanPrincipal || browseDev;
    msgs = msgs.filter((m) => m.channel !== 'direct' || (viewer !== null && (m.sender === viewer || m.to === viewer || (!req.humanPrincipal && seatBase(viewer) !== viewer && m.to === seatBase(viewer)))));


    if (typeof req.query.sender === 'string') msgs = msgs.filter((m) => m.sender === req.query.sender);
    if (typeof req.query.since === 'string') { const t = new Date(req.query.since).getTime(); msgs = msgs.filter((m) => new Date(m.timestamp).getTime() > t); }
    res.json({ messages: msgs.slice(0, limit) });
  });

  // ─── File attachments ───
  const UPLOAD_STAGING = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-upload-'));
  const upload = multer({ dest: UPLOAD_STAGING, limits: { fileSize: 100 * 1024 * 1024 }, fileFilter: (req, file, cb) => (classifyTier(file.originalname) ? cb(null, true) : cb(new Error('File type not allowed'))) });
  const discard = (req) => { if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {}); };
  app.post('/api/message/file', multipartBoundary(upload.single('file')), (req, res) => {
    if (auth.rejectForgedActor(req)) { discard(req); return forged(res); }
    if (!req.file) return res.status(400).json({ error: 'No file attached' });
    const { channel, content } = req.body || {};
    const sender = actorOf(req, 'sender') || 'dashboard';
    const ch = channel || 'code';
    if (!knownChannel(ch)) { discard(req); return res.status(400).json({ error: 'unknown_channel' }); }
    let stored = null;
    try {
      stored = filesStore.storeFile({ project: req.authProject, uploader: sender, filename: req.file.originalname, mimetype: req.file.mimetype, buffer: fs.readFileSync(req.file.path) });
      let busContent = `📎 ${req.file.originalname}${content ? ` — ${content}` : ''}`;
      if (stored.preview) busContent += `\n${stored.preview}`;
      const msg = sendToChannel(ch, sender, busContent, { type: 'file', filename: req.file.originalname, fileId: stored.id, tier: stored.tier, size: stored.size }, req.authProject);
      relay({ ...msg, ...outboundText(sender, busContent), file: { id: stored.id } });
      // The pack mirrors the announcement (the file name, never the file) without waiting, so its outcome is unknown here.
      res.json({ ok: true, id: msg.id, fileId: stored.id, tier: stored.tier, relay: humanChannel.name === 'dashboard' ? 'disabled' : 'unconfirmed' });
    } catch (err) {
      log(`[synapse] file upload failed: ${err.message}`);
      res.status(500).json(stored ? { ok: false, stored: true, fileId: stored.id, error: 'post_failed' } : { ok: false, stored: false, error: 'store_failed' });
    } finally { discard(req); }
  });
  app.use('/api/message/file', (err, req, res, next) => {
    discard(req);
    // The MCP client reads these exact errors as "not stored".
    if (err && err.message === 'File type not allowed') return res.status(400).json({ error: 'File type not allowed' });
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 100MB)' });
    return res.status(400).json({ error: 'bad_upload' });
  });
  app.get('/api/files/:id', (req, res) => {
    const file = filesStore.getFile(req.params.id, req.authProject, { superScope: false });
    if (!file || (req.humanPrincipal && !people.allowedIn(req.humanPrincipal, file.project || req.authProject))) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Disposition', contentDispositionAttachment(file.filename));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(file.content);
  });
  app.get('/api/files/:id/agent', (req, res) => {
    const { status, body } = filesStore.getFileForAgent(req.params.id, req.authProject, { superScope: false });
    res.status(status).json(body);
  });

  // ─── Tasks ───
  const taskVisible = (req) => (t) => inScope(req, t.project);
  function invalidBlockedBy(req, blockedBy, selfId = null) {
    if (blockedBy === undefined) return null;
    if (!Array.isArray(blockedBy) || blockedBy.some((x) => typeof x !== 'string' || !x)) return 'blockedBy must be an array of task ids';
    const bad = blockedBy.filter((id) => id === selfId || !tasks.some((t) => t.id === id && taskVisible(req)(t)));
    return bad.length ? `Unknown blockedBy id(s): ${bad.join(', ')}` : null;
  }
  function unblockDependents(project) {
    for (const t of tasks) {
      if (t.project !== project || t.status !== 'blocked' || !Array.isArray(t.blockedBy) || !t.blockedBy.length) continue;
      const done = t.blockedBy.every((id) => tasks.find((x) => x.id === id && x.project === project)?.status === 'done');
      if (done) { t.status = 'pending'; sendToChannel('tasks', SYSTEM, `🔓 Unblocked: ${t.title}`, { type: 'task_unblocked' }, project); }
    }
  }
  app.post('/api/tasks', (req, res) => {
    const { title, owner, priority, type, description, blockedBy, branch } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const bbErr = invalidBlockedBy(req, blockedBy);
    if (bbErr) return res.status(400).json({ error: 'invalid_blocked_by', message: bbErr });
    const task = { id: `task-${++taskIdCounter}`, title: sanitizeText(title, 300), owner: owner || null, status: 'pending', priority: priority || 2, type: type || 'general',
      description: sanitizeText(description || '', CONTENT_MAX), createdBy: actorOf(req, 'createdBy') || 'dashboard', project: req.authProject, createdAt: new Date().toISOString(), completedAt: null, blockedBy: blockedBy || [], branch: branch || null };
    const before = tasks.slice();
    tasks.push(task);
    if (tasks.length > TASK_MAX) tasks.splice(0, tasks.length - TASK_MAX);
    if (!saveState()) { tasks.length = 0; tasks.push(...before); taskIdCounter--; return res.status(503).json({ error: 'persist_failed' }); }
    broadcastWs('task_update', { action: 'created', task }, null, req.authProject);
    addActivity(task.createdBy, 'task', null, `Created task: ${task.title}`, req.authProject);
    res.json({ ok: true, task });
  });
  app.get('/api/tasks', (req, res) => {
    let result = tasks.filter(taskVisible(req));
    for (const f of ['status', 'owner', 'type']) if (typeof req.query[f] === 'string') result = result.filter((t) => t[f] === req.query[f]);
    res.json({ tasks: result });
  });
  app.get('/api/tasks/:id', (req, res) => {
    const task = tasks.find((t) => t.id === req.params.id);
    if (!task || !taskVisible(req)(task)) return res.status(404).json({ error: 'Task not found' });
    res.json({ task });
  });
  app.patch('/api/tasks/:id', (req, res) => {
    const task = tasks.find((t) => t.id === req.params.id);
    if (!task || !taskVisible(req)(task)) return res.status(404).json({ error: 'Task not found' });
    const taskProject = task.project;
    const originalOwner = task.owner;
    const body = req.body || {};
    // A different project's task (super-scope or a person): the claimed updatedBy must be assertable THERE too.
    if (taskProject !== req.authProject && !isAbsentActor(body.updatedBy) && !auth.bindIdentity(taskProject, body.updatedBy, req)) return forged(res);
    if (!req.humanPrincipal && !auth.bindSecondaryActor(taskProject, body.updatedBy, originalOwner, req.headers['x-dev-key'])) return forged(res);
    const bbErr = invalidBlockedBy(req, body.blockedBy, task.id);
    if (bbErr) return res.status(400).json({ error: 'invalid_blocked_by', message: bbErr });
    const snapshot = { ...task };
    const idx = tasks.indexOf(task);
    const { status, owner, priority, title, description, branch, type, blockedBy } = body;
    if (status) task.status = status;
    if (owner !== undefined) task.owner = owner;
    if (priority) task.priority = priority;
    if (title) task.title = sanitizeText(title, 300);
    if (description !== undefined) task.description = sanitizeText(description, CONTENT_MAX);
    if (branch !== undefined) task.branch = branch;
    if (type) task.type = type;
    if (blockedBy !== undefined) task.blockedBy = blockedBy;
    if (status === 'done') task.completedAt = new Date().toISOString();
    if (status === 'in-progress' && !task.startedAt) task.startedAt = new Date().toISOString();
    if (!saveState()) { tasks[idx] = snapshot; return res.status(503).json({ error: 'persist_failed' }); }
    broadcastWs('task_update', { action: 'updated', task }, null, taskProject);
    // The actor is the bound updatedBy, else the authenticated bot or person, else 'unknown'; never the client's owner.
    const developer = req.humanPrincipal || body.updatedBy || req.botPrincipal || 'unknown';
    const VERB = { 'in-progress': '▶️ Started', blocked: '⛔ Blocked', review: '👀 Review', done: '✅ Completed' };
    if (status && VERB[status]) {
      addActivity(developer, 'task', null, `${VERB[status]}: ${task.title}`, taskProject);
      sendToChannel('tasks', developer, `${VERB[status]}: ${task.title}`, { type: `task_${status.replace(/-/g, '_')}` }, taskProject);
    }
    if (status === 'done') unblockDependents(taskProject);
    res.json({ ok: true, task });
  });
  app.delete('/api/tasks/:id', (req, res) => {
    const idx = tasks.findIndex((t) => t.id === req.params.id);
    if (idx === -1 || !taskVisible(req)(tasks[idx])) return res.status(404).json({ error: 'Task not found' });
    const removed = tasks.splice(idx, 1)[0];
    if (!saveState()) { tasks.splice(idx, 0, removed); return res.status(503).json({ error: 'persist_failed' }); }
    broadcastWs('task_update', { action: 'deleted', task: removed }, null, removed.project);
    res.json({ ok: true });
  });

  // ─── People: notifications and decision cards ───
  app.get('/api/notify/tags', (req, res) => res.json({ tags: people.pingableFor(req.authProject) }));
  app.post('/api/notify', async (req, res) => {
    const { message, tag, priority } = req.body || {};
    const sender = actorOf(req, 'sender');
    if (!sender || !message) return res.status(400).json({ error: 'sender and message required' });
    const pingable = people.pingableFor(req.authProject);
    const requested = Array.isArray(tag) ? tag : (!tag || tag === 'all') ? pingable.filter((n) => people.isOwner(n)) : [tag];
    const unknown = requested.filter((t) => typeof t !== 'string' || !pingable.includes(t));
    if (unknown.length) return res.status(400).json({ error: 'unknown_tag', message: `Unknown tag(s): ${unknown.join(', ')}. Valid: ${[...pingable, 'all'].join(', ')}` });
    const pr = PRIORITIES.has(priority) ? priority : 'info';
    const entry = { kind: 'notify', sender: sanitizeText(sender, ACTOR_MAX), message: sanitizeText(message, CONTENT_MAX), tags: requested, priority: pr };
    noteForPeople(req.authProject, entry);
    let r = { delivered: false, via: 'dashboard' };
    const out = outboundText(sender, message);
    try { if (humanChannel && humanChannel.notify) r = (await humanChannel.notify({ project: req.authProject, ...entry, sender: out.sender, message: out.content })) || r; } catch (e) { log(`[synapse] notify channel failed: ${e.message}`); }
    addActivity(sender, 'notify', null, `${sender} notified ${requested.join(', ') || 'nobody'}: ${String(message).slice(0, 80)}`, req.authProject);
    res.json({ ok: true, delivered: !!r.delivered, via: r.via || 'dashboard', tagged: requested, ...(r.dm ? { dm: r.dm } : {}),
      ...(r.delivered ? {} : { note: 'Queued on the Synapse dashboard; no push channel is configured, so nobody was pinged.' }) });
  });
  app.get('/api/notifications', (req, res) => {
    if (!req.humanPrincipal) return res.status(403).json({ error: 'people_only' });
    const me = req.humanPrincipal;
    res.json({ notifications: notifications.filter((n) => people.allowedIn(me, n.project) && (n.kind !== 'dm' || n.to === me)).slice(0, 100) });
  });

  app.post('/api/ask/dispatch', async (req, res) => {
    const { question, options, askingSeat } = req.body || {};
    if (typeof question !== 'string' || !question || !Array.isArray(options) || options.length < 1) return res.status(400).json({ error: 'bad_request', message: 'question (string) + non-empty options[] required' });
    if (options.length > 24) return res.status(400).json({ error: 'too_many_options', message: 'Max 24 options (one slot is reserved for the standing discuss button)' });
    // The answer is routed to askingSeat, so the presented key must be allowed to speak as it.
    if (askingSeat !== undefined && (typeof askingSeat !== 'string' || !auth.bindIdentity(req.authProject, askingSeat, req))) return forged(res);
    const answerers = people.reachableAnswerersFor(req.authProject, { providers: humanChannel.reaches(req.authProject) ? humanChannel.providers : [] });
    if (!answerers.length) return res.status(409).json({ error: 'no_answerer', message: `Nobody who may answer cards in project ${req.authProject} can sign in yet (an owner or approver needs a personal key: synapse set-human-key <name>${humanChannel.providers.length ? `, or a ${humanChannel.providers.join('/')} account while ${humanChannel.name} is connected` : ''}); nothing was parked.` });
    const pick = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const shown = (v, n) => (typeof v === 'string' ? redact(v).slice(0, n) : undefined); // redact first, then cap
    const card = { context: pick(req.body.context, 4000), recommendation: pick(req.body.recommendation, 1000), series: pick(req.body.series, 24) };
    const cardShown = { context: shown(req.body.context, 4000), recommendation: shown(req.body.recommendation, 1000), series: shown(req.body.series, 24) };
    const capped = options.map((o) => String(o).slice(0, 200));
    const fullOptions = withStandingButtons(capped, { dismiss: true });
    // withStandingButtons keeps the caller's options (minus a Dismiss copy) in order, then appends the standing ones.
    const ownRaw = options.map(String).filter((o, i) => capped[i] !== DISMISS_LABEL);
    const optionsShown = fullOptions.map((label, i) => (i < ownRaw.length ? redact(ownRaw[i]).slice(0, 200) : label));
    const askId = randomUUID();
    try {
      askStore.park({ toolUseId: askId, sessionId: askingSeat || req.authProject, project: req.authProject,
        questions: [{ question: sanitizeText(question, 4000), options: fullOptions.map((label, i) => ({ label, display: optionsShown[i] })), ...Object.fromEntries(Object.entries(card).filter(([, v]) => v !== undefined)) }] });
    } catch {
      return res.status(500).json({ error: 'park_failed', message: 'Could not park the question' });
    }
    let outcome = { delivery: 'unknown' };
    try { outcome = (await humanChannel.deliverAsk({ askId, project: req.authProject, askingSeat: askingSeat || null, question: shown(question, 4000), options: optionsShown, ...cardShown, answerers })) || outcome; }
    catch (e) { log(`[synapse] card delivery failed for ${askId}: ${e.message}`); }
    addActivity('ask-bridge', 'ask:dispatch', null, `dispatched dev_ask ${askId} (${outcome.delivery})`, req.authProject);
    res.json({ askId, delivery: outcome.delivery, ...(outcome.delivery === 'posted' ? { mentioned: !!outcome.mentioned } : {}), answerers, dashboardUrl: dashboardUrl(), cut: [] });
  });
  app.get('/api/ask/pending-answers', (req, res) => {
    const seat = req.query.seat;
    if (typeof seat !== 'string' || !seat) return res.status(400).json({ error: 'bad_request', message: 'seat query param is required' });
    if (!auth.bindIdentity(req.authProject, seat, req)) return forged(res);
    let claimed;
    try { claimed = askStore.listAnsweredForSeat(seat, req.authProject); } catch { return res.status(500).json({ error: 'claim_failed' }); }
    res.json({ answers: claimed.map((a) => ({ askId: a.askId, id: `askans-${a.askId}`, content: buildDeliverBackMessage(a.askId, a.question, a.label, a.answeredBy, CONTENT_MAX) })) });
  });
  // The seat acks an answer once it is in the session; until then it stays in the outbox and is offered again on every
  // reconnect (the client deduplicates by askId).
  app.post('/api/ask/:askId/ack', (req, res) => {
    const seat = req.body && req.body.seat;
    if (typeof seat !== 'string' || !seat) return res.status(400).json({ error: 'bad_request', message: 'seat is required' });
    if (!auth.bindIdentity(req.authProject, seat, req)) return forged(res);
    res.json({ ok: true, ...askStore.ackAnswer(req.params.askId, req.authProject, seat) });
  });
  app.get('/api/ask/open', (req, res) => {
    if (!req.humanPrincipal) return res.status(403).json({ error: 'people_only' });
    const me = req.humanPrincipal;
    const cards = askStore.listOpen(projectIds().filter((p) => people.allowedIn(me, p)), 200).map((c) => {
      const q = (c.questions && c.questions[0]) || {};
      return { askId: c.askId, project: c.project, seat: c.seat, createdAt: c.createdAt, question: q.question, context: q.context, recommendation: q.recommendation, series: q.series,
        options: (q.options || []).map((o) => o.label), canAnswer: people.canAnswer(me, c.project) };
    });
    res.json({ cards });
  });
  // Only a person may answer, and only an owner or approver allowed in the card's project. Project, bot and service
  // keys are refused here outright: a key that can read a project must not be able to decide for its people.
  app.post('/api/ask/:askId/answer', (req, res) => {
    if (!req.humanPrincipal) return res.status(403).json({ error: 'people_only', message: 'Only a configured person, signed in with their personal key, can answer a card.' });
    const r = answerAsk({ askId: req.params.askId, label: req.body && req.body.label, answeredBy: req.humanPrincipal, via: 'dashboard' });
    res.status(r.status).json(r.ok ? { ok: true, delivered: r.delivered } : { ok: false, error: r.error });
  });

  // ─── Errors and logs ───
  app.post('/api/errors', (req, res) => {
    const { type, message, file, line, stack, severity } = req.body || {};
    const developer = actorOf(req, 'developer');
    if (!developer || !message) return res.status(400).json({ error: 'developer and message required' });
    const entry = { id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, project: req.authProject, developer, type: type || 'error', message: sanitizeText(message, CONTENT_MAX), file: file || null, line: line || null, stack: stack ? sanitizeText(stack, CONTENT_MAX) : null, severity: severity || 'error', resolved: false, timestamp: new Date().toISOString() };
    errors.unshift(entry);
    if (errors.length > ERROR_MAX) errors.length = ERROR_MAX;
    broadcastWs('error_report', entry, null, req.authProject);
    addActivity(developer, 'error', file, `${developer} reported: ${String(message).slice(0, 80)}`, req.authProject);
    res.json({ ok: true, id: entry.id });
  });
  app.get('/api/errors', (req, res) => {
    const resolved = req.query.resolved === 'true';
    let entries = errors.filter(scopeFilter(req)).filter((e) => e.resolved === resolved);
    if (typeof req.query.developer === 'string') entries = entries.filter((e) => e.developer === req.query.developer);
    res.json({ errors: entries });
  });
  app.patch('/api/errors/:id/resolve', (req, res) => {
    const e = errors.find((x) => x.id === req.params.id && inScope(req, x.project));
    if (!e) return res.json({ ok: true, resolved: false });
    e.resolved = true; e.resolvedAt = new Date().toISOString();
    res.json({ ok: true, resolved: true });
  });
  app.post('/api/logs', (req, res) => {
    const { lines } = req.body || {};
    const developer = actorOf(req, 'developer');
    if (!developer || !lines) return res.status(400).json({ error: 'developer and lines required' });
    const buf = (logBuffers[developer] ||= []);
    for (const entry of Array.isArray(lines) ? lines : [{ line: lines, level: 'info' }]) {
      const row = { developer, project: req.authProject, line: sanitizeText(String(entry && entry.line !== undefined ? entry.line : entry), CONTENT_MAX), level: (entry && entry.level) || 'info', ts: new Date().toISOString() };
      buf.push(row);
      if (buf.length > LOG_BUFFER_MAX) buf.shift();
      broadcastWs('log_line', row, null, req.authProject);
    }
    res.json({ ok: true, buffered: buf.length });
  });
  app.get('/api/logs', (req, res) => {
    const all = {};
    for (const [dev, buf] of Object.entries(logBuffers)) { const v = buf.filter(scopeFilter(req)); if (v.length) all[dev] = v.slice(-20); }
    res.json({ logs: all });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    log(`[synapse] request failed: ${err && err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  // ─── HTTP + WebSocket ───
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: 4 * 1024 * 1024,
    verifyClient: (info, cb) => (!hostAllowed(info.req.headers.host) ? cb(false, 421) : originAllowed(info.origin || info.req.headers.origin) ? cb(true) : cb(false, 403)),
  });
  wss.on('connection', (ws, req) => {
    ws.on('error', () => {});
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['x-dev-key'];
    // The key travels in the X-Dev-Key upgrade header only; a key in the URL is refused.
    if (url.searchParams.has('key') || typeof key !== 'string' || !key || key.includes(',')) { ws.close(4001, 'Invalid API key'); return; }
    const developer = url.searchParams.get('developer') || 'unknown';
    const project = url.searchParams.get('project') || DEFAULT_PROJECT;
    if (!project || !registry.projects[project]) { ws.close(4002, 'Unknown project'); return; }
    const botPrincipal = auth.matchBotKey(project, key);
    if (!botPrincipal && !safeEqual(key, auth.projectKey(project) || '')) { ws.close(4001, 'Invalid API key'); return; }
    if (!auth.bindIdentity(project, developer, { authProject: project, botPrincipal, headers: { 'x-dev-key': key } })) { ws.close(4003, 'Identity not in project roster'); return; }
    const channels = (url.searchParams.get('channels') || 'all').split(',').filter(Boolean);
    const effort = (url.searchParams.get('effort') || 'unknown').slice(0, 32);
    const model = (url.searchParams.get('model') || 'unknown').slice(0, 64);
    const info = { developer, channels, project, connId: randomUUID(), effort, model };
    wsClients.set(ws, info);
    log(`[synapse] WS connected: ${developer} (project ${project}, channels ${channels.join(',')})`);
    const k = `${project}|${developer}`;
    const now = new Date().toISOString();
    if (developers.has(k)) Object.assign(developers.get(k), { status: 'active', lastSeen: now, effort, model });
    else developers.set(k, { name: developer, project, status: 'active', workingOn: '', branch: 'main', filesEditing: [], lastSeen: now, lastAction: 'Connected', effort, model });
    const botMeta = {};
    for (const [, i] of wsClients) if (i.project === project) botMeta[i.developer] = { effort: i.effort, model: i.model };
    ws.send(JSON.stringify({ event: 'connected', developer, channels, project, caps: [], onlineBots: onlineNames((i) => i.project === project), botMeta, timestamp: now }));
    broadcastWs('bot_meta', { developer, effort, model }, developer, project);
    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const rec = developers.get(k);
      if (rec) { rec.status = 'active'; rec.lastSeen = new Date().toISOString(); }
      if (!data || typeof data !== 'object') return;
      if (data.event === 'message' && typeof data.content === 'string' && data.content) {
        if (data.to) sendDirect(developer, String(data.to), data.content, undefined, project);
        else if (knownChannel(data.channel || 'code')) sendToChannel(data.channel || 'code', developer, data.content, data.meta, project);
        else if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'error', error: 'unknown_channel' }));
      } else if (data.event === 'heartbeat') {
        if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'heartbeat', timestamp: new Date().toISOString() }));
      }
    });
    ws.on('close', () => {
      wsClients.delete(ws);
      const stillLive = [...wsClients.values()].some((i) => i.project === project && i.developer === developer);
      if (!stillLive && developers.has(k)) Object.assign(developers.get(k), { status: 'offline', lastSeen: new Date().toISOString() });
      log(`[synapse] WS disconnected: ${developer}`);
    });
  });

  // ─── The human channel (dashboard by default; a pack when its switch is on) ───
  const packConfig = structuredClone(config);
  for (const p of Object.values(packConfig.people || {})) delete p.keyHash; // a pack never sees key hashes
  humanChannel = await loadHumanChannel(config, Object.freeze({
    config: deepFreeze(packConfig),
    registry: deepFreeze(structuredClone(registry)),
    people: Object.freeze({ canAnswer: people.canAnswer, isOwner: people.isOwner, allowedIn: people.allowedIn, pingableFor: people.pingableFor, answerersFor: people.answerersFor, resolveAccount: people.byExternalId }),
    secret: config.discord.enabled === true ? (env[PACK_SECRET_ENV] || null) : null,
    // Where a pack posted a card (its own message ids), kept with the card so an edit still works after a restart.
    cardRefs: Object.freeze({
      set: (askId, refs) => { try { return askStore.setRefs(String(askId), Array.isArray(refs) ? refs.slice(0, 5) : []).updated; } catch { return false; } },
      get: (askId) => { try { return askStore.getRefs(String(askId)); } catch { return null; } },
    }),
    answerAskByAccount, postAsPerson, redact, log,
  }), channelImporter ? { importer: channelImporter } : undefined);
  function dashboardUrl() {
    const h = !HOST || HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST;
    return `http://${h}:${server.address() ? server.address().port : PORT}/`;
  }
  const OWNER_FILE = path.join(paths.data, 'bus-owner.json');

  let started = false;
  return {
    app, server, config, registry, people, paths,
    get port() { return server.address() ? server.address().port : PORT; },
    host: HOST,
    async start() {
      await humanChannel.start();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, HOST, () => { server.off('error', reject); resolve(); });
      });
      started = true;
      writeJsonAtomic(OWNER_FILE, { pid: process.pid, instance: INSTANCE, port: server.address().port, home: HOME, startedAt: new Date().toISOString() });
      log(`[synapse] bus listening on http://${HOST}:${server.address().port} (home ${HOME}, ${projectIds().length} project(s), human channel: ${humanChannel.name})`);
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      try { if (readJson(OWNER_FILE).instance === INSTANCE) fs.rmSync(OWNER_FILE); } catch {}
      saveState();
      for (const ws of wsClients.keys()) { try { ws.terminate(); } catch {} }
      try { await humanChannel.stop(); } catch {}
      await new Promise((resolve) => { wss.close(() => resolve()); });
      if (started) await new Promise((resolve) => server.close(() => resolve()));
      try { askStore.close(); } catch {}
      try { filesStore.close(); } catch {}
      try { fs.rmSync(UPLOAD_STAGING, { recursive: true, force: true }); } catch {}
    },
  };
}

async function main() {
  let bus;
  try {
    bus = await createBus();
    await bus.start();
  } catch (err) {
    console.error(`[synapse] ${err.code === 'EADDRINUSE' ? 'the port is already in use (is another bus running? "synapse doctor" shows which)' : err.message}`);
    process.exit(1);
  }
  const shutdown = async () => { try { await bus.stop(); } finally { process.exit(0); } };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
