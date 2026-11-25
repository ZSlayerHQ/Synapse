/**
 * PreToolUse hook (Edit|Write|MultiEdit): ask the bus whether the file is safe to edit.
 * A file locked by another seat BLOCKS the edit: exit 2, and the reason on stderr, which Claude sees.
 * A recent edit by another seat or a shared file adds a warning for Claude as structured context; the edit goes on.
 * If the bus is down the edit goes ahead (2 second timeout). Locks are advisory: edits made outside these tools
 * (for example by a shell command) are not checked.
 */
const { init, emit, emitRefusal, inline, rootRelative } = require('./lib/synapse-hook.cjs');

(async () => {
  const { input, config, request } = await init();
  if (!config.configured) { await emitRefusal('PreToolUse', config); process.exit(0); }
  const fp = rootRelative(config.root, input.filePath);
  if (!fp) process.exit(0);
  const data = await request('POST', '/api/will-edit', { developer: config.developer, file: fp });
  if (data.safe === false) {
    process.stderr.write(`[synapse] ${inline(data.message)}\n`);
    process.exit(2);
  }
  const notes = [];
  if (data.__fault === 'bus_unproven') notes.push(`Synapse: no key was sent, because the process on the bus port did not prove it is this Synapse bus (${data.reason}); run "synapse doctor".`);
  if (data.severity === 'warning' || data.severity === 'caution') notes.push(`Synapse: ${inline(data.message)}`);
  for (const w of config.warnings) notes.push(`Synapse warning: ${w}`);
  if (notes.length) await emit('PreToolUse', { context: notes.join('\n') });
  process.exit(0);
})();
