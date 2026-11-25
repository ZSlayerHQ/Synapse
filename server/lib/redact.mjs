// Redaction for text that leaves the machine (an optional pack posting to Discord, for example).
//
// Two passes: every exact value of a key the bus knows (project keys, per-bot keys, a pack's token) becomes
// [redacted], then anything shaped like a common credential (bot tokens, webhook URLs, API keys, private key blocks)
// does too. The patterns match the ones scripts/leak-check.mjs uses for commits. This is a backstop for a bot that
// pastes a secret into a message, not a reason to post secrets: the bus itself never puts a key in a message.

const PATTERNS = [
  /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g,
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,}\/[A-Za-z0-9_-]{20,}/gi,
  /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
];
export const REDACTED = '[redacted]';
const MIN_SECRET = 8; // shorter values would redact ordinary words

// secrets: the exact values to remove (strings; short and empty ones are ignored). Longest first, so a value that
// contains another is removed whole.
export function createRedactor(secrets = []) {
  const values = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET))].sort((a, b) => b.length - a.length);
  return function redact(text) {
    let s = String(text ?? '');
    for (const v of values) if (s.includes(v)) s = s.split(v).join(REDACTED);
    for (const re of PATTERNS) s = s.replace(re, REDACTED);
    return s;
  };
}
