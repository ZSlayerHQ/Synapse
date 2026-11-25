// The README's threat model names the rules a user must follow that the code cannot enforce (audit run-2, item 5), and
// the doctor check it promises exists. Pure: reads files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');

test('README: approve only a synapse MCP server you added; a cloned .mcp.json can run its own code; doctor reports a changed entry', () => {
  assert.match(readme, /Only approve a `synapse` MCP server you added yourself/);
  assert.match(readme, /Claude Code runs whatever command a project's `\.mcp\.json` names/);
  assert.match(readme, /can therefore run its own code before Synapse checks anything/);
  assert.match(readme, /`synapse doctor` reports a `\.mcp\.json` entry that differs from what add-project wrote/);
  // The promise is backed: doctor compares the entry with what add-project writes (bin/synapse.mjs checkProjectDir).
  const cli = fs.readFileSync(path.join(ROOT, 'bin', 'synapse.mjs'), 'utf8');
  assert.match(cli, /The MCP entry must be exactly what this installation writes/);
});

test('README: repository files are untrusted, and keys go only to a proven bus', () => {
  assert.match(readme, /A repository's files are untrusted/);
  assert.match(readme, /Keys go only to a proven bus/);
});
