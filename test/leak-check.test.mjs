// The leak-check gate: it must fail on a secret value, a deny-list term or a token pattern, and never print any of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'scripts', 'leak-check.mjs');
// Built at run time so this file itself never matches a pattern.
const TERM = ['zq', 'xv', 'owner', 'term'].join('');
const SECRET = ['s3cr3t', 'Value', '9988776655'].join('-');
const FAKE_BOT_TOKEN = ['M' + 'A'.repeat(23), 'Gx1y2z', 'b'.repeat(30)].join('.');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-leak-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  const secrets = path.join(dir, '..', `${path.basename(dir)}.secrets.env`);
  fs.writeFileSync(secrets, `FAKE_SECRET=${SECRET}\n`);
  const deny = path.join(dir, '..', `${path.basename(dir)}.deny.txt`);
  fs.writeFileSync(deny, `# test deny-list\n${TERM}\nword:zqx\n@secrets ${secrets}\n@allow-path ALLOWED.md\n`);
  return { dir, deny, cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(secrets, { force: true }); fs.rmSync(deny, { force: true }); } };
}
const run = (fx, extra = []) => spawnSync(process.execPath, [SCRIPT, '--require-denylist', ...extra], { cwd: fx.dir, encoding: 'utf8', env: { ...process.env, SYNAPSE_LEAK_DENYLIST: fx.deny, SYNAPSE_HOME: fx.dir } });

test('a clean tree passes', () => {
  const fx = fixture({ 'a.js': 'console.log("hello");\n' });
  try {
    const r = run(fx);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS/);
  } finally { fx.cleanup(); }
});

test('each kind of leak fails the check, and the output names only files, lines, variables and entry numbers', () => {
  const fx = fixture({
    'term.md': `see ${TERM.toUpperCase()} here\n`,
    'secret.js': `const k = '${SECRET}';\n`,
    'token.txt': `token=${FAKE_BOT_TOKEN}\n`,
    'hook.txt': `https://discord.com/api/webhooks/${String(10 ** 17 + 4242)}/${'x'.repeat(40)}\n`,
    'word.md': 'zqx is a word here; zqxa is not\n',
    'ALLOWED.md': `${TERM}\n`,
  });
  try {
    const r = run(fx);
    assert.equal(r.status, 1);
    const out = r.stdout + r.stderr;
    assert.match(out, /term\.md:1: deny-list entry 2/);
    assert.match(out, /secret\.js:1: secret value of FAKE_SECRET/);
    assert.match(out, /token\.txt:1: token pattern discord-bot-token/);
    assert.match(out, /hook\.txt:1: token pattern discord-webhook-url/);
    assert.match(out, /word\.md:1: deny-list entry 3/);
    assert.doesNotMatch(out, /ALLOWED\.md/, '@allow-path skips the deny-list check for that path');
    for (const v of [TERM, SECRET, FAKE_BOT_TOKEN]) assert.ok(!out.toLowerCase().includes(v.toLowerCase()), 'never prints a matched value');
  } finally { fx.cleanup(); }
});

test('the allow-pattern marker exempts only token patterns', () => {
  const fx = fixture({ 'doc.md': `example ${FAKE_BOT_TOKEN} leak-check: allow-pattern\n`, 'doc2.md': `${TERM} leak-check: allow-pattern\n` });
  try {
    const out = run(fx).stdout;
    assert.doesNotMatch(out, /doc\.md/);
    assert.match(out, /doc2\.md:1: deny-list entry 2/);
  } finally { fx.cleanup(); }
});

test('a missing deny-list refuses under --require-denylist', () => {
  const fx = fixture({ 'a.js': 'ok\n' });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--require-denylist'], { cwd: fx.dir, encoding: 'utf8', env: { ...process.env, SYNAPSE_LEAK_DENYLIST: path.join(fx.dir, 'nope.txt') } });
    assert.equal(r.status, 2);
  } finally { fx.cleanup(); }
});

test('--message scans a commit message', () => {
  const fx = fixture({ 'a.js': 'ok\n' });
  const msg = path.join(fx.dir, 'MSG');
  fs.writeFileSync(msg, `fix: thing for ${TERM}\n`);
  try {
    const r = run(fx, ['--message', msg]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /commit message:1: deny-list entry 2/);
  } finally { fx.cleanup(); }
});
