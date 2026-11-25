// Shared setup for the client tests. Not a test file itself.
//
// pinEnv() must run before client/index.js is imported: the client reads its identity, key and home at import time, and the
// session that runs these tests may export its own DEV_SYNC_SEAT, DEV_SYNC_DEVELOPER or SYNAPSE_HOME. listenInRange() binds a
// mock server on a random port in 4600-4999, so no test can reach a real bus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const busProof = createRequire(import.meta.url)('../../shared/bus-proof.cjs');
// Every test home holds this bus secret (a fixed dummy), so a mock bus can prove itself the way the real bus does.
export const TEST_BUS_SECRET = 'ab'.repeat(32);
export function writeBusSecret(home, secret = TEST_BUS_SECRET) {
  fs.mkdirSync(path.join(home, 'data'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'data', 'bus-secret'), `${secret}\n`, { mode: 0o600 });
  return home;
}
// For a mock bus: answers GET /api/bus-proof as the real bus would (with `secret`) and returns true; else false.
export function answerBusProof(req, res, { secret = TEST_BUS_SECRET, pid = 4242, instance = 'mock-bus' } = {}) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/api/bus-proof') return false;
  const nonce = u.searchParams.get('nonce') || '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ pid, instance, proof: busProof.proofFor(secret, nonce, pid, instance) }));
  return true;
}

export const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client');
export const CLIENT_INDEX = path.join(CLIENT_DIR, 'index.js');

// The variables the client reads that the ambient session may carry.
const AMBIENT = ['DEV_SYNC_DEVELOPER', 'DEV_SYNC_PROJECT', 'DEV_SYNC_URL', 'DEV_SYNC_KEY', 'DEV_SYNC_API_TIMEOUT_MS', 'DEV_SYNC_UPLOAD_TIMEOUT_MS',
  'DEV_SYNC_THREAD_CONTEXT', 'DEV_SYNC_RECONNECT_MS', 'CLAUDE_CODE_SESSION_ID', 'SYNAPSE_FILES_DIR', 'CLAUDE_EFFORT', 'EFFORT_LEVEL', 'CLAUDE_MODEL', 'MODEL'];

export function tempHome(prefix = 'synapse-client-home-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Writes the home files the client binds to: projects.json registering `project` at `root` with key variable `keyEnv`,
// and, when `port` is given, synapse.config.json pointing at 127.0.0.1:<port> (the only bus the client will talk to).
export function bindHome(home, { port, project = 'testproj', keyEnv = 'DEV_SYNC_KEY', root = process.cwd(), roster } = {}) {
  writeBusSecret(home);
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [project]: { keyEnv, root: root.replace(/\\/g, '/'), ...(roster ? { roster } : {}) } } }));
  if (port !== undefined) fs.writeFileSync(path.join(home, 'synapse.config.json'), JSON.stringify({ version: 2, server: { host: '127.0.0.1', port } }));
  return home;
}

// Pins this process's environment for an import-only client. Returns the temp home, which registers project testproj at
// this process's working folder (key variable DEV_SYNC_KEY); `bind.port` points the client at a mock bus.
export function pinEnv(extra = {}, bind = {}) {
  for (const k of AMBIENT) delete process.env[k];
  const home = bindHome(tempHome(), bind);
  Object.assign(process.env, {
    SYNAPSE_MCP_IMPORT_ONLY: '1',
    DEV_SYNC_SEAT: '',
    SYNAPSE_HOME: home,
    DEV_SYNC_KEY: 'test-key',
  }, extra);
  return home;
}

// An environment for a child process: the parent's minus every ambient client variable, with the seat and home pinned.
export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of [...AMBIENT, 'DEV_SYNC_SEAT', 'SYNAPSE_HOME', 'SYNAPSE_MCP_IMPORT_ONLY']) delete env[k];
  return { ...env, DEV_SYNC_SEAT: '', SYNAPSE_HOME: tempHome(), ...extra };
}

// Binds `server` on 127.0.0.1 at a random free port in 4600-4999 and returns the port.
export async function listenInRange(server, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 60; attempt++) {
    const port = 4600 + Math.floor(Math.random() * 400);
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => { server.off('listening', onListening); reject(e); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
    }
  }
  throw new Error('no free port in 4600-4999');
}

export function closeServer(server) {
  try { server.closeAllConnections?.(); server.close(); } catch { /* already closed */ }
}
