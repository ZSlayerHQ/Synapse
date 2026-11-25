/**
 * SessionStart hook: check in with the bus and give Claude the other seats, pending alerts and active locks as
 * session context (stdout JSON). A bus that is down never blocks the session; Claude is told it is unavailable.
 */
const { execFileSync } = require('child_process');
const { init, emit } = require('./lib/synapse-hook.cjs');

(async () => {
  const { config, request } = await init();
  if (!config.configured) process.exit(0); // not a Synapse project: say nothing
  let branch = 'unknown';
  try { branch = execFileSync('git', ['branch', '--show-current'], { cwd: config.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || 'unknown'; } catch { /* not a git repo */ }
  const data = await request('POST', '/api/checkin', { developer: config.developer, branch });
  if (data.__fault) {
    await emit('SessionStart', {
      context: `Synapse: check-in failed (${data.__fault}); the coordination bus is unreachable, so file locks and messages are unavailable this session. Running "synapse doctor" shows why.`,
      systemMessage: `Synapse check-in failed (${data.__fault}).`,
    });
    process.exit(0);
  }
  const lines = [`Synapse: checked in as "${config.developer}" in project ${config.project} on branch "${branch}".`];
  const others = data.otherDevelopers || [];
  if (others.length) {
    for (const d of others) {
      lines.push(`- ${d.name} is ${d.status}${d.workingOn ? `: ${d.workingOn}` : ''}${d.filesEditing && d.filesEditing.length ? ` (files: ${d.filesEditing.join(', ')})` : ''}`);
    }
  } else lines.push('No other sessions are online.');
  for (const a of data.pendingAlerts || []) lines.push(`ALERT [${a.priority}] from ${a.from}: ${a.message}`);
  const locks = data.activeLocks || [];
  if (locks.length) {
    lines.push(`${locks.length} active lock(s):`);
    for (const l of locks) lines.push(`- ${l.file}, held by ${l.developer}`);
  }
  for (const w of config.warnings) lines.push(`Warning: ${w}`);
  await emit('SessionStart', { context: lines.join('\n') });
  process.exit(0);
})();
