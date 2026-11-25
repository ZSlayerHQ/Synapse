/**
 * SessionEnd hook: check out and release this seat's locks.
 */
const { init, emitRefusal } = require('./lib/synapse-hook.cjs');

(async () => {
  const { config, request } = await init();
  if (config.configured) await request('POST', '/api/checkout', { developer: config.developer });
  else await emitRefusal('SessionEnd', config);
  process.exit(0);
})();
