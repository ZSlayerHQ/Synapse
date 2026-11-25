// Test fixture: a throwaway Synapse home and an in-process bus on a random port in 4600-4999.
// Never port 4100, never a real home folder, never a network host other than 127.0.0.1.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBus } from '../../server/server.mjs';
import { hashHumanKey } from '../../server/lib/people.mjs';

export const FORBIDDEN_PORT = 4100;
export const randomPort = () => {
  for (;;) {
    const p = 4600 + Math.floor(Math.random() * 400);
    if (p !== FORBIDDEN_PORT) return p;
  }
};
export const newKey = () => randomBytes(24).toString('base64url');

// people: { name: { roles, projects, key } } -> the config stores only the hash of `key`.
// projects: { id: { bots: [...], botKeys?: { bot: true }, root?, sharedFiles?, delivery? } }
// extraEnv: more lines for <home>/.env (for example a pack's token).
export function makeHome({ projects = { alpha: { bots: ['alphabot'] } }, people = { owner1: { key: 'owner-key-0123456789' } }, owners = ['owner1'], config = {}, extraEnv = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-test-home-'));
  const keys = {};
  const env = { ...extraEnv };
  const registry = { version: 1, projects: {} };
  for (const [id, p] of Object.entries(projects)) {
    const keyEnv = `SYNAPSE_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    keys[id] = newKey();
    env[keyEnv] = keys[id];
    const roster = {};
    for (const b of p.bots || []) {
      roster[b] = { displayName: b };
      if (p.botKeys && p.botKeys[b]) {
        const be = `${keyEnv}_${b.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        keys[`${id}/${b}`] = newKey();
        env[be] = keys[`${id}/${b}`];
        roster[b].keyEnv = be;
      }
    }
    registry.projects[id] = { displayName: id, keyEnv, assertableBots: p.bots || [], roster, ...(p.root ? { root: p.root } : {}), ...(p.sharedFiles ? { sharedFiles: p.sharedFiles } : {}), ...(p.delivery ? { delivery: p.delivery } : {}) };
  }
  const peopleCfg = {};
  for (const [name, p] of Object.entries(people)) {
    peopleCfg[name] = { roles: p.roles || [], ...(p.projects ? { projects: p.projects } : {}), ...(p.key ? { keyHash: hashHumanKey(p.key) } : {}), ...(p.accounts ? { accounts: p.accounts } : {}) };
  }
  const cfg = { version: 2, server: { host: '127.0.0.1', port: randomPort() }, defaultProject: Object.keys(projects)[0], people: peopleCfg, owners, ...config };
  fs.writeFileSync(path.join(home, 'synapse.config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify(registry, null, 2));
  fs.writeFileSync(path.join(home, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return { home, keys, env, config: cfg, registry };
}

export async function startBus(opts = {}) {
  const fx = makeHome(opts);
  let bus;
  let lastErr;
  for (let i = 0; i < 5; i++) {
    const port = randomPort();
    bus = await createBus({ home: fx.home, env: {}, port, host: '127.0.0.1', log: () => {}, channelImporter: opts.channelImporter });
    try { await bus.start(); lastErr = null; break; } catch (e) { lastErr = e; await bus.stop(); }
  }
  if (lastErr) throw lastErr;
  if (bus.port === FORBIDDEN_PORT) throw new Error('test bus bound the forbidden port');
  const base = `http://127.0.0.1:${bus.port}`;
  const call = async (method, p, { key, project, human, body, headers: extra = {}, raw } = {}) => {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (key !== undefined) headers['X-Dev-Key'] = key;
    if (project !== undefined) headers['X-Dev-Project'] = project;
    if (human !== undefined) headers['X-Synapse-Human'] = human;
    const r = await fetch(base + p, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const close = async () => { await bus.stop(); fs.rmSync(fx.home, { recursive: true, force: true }); };
  return { ...fx, bus, base, wsUrl: `ws://127.0.0.1:${bus.port}/ws`, call, close };
}
