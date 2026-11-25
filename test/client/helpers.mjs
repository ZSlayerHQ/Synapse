// Shared setup for the client tests. Not a test file itself.
//
// pinEnv() must run before client/index.js is imported: the client reads its identity, key and home at import time, and the
// session that runs these tests may export its own DEV_SYNC_SEAT, DEV_SYNC_DEVELOPER or SYNAPSE_HOME. listenInRange() binds a
// mock server on a random port in 4600-4999, so no test can reach a real bus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client');
export const CLIENT_INDEX = path.join(CLIENT_DIR, 'index.js');

// The variables the client reads that the ambient session may carry.
const AMBIENT = ['DEV_SYNC_DEVELOPER', 'DEV_SYNC_PROJECT', 'DEV_SYNC_URL', 'DEV_SYNC_KEY', 'DEV_SYNC_API_TIMEOUT_MS', 'DEV_SYNC_UPLOAD_TIMEOUT_MS',
  'DEV_SYNC_THREAD_CONTEXT', 'DEV_SYNC_RECONNECT_MS', 'CLAUDE_CODE_SESSION_ID', 'SYNAPSE_FILES_DIR', 'CLAUDE_EFFORT', 'EFFORT_LEVEL', 'CLAUDE_MODEL', 'MODEL'];

export function tempHome(prefix = 'synapse-client-home-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Pins this process's environment for an import-only client. Returns the temp home.
export function pinEnv(extra = {}) {
  for (const k of AMBIENT) delete process.env[k];
  const home = tempHome();
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
