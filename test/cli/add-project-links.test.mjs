// Regression for audit run-2 finding 2: add-project never follows a symbolic link or junction inside the project. A
// linked .claude or .synapse folder, or a linked .mcp.json or .gitignore, is refused with the reason, and nothing is
// written through it. The home is a minimal fake installation in a temp folder; no bus is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'synapse.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function fakeHome() {
  const home = tmp('synapse-links-home-');
  fs.writeFileSync(path.join(home, '.synapse-home'), '');
  fs.mkdirSync(path.join(home, 'app', 'client'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app', 'client', 'index.js'), '// placeholder\n');
  fs.writeFileSync(path.join(home, 'install-manifest.json'), JSON.stringify({ kind: 'synapse-install-manifest', version: 3, home: home.replace(/\\/g, '/'), files: {}, projects: {} }));
  fs.writeFileSync(path.join(home, 'synapse.config.json'), JSON.stringify({ version: 2, server: { host: '127.0.0.1', port: 4777 }, people: { owner1: {} }, owners: ['owner1'] }));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: {} }));
  return home;
}
const addProject = (home, dir, extra = []) => spawnSync(process.execPath, [CLI, 'add-project', dir, '--home', home, '--bot', 'linkbot', ...extra], {
  encoding: 'utf8', timeout: 30000, env: { ...process.env, SYNAPSE_HOME: home, SYNAPSE_KEY_LINKS: '' },
});
// A link to a folder: a junction on Windows (no privilege needed), a symlink elsewhere. A file link may need privilege on
// Windows; the case is skipped when the OS refuses to make one.
const linkDir = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const tryLinkFile = (target, at) => { try { fs.symlinkSync(target, at, 'file'); return true; } catch (e) { if (e.code === 'EPERM') return false; throw e; } };
const listAll = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

for (const folder of ['.claude', '.synapse']) {
  test(`add-project refuses a ${folder} folder that is a link, and writes nothing through it`, () => {
    const home = fakeHome();
    const proj = tmp('synapse-links-proj-');
    const outside = tmp('synapse-links-outside-');
    try {
      linkDir(outside, path.join(proj, folder));
      const r = addProject(home, path.join(proj));
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(`${folder.replace('.', '\\.')} is a symbolic link \\(or junction\\)`));
      assert.match(r.stderr, /Nothing was changed/);
      assert.deepEqual(listAll(outside), [], 'nothing was written outside the project');
      assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).projects), '{}');
    } finally { for (const d of [home, proj, outside]) fs.rmSync(d, { recursive: true, force: true }); }
  });
}

for (const file of ['.mcp.json', '.gitignore']) {
  test(`add-project refuses a ${file} that is a link`, (t) => {
    const home = fakeHome();
    const proj = tmp('synapse-links-proj-');
    const outside = tmp('synapse-links-outside-');
    const target = path.join(outside, 'secrets.env');
    fs.writeFileSync(target, file === '.mcp.json' ? '{}' : 'DUMMY_KEY=not-a-real-key\n');
    try {
      if (!tryLinkFile(target, path.join(proj, file))) { t.skip('this OS account may not create file symlinks'); return; }
      if (file === '.gitignore') spawnSync('git', ['init', '-q'], { cwd: proj });
      const before = fs.readFileSync(target, 'utf8');
      const r = addProject(home, proj, file === '.gitignore' ? ['--shared'] : []);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /is a symbolic link \(or junction\)/);
      assert.equal(fs.readFileSync(target, 'utf8'), before, 'the link target is untouched');
      assert.ok(fs.lstatSync(path.join(proj, file)).isSymbolicLink(), 'the link itself is untouched');
    } finally { for (const d of [home, proj, outside]) fs.rmSync(d, { recursive: true, force: true }); }
  });
}
