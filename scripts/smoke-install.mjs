// Clean-install self-test: a temporary SYNAPSE_HOME and a temporary project, the CLI end to end, the MCP client over
// stdio, the hooks as Claude Code runs them (parsed structured output), the doctor's failure cases, and an uninstall that
// must leave unrelated files alone. Touches nothing outside the OS temp folder. Usage: node scripts/smoke-install.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const REPO = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const CLI = path.join(REPO, 'bin', 'synapse.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse smoke & co-')); // a space and an & in the path, on purpose
const HOME = path.join(tmp, 'home');
const OUTER = path.join(tmp, 'outer repo');
const PROJ = path.join(OUTER, 'demo-app'); // a project folder inside another git root
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
// A random port in 4600-4999 that nothing is listening on right now (never 4100).
const portFree = (p) => new Promise((resolve) => { const srv = net.createServer(); srv.once('error', () => resolve(false)); srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true))); });
let port;
for (let i = 0; ; i++) {
  port = 4600 + Math.floor(Math.random() * 400);
  if (port !== 4100 && await portFree(port)) break;
  if (i > 50) throw new Error('no free port in 4600-4999');
}
const env = { ...process.env, SYNAPSE_HOME: HOME };
for (const k of ['DEV_SYNC_SEAT', 'DEV_SYNC_KEY', 'DEV_SYNC_URL', 'DEV_SYNC_PROJECT', 'DEV_SYNC_DEVELOPER']) delete env[k];
const HUMAN_KEY = 'smoke-test-personal-key-0001';
const results = [];
const step = (name, okv, detail = '') => { results.push({ name, ok: !!okv }); console.log(`${okv ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const cli = (args, input, extraEnv = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout: 90_000 });
// Test-only: the CLI with chosen steps failing (scripts/cli-fault-harness.mjs; the shipped CLI reads no variable for it).
const cliFault = (steps, args) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'cli-fault-harness.mjs'), steps, ...args], { env, encoding: 'utf8', timeout: 90_000 });
const last = (s, n = 1) => String(s || '').trim().split('\n').slice(-n).join(' | ');
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

let gitOk = true;
try { execFileSync('git', ['init', '-q'], { cwd: OUTER }); } catch (e) { gitOk = false; }
step('git init of the outer repo (git is a prerequisite)', gitOk);

// Unrelated files the install must leave alone.
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
fs.mkdirSync(path.join(PROJ, '.synapse'), { recursive: true });
fs.writeFileSync(path.join(PROJ, '.synapse', 'my-notes.txt'), 'mine');
const foreignHook = { type: 'command', command: 'node', args: ['/some/where/else.js'] };
fs.writeFileSync(path.join(PROJ, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreignHook] }] } }, null, 2));
fs.writeFileSync(path.join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'other-server' } } }, null, 2));

let r = cli(['init', '--owner', 'tester', '--port', String(port)]);
step('init', r.status === 0 && fs.existsSync(path.join(HOME, 'app', 'client', 'index.js')) && fs.existsSync(path.join(HOME, '.synapse-home')), last(r.stdout || r.stderr));
if (process.platform !== 'win32') step('init: .env is mode 600', (fs.statSync(path.join(HOME, '.env')).mode & 0o777) === 0o600);
const userInApp = path.join(HOME, 'app', 'server', 'user-note.txt');
fs.writeFileSync(userInApp, 'my note inside the app');
r = cli(['init']);
step('init again refuses while the app holds a file Synapse did not install, names it, and moves nothing', r.status !== 0 && /did not install \(server\/user-note\.txt\)/.test(r.stderr) && fs.existsSync(userInApp), last(r.stderr));
fs.rmSync(userInApp);
r = cli(['init']);
step('init again keeps the config and swaps the app in place', r.status === 0 && /kept the existing/.test(r.stdout) && !fs.readdirSync(HOME).some((n) => n.startsWith('app.')), last(r.stdout));
// Real rollback on the real file system, with a fault injected at a step boundary by the test harness.
const manifestFile = path.join(HOME, 'install-manifest.json');
const clientFile = path.join(HOME, 'app', 'client', 'index.js');
let manBefore = fs.readFileSync(manifestFile, 'utf8');
r = cli(['init'], undefined, { SYNAPSE_TEST_FAULT: 'reinit-verify' });
step('the shipped CLI ignores a fault variable in its environment', r.status === 0, last(r.stderr || r.stdout));
manBefore = fs.readFileSync(manifestFile, 'utf8'); // that successful init rewrote it
r = cliFault('reinit-verify', ['init']);
step('a re-init that fails after the swap puts the previous app and manifest back and exits 1', r.status === 1 && /previous app and manifest were put back/.test(r.stderr) && fs.readFileSync(manifestFile, 'utf8') === manBefore && fs.existsSync(clientFile) && !fs.readdirSync(HOME).some((n) => n.startsWith('app.')), last(r.stderr));
r = cliFault('reinit-verify,reinit-restore-app', ['init']);
const leftovers = fs.readdirSync(HOME).filter((n) => n.startsWith('app.'));
step('when the rollback itself fails, init exits 1 and says where everything is, never success', r.status === 1 && /rollback did not finish/.test(r.stderr) && !/were put back/.test(r.stderr) && !fs.existsSync(path.join(HOME, 'app')) && leftovers.length === 2 && fs.readFileSync(manifestFile, 'utf8') === manBefore, last(r.stderr));
// Recover as the message says: the previous app back at app/, then init runs cleanly.
fs.renameSync(path.join(HOME, leftovers.find((n) => n.startsWith('app.previous-'))), path.join(HOME, 'app'));
fs.rmSync(path.join(HOME, leftovers.find((n) => n.startsWith('app.staging-'))), { recursive: true, force: true });
for (const n of fs.readdirSync(HOME).filter((x) => x.startsWith('install-manifest.json.before-'))) fs.rmSync(path.join(HOME, n));
r = cli(['init']);
step('after that manual recovery, init succeeds again', r.status === 0 && fs.existsSync(clientFile), last(r.stdout || r.stderr));
r = cliFault('cleanup', ['init']);
const oldCopy = fs.readdirSync(HOME).find((n) => n.startsWith('app.previous-'));
step('a cleanup failure after a verified upgrade is a warning: exit 0, the old copy named', r.status === 0 && !!oldCopy && r.stdout.includes(oldCopy) && fs.existsSync(clientFile), last(r.stdout, 2));
if (oldCopy) fs.rmSync(path.join(HOME, oldCopy), { recursive: true, force: true });
const styleFile = path.join(HOME, 'app', 'dashboard', 'style.css');
const styleText = fs.readFileSync(styleFile, 'utf8');
fs.appendFileSync(styleFile, '\n/* my change */\n');
r = cli(['init']);
step('init again refuses while an installed app file was changed, and changes nothing', r.status !== 0 && /1 changed file\(s\) \(dashboard\/style\.css\)/.test(r.stderr) && fs.readFileSync(styleFile, 'utf8').includes('my change'), last(r.stderr));
fs.writeFileSync(styleFile, styleText);
r = cli(['set-human-key', 'tester', '--stdin'], 'has spaces in it ok\n');
step('set-human-key refuses a key with spaces', r.status !== 0, last(r.stderr));
r = cli(['set-human-key', 'tester', '--stdin'], `${HUMAN_KEY}\n`);
step('set-human-key (stdin)', r.status === 0 && readJ(path.join(HOME, 'synapse.config.json')).people.tester.keyHash.startsWith('scrypt$'));
step('config holds no plaintext personal key', !fs.readFileSync(path.join(HOME, 'synapse.config.json'), 'utf8').includes(HUMAN_KEY));
fs.writeFileSync(path.join(PROJ, '.claude', 'settings.local.json.bak'), 'not json {');
r = cli(['add-project', PROJ, '--bot', 'demobot']);
step('add-project (machine-local by default)', r.status === 0, last(r.stdout, 2));
step('add-project printed the launch line', /claude --dangerously-load-development-channels server:synapse/.test(r.stdout));
const mcp = readJ(path.join(PROJ, '.mcp.json'));
const settings = readJ(path.join(PROJ, '.claude', 'settings.local.json'));
const projKey = fs.readFileSync(path.join(HOME, '.env'), 'utf8').match(/^SYNAPSE_KEY_DEMO_APP=(.+)$/m)?.[1];
step('.mcp.json: synapse added, the other server kept, no key in the file', !!mcp.mcpServers.synapse && !!mcp.mcpServers.other && !JSON.stringify(mcp).includes(projKey));
const WANT = { SessionStart: [null, 'session-checkin.cjs'], SessionEnd: [null, 'session-checkout.cjs'], PreToolUse: ['Edit|Write|MultiEdit', 'pre-edit-check.cjs'], PostToolUse: ['Edit|Write|MultiEdit|Bash', 'post-sync.cjs'] };
const ours = (h) => Array.isArray(h.args) && String(h.args[0]).replace(/\\/g, '/').includes('/app/hooks/');
const wiringOk = Object.entries(WANT).every(([ev, [matcher, script]]) => {
  const groups = (settings.hooks[ev] || []).filter((g) => (g.hooks || []).some(ours));
  return groups.length === 1 && (groups[0].matcher || null) === matcher && groups[0].hooks.filter(ours).length === 1
    && groups[0].hooks[0].command === 'node' && groups[0].hooks[0].args[0].endsWith(`/app/hooks/${script}`) && fs.existsSync(groups[0].hooks[0].args[0]);
});
step('settings.local.json: each event once, exact matcher, exec-form node + existing script', wiringOk);
step('settings.local.json: the unrelated hook and permissions are kept', JSON.stringify(settings).includes('/some/where/else.js') && settings.permissions.allow.includes('Bash(ls)'));
step('no shared settings.json was written', !fs.existsSync(path.join(PROJ, '.claude', 'settings.json')));
const exclude = path.join(OUTER, '.git', 'info', 'exclude');
const excludeText = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
step('machine-local ignore: the enclosing repo\'s .git/info/exclude, not a committed .gitignore', excludeText.includes('/demo-app/.synapse/') && !fs.existsSync(path.join(PROJ, '.gitignore')) && !fs.existsSync(path.join(OUTER, '.gitignore')));
const ignoredInOuter = (rel) => spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: OUTER }).status === 0;
step('git ignores the machine-local settings and the pre-existing untracked .mcp.json', ignoredInOuter('demo-app/.claude/settings.local.json') && ignoredInOuter('demo-app/.mcp.json') && ignoredInOuter('demo-app/.synapse/config.json'));
// A repository that tracks .claude/settings.local.json: refused, nothing written.
const TRACKED = path.join(tmp, 'tracked repo');
fs.mkdirSync(path.join(TRACKED, '.claude'), { recursive: true });
fs.writeFileSync(path.join(TRACKED, '.claude', 'settings.local.json'), '{}\n');
const g = (a) => spawnSync('git', ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', ...a], { cwd: TRACKED, encoding: 'utf8' });
g(['init', '-q']); g(['add', '-f', '.claude/settings.local.json']); g(['commit', '-q', '-m', 'x']);
const regBefore = fs.readFileSync(path.join(HOME, 'projects.json'), 'utf8');
r = cli(['add-project', TRACKED, '--bot', 'trackedbot']);
step('add-project refuses a tracked .claude/settings.local.json and writes nothing', r.status !== 0 && /tracked in git/.test(r.stderr) && fs.readFileSync(path.join(HOME, 'projects.json'), 'utf8') === regBefore && !fs.existsSync(path.join(TRACKED, '.synapse')), last(r.stderr));
// The install lock is never taken over: a lock being written, or left by a dead process, is reported; unlock clears a
// dead one only.
const lockFile = path.join(HOME, '.install.lock');
fs.writeFileSync(lockFile, '');
r = cli(['add-project', PROJ, '--bot', 'demobot']);
step('an unreadable install lock is reported with the unlock command, not taken over', r.status !== 0 && /synapse unlock/.test(r.stderr) && fs.existsSync(lockFile));
r = cli(['unlock']);
step('unlock leaves a lock created moments ago that names no process', r.status !== 0 && fs.existsSync(lockFile));
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'live', at: Date.now() }));
r = cli(['unlock']);
step('unlock refuses while the lock holder is alive', r.status !== 0 && /still running/.test(r.stderr) && fs.existsSync(lockFile));
fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, token: 'dead', at: Date.now() }));
r = cli(['add-project', PROJ, '--bot', 'demobot']);
step('a lock left by a dead process is reported with the unlock command', r.status !== 0 && /no longer running/.test(r.stderr) && /synapse unlock/.test(r.stderr));
r = cli(['unlock']);
step('unlock clears a lock whose process is gone', r.status === 0 && !fs.existsSync(lockFile));
r = cli(['add-project', PROJ, '--bot', 'demobot']);
step('add-project again is idempotent', r.status === 0 && Object.values(readJ(path.join(PROJ, '.claude', 'settings.local.json')).hooks).flat().filter((g) => (g.hooks || []).some(ours)).length === 4);
// Real rollback of a multi-file change: a fault at the third write, then a fault in the restore as well.
const regPath = path.join(HOME, 'projects.json');
const regSnap = fs.readFileSync(regPath, 'utf8');
r = cliFault('write-3', ['add-project', PROJ, '--bot', 'demobot', '--name', 'Renamed']);
step('add-project failing at its third write puts every file back and exits 1', r.status === 1 && /put back, so nothing was changed/.test(r.stderr) && fs.readFileSync(regPath, 'utf8') === regSnap && !fs.readdirSync(HOME).some((n) => n.endsWith('.tmp')), last(r.stderr));
r = cliFault('write-3,restore', ['add-project', PROJ, '--bot', 'demobot', '--name', 'Renamed']);
step('when a file cannot be put back, add-project names it and never says nothing changed', r.status === 1 && /could not be put back/.test(r.stderr) && r.stderr.includes('projects.json') && !/nothing was changed/.test(r.stderr), last(r.stderr).slice(0, 120));
r = cli(['add-project', PROJ, '--bot', 'demobot', '--name', 'demo-app']);
step('add-project runs cleanly after that', r.status === 0 && readJ(regPath).projects['demo-app'].displayName === 'demo-app', last(r.stderr || r.stdout));
r = cli(['doctor', '--project', PROJ]);
step('doctor before start: passes, the down bus is a note', r.status === 0, last(r.stdout));
r = cli(['doctor', '--ready', '--project', PROJ]);
step('doctor --ready before start: fails on the unreachable bus', r.status === 1 && /bus not reachable/.test(r.stdout));
r = cli(['start', '--background']);
step('start --background', r.status === 0, last(r.stdout || r.stderr));
r = cli(['doctor', '--ready', '--project', PROJ]);
step('doctor --ready: all checks pass, including the MCP probe, from a home path with spaces and &', r.status === 0 && /the client starts and lists/.test(r.stdout) && HOME.includes('&'), last(r.stdout));
step('doctor passes no argument list through a shell (no DEP0190 warning)', !/DEP0190|shell option/.test(r.stderr), r.stderr.trim().slice(0, 100));
if (r.status !== 0) console.log(r.stdout);

// Doctor must catch a broken MCP command and broken hook wiring.
const mcpFile = path.join(PROJ, '.mcp.json');
const good = fs.readFileSync(mcpFile, 'utf8');
const broken = readJ(mcpFile); broken.mcpServers.synapse.command = 'definitely-not-node';
fs.writeFileSync(mcpFile, JSON.stringify(broken));
r = cli(['doctor', '--project', PROJ]);
step('doctor fails on a wrong MCP command', r.status === 1 && /command is "definitely-not-node"/.test(r.stdout));
// --ready must never start an entry it rejected: same args, but another executable and an env that would run a canary.
const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-canary-'));
const canary = path.join(canaryDir, 'canary.cjs');
const canaryHit = path.join(canaryDir, 'ran.txt');
fs.writeFileSync(canary, `require('fs').writeFileSync(${JSON.stringify(canaryHit)}, 'ran');`);
const trap = readJ(mcpFile);
trap.mcpServers.synapse.command = process.execPath;
trap.mcpServers.synapse.env = { ...trap.mcpServers.synapse.env, NODE_OPTIONS: `--require "${canary}"` };
fs.writeFileSync(mcpFile, JSON.stringify(trap));
r = cli(['doctor', '--ready', '--project', PROJ]);
const trapFails = r.stdout.split('\n').filter((l) => l.includes('FAIL'));
step('doctor --ready, bus healthy: rejects only the changed MCP entry and never starts it', r.status === 1 && /bus healthy/.test(r.stdout) && trapFails.length >= 2 && trapFails.every((l) => /\.mcp\.json synapse|MCP probe not run/.test(l)) && !fs.existsSync(canaryHit), trapFails.join(' | ').slice(0, 160));
fs.writeFileSync(mcpFile, good);
fs.rmSync(canaryDir, { recursive: true, force: true });
const sFile = path.join(PROJ, '.claude', 'settings.local.json');
const goodS = fs.readFileSync(sFile, 'utf8');
const s2 = readJ(sFile); delete s2.hooks.PreToolUse; s2.hooks.PostToolUse.push(s2.hooks.PostToolUse.find((g) => (g.hooks || []).some(ours)));
fs.writeFileSync(sFile, JSON.stringify(s2));
r = cli(['doctor', '--project', PROJ]);
step('doctor fails on a missing PreToolUse and a duplicated PostToolUse', r.status === 1 && /hook PreToolUse: missing/.test(r.stdout) && /hook PostToolUse: 2 Synapse entries/.test(r.stdout));
fs.writeFileSync(sFile, goodS);

// The MCP client over stdio, launched exactly as .mcp.json says.
const entry = readJ(mcpFile).mcpServers.synapse;
const SESSION = 'smoke-session-1';
const client = spawn(entry.command, entry.args, { cwd: PROJ, env: { ...env, ...entry.env, DEV_SYNC_SEAT: 'left', CLAUDE_CODE_SESSION_ID: SESSION }, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const msgs = [];
client.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { msgs.push(JSON.parse(line)); } catch {} } });
let stderr = '';
client.stderr.on('data', (d) => { stderr += d; });
let nextId = 1;
const rpc = (method, params) => { const id = nextId++; client.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return id; };
const waitFor = async (pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = msgs.find(pred); if (m) return m; await new Promise((res) => setTimeout(res, 50)); } return null; };
const initId = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
const init = await waitFor((m) => m.id === initId);
step('MCP initialize', !!init?.result, init?.result?.serverInfo?.name);
step('MCP advertises the claude/channel capability', !!init?.result?.capabilities?.experimental?.['claude/channel']);
client.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
await new Promise((res) => setTimeout(res, 1500));
const listId = rpc('tools/list', {});
const list = await waitFor((m) => m.id === listId);
const names = (list?.result?.tools || []).map((t) => t.name);
step('tools/list: core tools present, cut tools absent', ['dev_msg_send', 'dev_ask', 'dev_sync_lock', 'dev_sync_checkin'].every((n) => names.includes(n)) && !names.some((n) => /dev_service_|dev_job_|dev_session_control|dev_bus_status/.test(n)), `${names.length} tools`);
const call = async (name, a) => { const id = rpc('tools/call', { name, arguments: a }); const m = await waitFor((x) => x.id === id); return m?.result; };
let res = await call('dev_sync_checkin', { branch: 'main' });
step('dev_sync_checkin', !!res && !res.isError, (res?.content?.[0]?.text || '').split('\n')[0]);
res = await call('dev_ask', { question: 'Smoke test: pick one', options: ['Alpha', 'Beta'] });
const askText = res?.content?.[0]?.text || '';
const askId = askText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
step('dev_ask parked a card and names the dashboard URL', !!askId && askText.includes(`http://127.0.0.1:${port}/`), askText.slice(0, 90));
const base = `http://127.0.0.1:${port}`;
const human = { 'Content-Type': 'application/json', 'X-Synapse-Human': 'tester', 'X-Dev-Key': HUMAN_KEY };
const open = await (await fetch(`${base}/api/ask/open`, { headers: human })).json();
step('the owner sees the card via the dashboard API', open.cards?.some((c) => c.askId === askId));
const dash = await fetch(`${base}/`);
step('dashboard page served on loopback', dash.status === 200 && (await dash.text()).includes('Decision cards'));
const ans = await fetch(`${base}/api/ask/${askId}/answer`, { method: 'POST', headers: human, body: JSON.stringify({ label: 'Beta' }) });
step('the owner answers; delivered live to the asking seat', ans.status === 200 && (await ans.json()).delivered === true);
const chan = await waitFor((m) => m.method === 'notifications/claude/channel' && JSON.stringify(m.params).includes(askId));
step('the answer arrives in the session as a channel notification', !!chan, chan ? String(chan.params?.content || '').slice(0, 70) : stderr.slice(-200));
await new Promise((res2) => setTimeout(res2, 500));
const pend = await (await fetch(`${base}/api/ask/pending-answers?seat=demobot.left`, { headers: { 'X-Dev-Key': projKey, 'X-Dev-Project': 'demo-app' } })).json();
step('the client acked the answer (the outbox is empty)', Array.isArray(pend.answers) && pend.answers.length === 0, JSON.stringify(pend).slice(0, 80));
res = await call('dev_notify_human', { message: 'smoke ping', tag: 'tester' });
step('dev_notify_human queues on the dashboard and says nobody was pinged', /queued on the Synapse dashboard/.test(res?.content?.[0]?.text || ''));

// Hooks, run as Claude Code runs them: exec form, JSON on stdin, structured JSON on stdout.
const hookPath = (script) => Object.values(settings.hooks).flat().flatMap((g) => g.hooks).find((h) => ours(h) && h.args[0].endsWith(script)).args[0];
const runHook = (script, payload, cwd = PROJ) => spawnSync('node', [hookPath(script)], { cwd, env, input: JSON.stringify({ cwd, ...payload }), encoding: 'utf8', timeout: 10_000 });
const seatFile = path.join(HOME, 'data', 'seats', `${crypto.createHash('sha256').update(SESSION).digest('hex').slice(0, 32)}.json`);
step('the client wrote its seat file for the hooks', fs.existsSync(seatFile) && readJ(seatFile).developer === 'demobot.left');
const lockAs = (developer, file) => fetch(`${base}/api/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-Key': projKey, 'X-Dev-Project': 'demo-app' }, body: JSON.stringify({ developer, file }) });
await lockAs('demobot.other', 'src/locked.js');
await lockAs('demobot.left', 'src/mine.js');
let h = runHook('pre-edit-check.cjs', { hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'src', 'locked.js') } }, path.join(PROJ, 'src'));
step('pre-edit hook (from a subfolder) blocks a file locked by another seat: exit 2', h.status === 2 && /locked by demobot.other/.test(h.stderr), h.stderr.trim().slice(0, 80));
h = runHook('pre-edit-check.cjs', { hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'src', 'mine.js') } });
step('pre-edit hook: the session\'s own client lock (seat from the seat file) does not block it', h.status === 0, h.stderr.trim().slice(0, 80));
await fetch(`${base}/api/did-edit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-Key': projKey, 'X-Dev-Project': 'demo-app' }, body: JSON.stringify({ developer: 'demobot.other', file: 'src/hot.js' }) });
h = runHook('pre-edit-check.cjs', { hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'src', 'hot.js') } });
let out = null; try { out = JSON.parse(h.stdout); } catch {}
step('pre-edit warning reaches Claude as structured context on stdout', h.status === 0 && out?.hookSpecificOutput?.hookEventName === 'PreToolUse' && /edited by demobot.other/.test(out.hookSpecificOutput.additionalContext));
h = runHook('session-checkin.cjs', { hook_event_name: 'SessionStart', session_id: 'fresh-session' });
out = null; try { out = JSON.parse(h.stdout); } catch {}
step('session-checkin gives Claude its context as SessionStart additionalContext', h.status === 0 && out?.hookSpecificOutput?.hookEventName === 'SessionStart' && /checked in as "demobot"/.test(out.hookSpecificOutput.additionalContext), (out?.hookSpecificOutput?.additionalContext || h.stdout).split('\n')[0]);
client.stdin.end(); client.kill();
await new Promise((res2) => setTimeout(res2, 500));

// An alert for a seat with no live socket stays pending; the next post-sync hands it to Claude, then acks it.
await fetch(`${base}/api/alert`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-Key': projKey, 'X-Dev-Project': 'demo-app' }, body: JSON.stringify({ from: 'demobot.other', to: 'demobot.right', message: 'look at hot.js' }) });
h = spawnSync('node', [hookPath('post-sync.cjs')], { cwd: PROJ, env: { ...env, DEV_SYNC_SEAT: 'right' }, input: JSON.stringify({ cwd: PROJ, hook_event_name: 'PostToolUse', session_id: 'no-seat-file', tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'src', 'a.js') } }), encoding: 'utf8', timeout: 10_000 });
out = null; try { out = JSON.parse(h.stdout); } catch {}
step('post-sync hands a pending alert to Claude as PostToolUse context', h.status === 0 && /look at hot\.js/.test(out?.hookSpecificOutput?.additionalContext || ''));
const left = await (await fetch(`${base}/api/alerts/demobot.right`, { headers: { 'X-Dev-Key': projKey, 'X-Dev-Project': 'demo-app' } })).json();
step('the alert was acked after it reached Claude', Array.isArray(left.alerts) && left.alerts.length === 0);

// Two projects: every check of every project runs before any probe, so a broken second project means no probe at all.
const SECOND = path.join(tmp, 'second');
fs.mkdirSync(SECOND);
r = cli(['add-project', SECOND, '--bot', 'secondbot']);
step('a second project is added (the running bus does not know it yet)', r.status === 0, last(r.stderr || r.stdout));
r = cli(['doctor', '--ready']);
step('doctor --ready with a failing second project starts no MCP client, not even the first project\'s', r.status === 1 && !/the client starts and lists/.test(r.stdout) && /MCP probe not run/.test(r.stdout), last(r.stdout, 2));

// stop must refuse a pid it cannot prove is this bus.
const ownerFile = path.join(HOME, 'data', 'bus-owner.json');
const realOwner = fs.readFileSync(ownerFile, 'utf8');
fs.writeFileSync(ownerFile, JSON.stringify({ ...JSON.parse(realOwner), pid: process.pid, instance: 'not-this-one' }));
r = cli(['stop']);
step('stop refuses an unverified pid (and this process is still alive)', r.status === 1 && /not answering as this bus/.test(r.stderr));
fs.writeFileSync(ownerFile, realOwner);
r = cli(['stop']);
step('stop (verified)', r.status === 0, last(r.stdout));

// The Discord pack. The bus is stopped here, so nothing below can contact Discord.
const cfgFile = path.join(HOME, 'synapse.config.json');
const DID = { user: '700000000000000101', code: '700000000000000201', app: '700000000000000001' };
// A made-up token with a bot token's shape (built here, so this file holds no token-shaped text).
const TOKEN = [Buffer.from(DID.app).toString('base64url'), crypto.randomBytes(5).toString('base64url'), crypto.randomBytes(24).toString('base64url')].join('.');
const said = (x) => `${x.stdout}${x.stderr}`;
r = cli(['discord', 'setup', '--stdin', '--person', `nobody=${DID.user}`], `${TOKEN}\n`);
step('discord setup refuses an unknown person and changes nothing', r.status !== 0 && /not in people/.test(r.stderr) && readJ(cfgFile).discord.enabled === false, last(r.stderr));
r = cli(['discord', 'setup', '--stdin', '--channel', `demo-app/code=${DID.code}`], `${'x'.repeat(60)}\n`);
step('discord setup refuses a long placeholder that is not shaped like a bot token', r.status !== 0 && /does not look like a bot token/.test(r.stderr) && readJ(cfgFile).discord.enabled === false, last(r.stderr));
r = cli(['discord', 'setup', '--stdin', '--channel', `demo-app/code=${DID.code}`, '--person', `tester=${DID.user}`], `${TOKEN}\n`, { SYNAPSE_DISCORD_TOKEN: 'a-different-value-in-the-shell' });
step('discord setup refuses while the token variable is set in the shell (it would win over .env at boot)', r.status !== 0 && /set in this shell's environment/.test(r.stderr) && readJ(cfgFile).discord.enabled === false, last(r.stderr));
const aliasCfg = readJ(cfgFile);
fs.writeFileSync(cfgFile, JSON.stringify({ ...aliasCfg, discord: { ...aliasCfg.discord, tokenEnv: 'SYNAPSE_KEY_DEMO_APP' } }, null, 2));
r = cli(['discord', 'setup', '--channel', `demo-app/code=${DID.code}`]);
step('discord setup refuses a token variable that holds a bus key', r.status !== 0 && /holds a bus key/.test(r.stderr), last(r.stderr));
fs.writeFileSync(cfgFile, JSON.stringify(aliasCfg, null, 2));
r = cli(['discord', 'setup', '--stdin', '--channel', `demo-app/code=${DID.code}`, '--channel', `second/code=${DID.code}`, '--person', `tester=${DID.user}`], `${TOKEN}\n`);
step('discord setup refuses one Discord channel mapped to two projects, and changes nothing', r.status !== 0 && /mapped to both project/.test(r.stderr) && readJ(cfgFile).discord.enabled === false && !fs.readFileSync(path.join(HOME, '.env'), 'utf8').includes(TOKEN), last(r.stderr));
r = cli(['discord', 'setup', '--stdin', '--channel', `demo-app/code=${DID.code}`, '--person', `tester=${DID.user}`], `${TOKEN}\n`);
const cfgNow = readJ(cfgFile);
step('discord setup: on, the token in .env, the account and channel ids in the config', r.status === 0 && cfgNow.discord.enabled === true && fs.readFileSync(path.join(HOME, '.env'), 'utf8').includes(`SYNAPSE_DISCORD_TOKEN=${TOKEN}`) && cfgNow.people.tester.accounts.discord === DID.user && cfgNow.discord.projects['demo-app'].channels.code === DID.code && !JSON.stringify(cfgNow).includes(TOKEN), last(r.stdout || r.stderr));
step('discord setup printed neither the token nor any Discord id', !said(r).includes(TOKEN) && !said(r).includes(DID.user) && !said(r).includes(DID.code) && /permissions=68608/.test(r.stdout));
if (process.platform !== 'win32') step('discord setup: .env is still mode 600', (fs.statSync(path.join(HOME, '.env')).mode & 0o777) === 0o600);
r = cli(['discord', 'setup']);
step('discord setup again keeps the stored token without asking', r.status === 0 && /kept the one in/.test(r.stdout), last(r.stdout || r.stderr));
r = cli(['doctor', '--project', PROJ]);
step('doctor checks the pack: token set (not shown), discord.js installed, a channel mapped, one answerer', r.status === 0 && /discord: bot token set/.test(r.stdout) && /1 channel\(s\) mapped/.test(r.stdout) && /1 owner\(s\) or approver\(s\) can answer on Discord/.test(r.stdout) && /discord\.js package loads/.test(r.stdout) && !said(r).includes(TOKEN) && !said(r).includes(DID.user), last(r.stdout));
if (process.platform === 'win32') {
  // Windows environment names ignore case, and the bus reads process.env directly: the checks must see the same value.
  r = cli(['doctor', '--project', PROJ], undefined, { Synapse_Discord_Token: 'x'.repeat(60) });
  step('doctor sees a token variable spelled in another case, as the bus does on Windows', r.status === 1 && /does not look like a Discord bot token/.test(r.stdout), last(r.stdout));
  r = cli(['discord', 'setup', '--channel', `demo-app/code=${DID.code}`], undefined, { Synapse_Discord_Token: 'x'.repeat(60) });
  step('discord setup refuses a token variable in the shell spelled in another case', r.status !== 0 && /set in this shell's environment/.test(r.stderr), last(r.stderr));
}
r = cli(['discord', 'disable']);
step('discord disable: off, the mapping and the token kept', r.status === 0 && readJ(cfgFile).discord.enabled === false && readJ(cfgFile).discord.projects['demo-app'].channels.code === DID.code && fs.readFileSync(path.join(HOME, '.env'), 'utf8').includes(TOKEN));

// uninstall refuses a folder that is not a Synapse home.
const notHome = path.join(tmp, 'not-a-home');
fs.mkdirSync(notHome);
fs.writeFileSync(path.join(notHome, 'precious.txt'), 'x');
r = cli(['uninstall', '--yes', '--home', notHome]);
step('uninstall refuses a folder without the home marker', r.status !== 0 && fs.existsSync(path.join(notHome, 'precious.txt')));
// A per-bot key binding in the registry survives add-project (the bus is stopped here, so its registry check is not in play).
const regFile = path.join(HOME, 'projects.json');
const regJ = readJ(regFile);
regJ.projects['demo-app'].roster.demobot.keyEnv = 'SYNAPSE_KEY_DEMO_APP_DEMOBOT';
fs.writeFileSync(regFile, JSON.stringify(regJ, null, 2));
r = cli(['add-project', PROJ, '--bot', 'demobot'], undefined, { SYNAPSE_KEY_DEMO_APP_DEMOBOT: crypto.randomBytes(24).toString('base64url') });
step('add-project keeps a per-bot key binding and wires the bot with its own key', r.status === 0 && readJ(regFile).projects['demo-app'].roster.demobot.keyEnv === 'SYNAPSE_KEY_DEMO_APP_DEMOBOT' && readJ(mcpFile).mcpServers.synapse.args.includes('SYNAPSE_KEY_DEMO_APP_DEMOBOT') && readJ(path.join(PROJ, '.synapse', 'config.json')).keyEnv === 'SYNAPSE_KEY_DEMO_APP_DEMOBOT', last(r.stdout || r.stderr));
fs.writeFileSync(path.join(HOME, 'my-own-file.txt'), 'keep me');
r = cli(['uninstall']);
step('uninstall dry run changes nothing', r.status === 0 && fs.existsSync(path.join(HOME, 'app')) && !!readJ(mcpFile).mcpServers.synapse);
// Wiring that still runs the app but is not exactly what Synapse recorded is kept and named, and uninstall stops
// before the home: an edited MCP entry, a hook moved to the other settings file, and a second copy of a hook.
const edited = readJ(mcpFile);
edited.mcpServers.synapse.timeout = 30000;
fs.writeFileSync(mcpFile, JSON.stringify(edited, null, 2));
const sNow = readJ(sFile);
const preGroup = sNow.hooks.PreToolUse.find((g) => (g.hooks || []).some(ours));
sNow.hooks.PreToolUse = sNow.hooks.PreToolUse.filter((g) => g !== preGroup);
const postGroup = sNow.hooks.PostToolUse.find((g) => (g.hooks || []).some(ours));
sNow.hooks.PostToolUse.push(structuredClone(postGroup));
fs.writeFileSync(sFile, JSON.stringify(sNow, null, 2));
const sharedSettings = path.join(PROJ, '.claude', 'settings.json');
fs.writeFileSync(sharedSettings, JSON.stringify({ hooks: { PreToolUse: [preGroup] } }, null, 2));
r = cli(['uninstall', '--yes']);
const oursIn = (file, ev) => (fs.existsSync(file) ? Object.entries(readJ(file).hooks || {}) : []).filter(([e]) => !ev || e === ev).flatMap(([, gs]) => gs).filter((g) => (g.hooks || []).some(ours)).length;
step('uninstall --yes keeps an edited synapse server entry, names it, and stops before the home (exit 1)', r.status === 1 && /Remove these by hand/.test(r.stdout) && /"synapse" entry under "mcpServers"/.test(r.stdout) && readJ(mcpFile).mcpServers.synapse.timeout === 30000 && fs.existsSync(clientFile), last(r.stdout));
step('uninstall finds a Synapse hook moved to the settings file it did not record, keeps it and the app', /PreToolUse hook entry .* in .*settings\.json \(Synapse did not write it there\)/.test(r.stdout) && oursIn(sharedSettings, 'PreToolUse') === 1 && fs.existsSync(clientFile));
step('a duplicated hook is ambiguous: neither copy is removed, both are named', oursIn(sFile, 'PostToolUse') === 2 && (r.stdout.match(/PostToolUse hook entry/g) || []).length === 2);
r = cli(['uninstall', '--yes']); // a retry before the manual cleanup must give the same answer
step('a retry before the manual cleanup removes nothing more: both copies, the moved hook and the app stay (exit 1)', r.status === 1 && oursIn(sFile, 'PostToolUse') === 2 && oursIn(sharedSettings, 'PreToolUse') === 1 && fs.existsSync(clientFile), last(r.stdout));
// What the message asks the user to do.
const handled = readJ(mcpFile);
delete handled.mcpServers.synapse;
fs.writeFileSync(mcpFile, JSON.stringify(handled, null, 2));
fs.rmSync(sharedSettings);
const sLeft = readJ(sFile);
for (const [ev, gs] of Object.entries(sLeft.hooks)) sLeft.hooks[ev] = gs.filter((g) => !(g.hooks || []).some(ours));
fs.writeFileSync(sFile, JSON.stringify(sLeft, null, 2));
// A project step that fails stops the uninstall before the home: the app and the manifest stay.
const sGood = fs.readFileSync(sFile, 'utf8');
fs.writeFileSync(sFile, 'not json {');
r = cli(['uninstall', '--yes']);
step('uninstall --yes with a broken project file: exit 1, the app and the manifest kept', r.status === 1 && fs.existsSync(path.join(HOME, 'app', 'client', 'index.js')) && fs.existsSync(path.join(HOME, 'install-manifest.json')), last(r.stdout));
fs.writeFileSync(sFile, sGood);
fs.appendFileSync(regFile, '\n'); // a home file changed by hand since Synapse wrote it
fs.writeFileSync(userInApp, 'my note inside the app'); // a file of the user's inside the app folder
r = cli(['uninstall', '--yes']);
const mcpAfter = fs.existsSync(mcpFile) ? readJ(mcpFile) : null;
const sAfter = fs.existsSync(sFile) ? readJ(sFile) : null;
step('uninstall --yes: synapse server removed, the other server kept', r.status === 0 && mcpAfter && !mcpAfter.mcpServers.synapse && !!mcpAfter.mcpServers.other);
step('uninstall --yes: Synapse hooks removed, the unrelated hook and permissions kept', sAfter && !Object.values(sAfter.hooks || {}).flat().some((g) => (g.hooks || []).some(ours)) && JSON.stringify(sAfter).includes('/some/where/else.js') && sAfter.permissions.allow.includes('Bash(ls)'));
step('uninstall --yes: .synapse/config.json removed, the user\'s file in .synapse kept', !fs.existsSync(path.join(PROJ, '.synapse', 'config.json')) && fs.readFileSync(path.join(PROJ, '.synapse', 'my-notes.txt'), 'utf8') === 'mine');
step('uninstall --yes: installed files and the unchanged .env removed; the user\'s files, the file inside the app and the changed projects.json kept', !fs.existsSync(path.join(HOME, 'app', 'client', 'index.js')) && !fs.existsSync(path.join(HOME, '.env')) && fs.readFileSync(path.join(HOME, 'my-own-file.txt'), 'utf8') === 'keep me' && fs.existsSync(userInApp) && fs.existsSync(regFile) && fs.existsSync(path.join(HOME, 'install-manifest.json')), last(r.stdout));
step('the unrelated invalid file next to the settings is untouched', fs.readFileSync(path.join(PROJ, '.claude', 'settings.local.json.bak'), 'utf8') === 'not json {');
step('uninstall --yes: the exclude lines it added are gone', !fs.readFileSync(exclude, 'utf8').includes('/demo-app/.synapse/'));

const failed = results.filter((x) => !x.ok).length;
console.log(`\nsmoke: ${results.length - failed}/${results.length} passed on ${process.platform} node ${process.versions.node}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
