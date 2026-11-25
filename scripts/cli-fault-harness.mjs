// Test-only: run the synapse CLI with chosen steps failing, to check its rollback on the real file system. Not part of
// the installed app (init copies no scripts/). The CLI reads no environment variable for this: the harness sets an
// in-process hook before it imports the CLI.
// Usage: node scripts/cli-fault-harness.mjs <step[,step]> <synapse arguments...>
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [steps, ...rest] = process.argv.slice(2);
const failing = new Set(String(steps || '').split(',').filter(Boolean));
globalThis.__synapseCliOps = {
  check(step) { if (failing.has(step)) throw Object.assign(new Error(`injected test fault at ${step}`), { code: 'ETESTFAULT' }); },
};
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'synapse.mjs');
process.argv = [process.argv[0], cli, ...rest];
await import(pathToFileURL(cli).href);
