/**
 * PostToolUse hook (Edit|Write|MultiEdit|Bash): record the edit, and hand alerts addressed to this seat to Claude as
 * structured context. An alert is acknowledged only after it has been written to Claude's context.
 * Bash commands are only classified (git commit / git push); their text is never sent to the bus.
 */
const { init, emit, stripQuoted, rootRelative } = require('./lib/synapse-hook.cjs');

(async () => {
  const { input, config, request } = await init();
  if (!config.configured) process.exit(0);
  const { toolName } = input;
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    const fp = rootRelative(config.root, input.filePath);
    if (fp) await request('POST', '/api/did-edit', { developer: config.developer, file: fp, summary: `${toolName === 'Write' ? 'Wrote' : 'Edited'} ${fp}` });
  } else if (toolName === 'Bash') {
    if (!/\bgit\s+(commit|push)\b/.test(stripQuoted(input.command))) process.exit(0);
  } else {
    process.exit(0);
  }
  const alertData = await request('GET', `/api/alerts/${encodeURIComponent(config.developer)}`);
  const alerts = alertData.alerts || [];
  if (alerts.length) {
    await emit('PostToolUse', { context: alerts.map((a) => `Synapse ALERT from ${a.from} [${a.priority}]: ${a.message}`).join('\n') });
    for (const a of alerts) await request('POST', `/api/alerts/${encodeURIComponent(a.id)}/ack`, {});
  }
  process.exit(0);
})();
