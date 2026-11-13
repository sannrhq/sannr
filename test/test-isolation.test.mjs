import './helpers/isolated-home.mjs';
// Test isolation is structural (USE-1 Amendments 5 and 6, A17b and A17d):
// every test file imports test/helpers/isolated-home.mjs before anything else,
// with no pattern deciding which files need it; the helper isolates the home
// of every process a test starts, whatever environment the test passes; and
// the runner gives every test process its own home, state directory, usage
// log and npm cache with counting off. Each part is checked here, including
// that the rule itself fails for a file that breaks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME, TELEMETRY_ENV_NAME } from '../lib/brand.mjs';
import { executePhase, isolatedEnvironment } from '../scripts/test-unit.mjs';

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));
const HARNESSES = ['truthful.mjs', 'stress.mjs', 'check.mjs'];
export function importsHelperFirst(source) {
  const first = /^import\s[^;\n]*?['"]([^'"]+)['"]/m.exec(source);
  return first?.[1] === './helpers/isolated-home.mjs';
}
/** Every test file and harness in `directory` that does not import the helper first. */
export function missingHelper(directory) {
  return readdirSync(directory).filter(name => name.endsWith('.test.mjs') || HARNESSES.includes(name))
    .filter(name => !importsHelperFirst(readFileSync(join(directory, name), 'utf8'))).sort();
}

test('A17d: every test file and harness imports the isolated home first', () => {
  const missing = missingHelper(TEST_DIR);
  assert.deepEqual(missing, [], `import './helpers/isolated-home.mjs' first in: ${missing.join(', ')}`);
});

test('A17d: the rule fails for the files the fourth audit wrote, and for a helper imported second', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-rule-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'zz-cli-join.test.mjs'), "import { spawnSync } from 'node:child_process';\nimport { join } from 'node:path';\nspawnSync(process.execPath, [join('..', 'bin', 'cli.mjs'), 'stacks'], { env: process.env });\n");
  writeFileSync(join(dir, 'zz-dynamic.test.mjs'), "const { loadRegistry, saveRegistry } = await import('../lib/registry.mjs');\nsaveRegistry(loadRegistry().registry);\n");
  writeFileSync(join(dir, 'zz-second.test.mjs'), "import test from 'node:test';\nimport './helpers/isolated-home.mjs';\n");
  writeFileSync(join(dir, 'zz-good.test.mjs'), "import './helpers/isolated-home.mjs';\nimport test from 'node:test';\n");
  assert.deepEqual(missingHelper(dir), ['zz-cli-join.test.mjs', 'zz-dynamic.test.mjs', 'zz-second.test.mjs']);
});

test('A17d: in this process the home, state directory, usage log and npm cache are isolated and counting is off', () => {
  assert.match(process.env.HOME, /test-home-/);
  assert.equal(process.env.USERPROFILE, process.env.HOME);
  assert.equal(process.env[HOME_ENV_NAME], undefined);
  assert.equal(process.env.API_USAGE_LOG, undefined);
  assert.ok(process.env.npm_config_cache.startsWith(process.env.HOME));
  assert.equal(process.env[TELEMETRY_ENV_NAME], '0');
  assert.equal(process.env.DO_NOT_TRACK, '1');
});

test('A17d: a child started with a hand-built environment gets the isolated home and the off switch, through every function', async () => {
  const probe = ['-e', 'process.stdout.write(JSON.stringify({ home: process.env.HOME ?? null, off: process.env.' + TELEMETRY_ENV_NAME + ' ?? null, dnt: process.env.DO_NOT_TRACK ?? null }))'];
  const env = { PATH: process.env.PATH };
  const node = JSON.stringify(process.execPath);
  const read = text => JSON.parse(String(text).trim());
  const collect = child => new Promise(resolve => { let out = ''; child.stdout.on('data', c => out += c); child.on('close', () => resolve(out)); });
  const seen = {
    spawn: read(await collect(childProcess.spawn(process.execPath, probe, { env }))),
    spawnSync: read(childProcess.spawnSync(process.execPath, probe, { env }).stdout),
    execFile: read((await promisify(childProcess.execFile)(process.execPath, probe, { env })).stdout),
    execFileSync: read(childProcess.execFileSync(process.execPath, probe, { env })),
    exec: read((await promisify(childProcess.exec)(`${node} -e ${JSON.stringify(probe[1])}`, { env })).stdout),
    execSync: read(childProcess.execSync(`${node} -e ${JSON.stringify(probe[1])}`, { env })),
    fork: await new Promise(resolve => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-fork-'))), file = join(dir, 'probe.cjs');
      writeFileSync(file, probe[1].replace('process.stdout.write', 'process.send'));
      const child = childProcess.fork(file, [], { env });
      child.once('message', value => { child.kill(); rmSync(dir, { recursive: true, force: true }); resolve(JSON.parse(value)); });
    }),
  };
  for (const [name, value] of Object.entries(seen))
    assert.deepEqual(value, { home: process.env.HOME, off: '0', dnt: '1' }, `${name} reached a child without the isolated home`);
  // A test that sets a key itself, even to an empty string, keeps its value.
  assert.deepEqual(read(childProcess.spawnSync(process.execPath, probe, { env: { ...env, HOME: '/elsewhere', [TELEMETRY_ENV_NAME]: '' } }).stdout),
    { home: '/elsewhere', off: '', dnt: '1' });
});

test('A17b: the runner gives every test process its own home, state directory, usage log and npm cache, with counting off', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-runner-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const canary = join(dir, 'canary');
  const inherited = { ...process.env, HOME: canary, USERPROFILE: canary, [HOME_ENV_NAME]: join(canary, 'state'), API_USAGE_LOG: join(canary, 'usage.jsonl'),
    [TELEMETRY_ENV_NAME]: '', DO_NOT_TRACK: '', npm_config_cache: join(canary, '.npm') };
  const env = isolatedEnvironment(inherited);
  for (const key of ['HOME', 'USERPROFILE', HOME_ENV_NAME, 'API_USAGE_LOG', 'npm_config_cache']) assert.ok(!env[key].startsWith(canary), `${key} still points at the inherited home`);
  assert.ok(env[HOME_ENV_NAME].startsWith(env.HOME) && env.API_USAGE_LOG.startsWith(env.HOME));
  assert.equal(env[TELEMETRY_ENV_NAME], '0');
  assert.equal(env.DO_NOT_TRACK, '1');
  // And executePhase really runs a test file with it.
  const out = join(dir, 'seen.json'), probe = join(dir, 'probe.test.mjs');
  writeFileSync(probe, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ home: process.env.HOME, state: process.env.${HOME_ENV_NAME}, log: process.env.API_USAGE_LOG, off: process.env.${TELEMETRY_ENV_NAME} }));\n`);
  const saved = { ...process.env };
  Object.assign(process.env, inherited);
  delete process.env.NODE_TEST_CONTEXT; // the runner runs as a top-level runner here
  let log = '';
  try { await executePhase({ name: 'probe', files: [probe] }, { root: dir, write: chunk => { log += chunk; } }); }
  finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
  let seen;
  try { seen = JSON.parse(readFileSync(out, 'utf8')); } catch { assert.fail(`the probe did not run: ${log}`); }
  for (const key of ['home', 'state', 'log']) assert.ok(!seen[key].startsWith(canary), `the runner passed the inherited ${key}`);
  assert.equal(seen.off, '0');
});
