// Preload for discord-pack.test.mjs: makes discord.js unresolvable, as on an install made with --omit=optional, so the
// real server entry can be booted with Discord on and must refuse before it would ever connect.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'discord.js' || specifier.startsWith('@discordjs/')) {
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    return nextResolve(specifier, context);
  },
});
