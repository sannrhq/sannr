import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT, CONTEXT_BASENAME, POINTER_BEGIN, POINTER_END } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { blockCode, blockText } from '../lib/block-text.mjs';
import { stackRefreshLines } from '../lib/note-pointers.mjs';
import { MAX_INDEXED_OPERATIONS, MAX_TOTAL_INDEXED_OPERATIONS } from '../lib/pointer-context.mjs';

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'stacks-2-pointers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), NO_COLOR: '1' };
  mkdirSync(env.HOME);
  const shim = join(root, 'node_modules', '.bin', PRODUCT);
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${cli.replaceAll("'", "'\\''")}' "$@"\n`); chmodSync(shim, 0o755);
  writeFileSync(join(root, 'CLAUDE.md'), '# Team instructions\n\n');
  return { root, env };
}
function stack(f, name, notes, { empty = false, contract = false } = {}) {
  const folder = join(f.root, LAYOUT.collection, name);
  const operations = Object.fromEntries(notes.map((note, i) => [`GET /items/${i}`, { notes: [note],
    notes_provenance: [{ by: 'agent', at: '2026-10-07' }], notes_superseded: [null], verified_at: null,
    status_codes: [], fields: {}, effect: 'read' }]));
  writeJson(join(folder, 'stack.json'), { v: 1, name, ...(empty ? {} : { default_environment: 'production' }),
    ...(contract ? { contract: 'openapi.json' } : {}), environments: empty ? {} : {
      production: { baseUrl: `https://${name}.example.test` }, staging: { baseUrl: `https://staging-${name}.example.test` },
    } });
  if (contract) writeJson(join(folder, 'openapi.json'), { openapi: '3.0.3', info: { title: 'Fixture API', version: '1' }, paths: Object.fromEntries(notes.map((_, i) => [`/items/${i}`, { get: { responses: { '200': { description: 'Fixture response' } } } }])) });
  writeJson(join(folder, CONTEXT_BASENAME), { v: 0, api: { name: name + ' API' }, operations });
  return operations;
}
async function connect(f) {
  const child = spawn(process.execPath, [cli, 'connect', '--json'], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(exit, 0, stdout + stderr);
  return readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
}
const section = (text, name) => text.split(`### Stack \`${name}\``)[1]?.split('\n### Stack ')[0];
const facts = text => text.split('\n').filter(line => /^- `[^`]+` — /.test(line));

// CONTEXT-3: each stack section lists its noted operations by identifier and
// count; no note text crosses into the block.
const indexed = text => text.split('\n').filter(line => /^- `[^`]+` \(\d+\)$/.test(line));
test('STACKS-2(b) managed blocks list every stack default first with its noted operations and no note text', async t => {
  const f = fixture(t);
  const notes = ['An authored fixture lesson.', 'A line\nwith `code`, <tag>, and punctuation.'];
  const alpha = stack(f, 'alpha', notes), beta = stack(f, 'beta', ['Only beta context.'], { contract: true });
  stack(f, 'unsorted', ['An unfiled operation.'], { empty: true });
  writeJson(join(f.root, LAYOUT.directory, 'defaults.json'), { default_stack: 'beta' });
  const text = await connect(f);
  assert.deepEqual([...text.matchAll(/^### Stack `([^`]+)`/gm)].map(m => m[1]), ['beta', 'alpha', 'unsorted']);
  for (const [name, operations] of [['alpha', alpha], ['beta', beta]]) {
    const part = section(text, name); assert.ok(part, name);
    assert.match(part, /Environments: `production`, `staging`/);
    assert.match(part, name === 'beta' ? /Contract: bound/ : /Contract: not_bound/);
    assert.deepEqual(indexed(part), Object.keys(operations).map(op => `- \`${blockCode(op)}\` (1)`));
    for (const entry of Object.values(operations)) for (const note of entry.notes) assert.ok(!text.includes(blockText(note)), note);
  }
  assert.match(section(text, 'unsorted'), /1 operation/);
  assert.ok(section(text, 'unsorted').includes(`${PRODUCT} stack move --to <stack> "<METHOD /path>"`));
  const claude = readFileSync(join(f.root, 'CLAUDE.md'), 'utf8');
  const body = content => content.slice(content.indexOf(POINTER_BEGIN), content.indexOf(POINTER_END) + POINTER_END.length);
  assert.equal(body(text), body(claude));
});

test('STACKS-2(c) per-stack and total index caps name omitted counts and exact scoped show commands', async t => {
  const f = fixture(t);
  for (const name of ['alpha', 'beta', 'charlie', 'delta']) stack(f, name,
    Array.from({ length: 25 }, (_, i) => `${name} lesson ${i}.`));
  const text = await connect(f);
  assert.equal(indexed(text).length, MAX_TOTAL_INDEXED_OPERATIONS, 'total index cap');
  for (const name of ['alpha', 'beta', 'charlie', 'delta']) {
    const part = section(text, name); assert.ok(part, name);
    const shown = name === 'delta' ? 0 : MAX_INDEXED_OPERATIONS;
    assert.equal(indexed(part).length, shown);
    assert.ok(part.includes(`show --stack ${name}`), part);
    assert.match(part, new RegExp(`${25 - shown} more operations with notes omitted`));
    assert.match(part, name === 'delta' ? /total cap/ : /index cap/);
  }
});

test('STACKS-2(c) inherited lessons are counted with notes on their operation in the index', async t => {
  const f = fixture(t);
  stack(f, 'alpha', Array.from({ length: 3 }, (_, i) => `alpha gotcha ${i}.`));
  const path = join(f.root, LAYOUT.collection, 'alpha', CONTEXT_BASENAME);
  const ctx = JSON.parse(readFileSync(path));
  ctx.api_context = { v: 1, operations: { fixture: { identity: { stack: 'alpha', operation: 'GET /items/0',
    provider: 'alpha', protocol: 'http', environment: 'production' }, observations: [
    { basis: 'authored', notes: Array.from({ length: 4 }, (_, i) => `alpha inherited ${i}.`) },
  ] } } };
  writeJson(path, ctx);
  const part = section(await connect(f), 'alpha');
  assert.deepEqual(indexed(part), ['- `GET /items/0` (5)', '- `GET /items/1` (1)', '- `GET /items/2` (1)']);
  assert.ok(!part.includes('alpha inherited'));
});

test('STACKS-2(b) environment contract overrides are named without borrowing default state', async t => {
  const f = fixture(t);
  stack(f, 'alpha', ['Fixture lesson.'], { contract: true });
  const configPath = join(f.root, LAYOUT.collection, 'alpha', 'stack.json');
  const config = JSON.parse(readFileSync(configPath));
  config.environments.staging.contract = 'missing.openapi.json';
  writeJson(configPath, config);
  const text = await connect(f);
  assert.match(section(text, 'alpha'), /Contract: bound \(default environment `production`\)/);
  assert.match(section(text, 'alpha'), /Contract by environment: `production`: bound; `staging`: missing/);
});

test('STACKS-2(b) scoped-only knowledge is counted once per operation, including unsorted', async t => {
  const f = fixture(t);
  stack(f, 'alpha', ['Legacy fixture lesson.']);
  stack(f, 'unsorted', [], { empty: true });
  for (const name of ['alpha', 'unsorted']) {
    const path = join(f.root, LAYOUT.collection, name, CONTEXT_BASENAME);
    const ctx = JSON.parse(readFileSync(path));
    const entries = [['stranded-production', 'GET /stranded', 'production'],
      ['stranded-staging', 'GET /stranded', 'staging'],
      ...(name === 'alpha' ? [['legacy-also-observed', 'GET /items/0', 'production']] : [])];
    ctx.api_context = { v: 1, operations: Object.fromEntries(entries.map(([id, operation, environment]) =>
      [id, { identity: { operation, provider: name, protocol: 'http', environment, stack: name },
        observations: [{ basis: 'authored', notes: ['A scoped authored fixture lesson.'] }] }])) };
    writeJson(path, ctx);
  }
  const text = await connect(f);
  assert.match(section(text, 'alpha'), /— 2 operations; 2 written, 0 observed, 0 asserted, 0 verified/);
  assert.match(section(text, 'unsorted'), /— 1 operation; 1 written, 0 observed, 0 asserted, 0 verified/);
  assert.match(section(text, 'unsorted'), /1 operation awaiting a destination stack/);
  assert.ok(section(text, 'unsorted').includes('- `GET /stranded` (2)'));
  assert.ok(!text.includes('A scoped authored fixture lesson'));
});

// QA-L1-01 / QA-L4-07: a stack added, imported or moved after connect must
// leave the managed blocks exactly as a second connect would write them, and
// leave the repository's own text around the blocks byte for byte.
async function run(f, args, { cwd = f.root } = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(exit, 0, `${args.join(' ')}\n${stdout}${stderr}`);
  return stdout;
}
const agentFiles = f => ['AGENTS.md', 'CLAUDE.md'].map(file => readFileSync(join(f.root, file), 'utf8'));
const outside = text => [text.slice(0, text.indexOf(POINTER_BEGIN)), text.slice(text.indexOf(POINTER_END) + POINTER_END.length)];
async function connectedWithTeamText(f) {
  writeFileSync(join(f.root, 'AGENTS.md'), '# Team rules\n\nKeep this line.\n');
  await connect(f);
  // Team text after the block too, so both sides of it are checked.
  for (const file of ['AGENTS.md', 'CLAUDE.md']) writeFileSync(join(f.root, file), `${readFileSync(join(f.root, file), 'utf8')}\nTeam text after the block.\n`);
  const before = agentFiles(f).map(outside);
  assert.ok(agentFiles(f).every(text => text.includes(POINTER_BEGIN)), 'connect wrote a managed block in both files');
  return before;
}
async function assertMatchesSecondConnect(f, before, label) {
  const after = agentFiles(f);
  assert.deepEqual(after.map(outside), before, `${label}: text outside the managed blocks is unchanged`);
  await connect(f);
  assert.deepEqual(agentFiles(f), after, `${label}: a second connect writes the same bytes`);
  return after;
}

test('stack add refreshes the managed blocks to what a second connect writes, keeping team text', async t => {
  const f = fixture(t);
  const before = await connectedWithTeamText(f);
  assert.match(agentFiles(f)[0], /No OpenAPI contract was selected/);
  writeJson(join(f.root, 'api', 'orders.json'), { openapi: '3.0.3', info: { title: 'Orders', version: '1' },
    paths: { '/orders/{id}': { get: { responses: { '200': { description: 'ok' } } } } } });
  const added = await run(f, ['stack', 'add', 'orders', '--base-url', 'http://127.0.0.1:9/v1', '--contract', 'api/orders.json']);
  const first = await assertMatchesSecondConnect(f, before, 'stack add --contract');
  assert.match(added, /^Managed instructions: written \(/m, added);
  for (const text of first) {
    assert.doesNotMatch(text, /No OpenAPI contract was selected|start --contract <path>/);
    assert.ok(section(text, 'orders'), text);
  }
  const report = JSON.parse(await run(f, ['stack', 'add', 'bare', '--base-url', 'http://127.0.0.1:9/v2', '--json']));
  assert.equal(report.pointers.state, 'written');
  const second = await assertMatchesSecondConnect(f, before, 'stack add without a contract');
  for (const text of second) assert.ok(section(text, 'orders') && section(text, 'bare'), text);
});

test('connect after stack add describes each stack, not a missing legacy file', async t => {
  const f = fixture(t);
  await connect(f);
  for (const name of ['orders', 'billing']) {
    writeJson(join(f.root, 'api', `${name}.json`), { openapi: '3.0.3', info: { title: name, version: '1' },
      paths: { [`/${name}`]: { get: { responses: { '200': { description: 'ok' } } } } } });
    await run(f, ['stack', 'add', name, '--base-url', `http://127.0.0.1:9/${name}`, '--contract', `api/${name}.json`]);
  }
  const human = await run(f, ['connect']);
  assert.doesNotMatch(human, /No OpenAPI document found|notes are not ready|configure the intended API/, human);
  assert.ok(!human.includes(LAYOUT.context), `the legacy knowledge file is not reported\n${human}`);
  for (const name of ['orders', 'billing']) {
    assert.match(human, new RegExp(`present +${LAYOUT.collection}/${name}/${CONTEXT_BASENAME}`), human);
    assert.match(human, new RegExp(`${name}: 1 operations; 1 written`), human);
  }
  const report = JSON.parse(await run(f, ['connect', '--json']));
  assert.equal(report.context, 'present');
  assert.deepEqual(report.setup.context.stacks.map(row => [row.stack, row.state, row.contract, row.operations]).sort(),
    [['billing', 'present', 'bound', 1], ['orders', 'present', 'bound', 1]]);
  assert.equal(report.setup.api.next, undefined, 'both stacks have a base URL');
});

test('stack move and stack import refresh the managed blocks to what a second connect writes', async t => {
  const f = fixture(t);
  stack(f, 'alpha', []);
  stack(f, 'unsorted', ['An unfiled operation lesson.'], { empty: true });
  const before = await connectedWithTeamText(f);
  const moved = await run(f, ['stack', 'move', '--to', 'alpha', 'GET /items/0']);
  const afterMove = await assertMatchesSecondConnect(f, before, 'stack move');
  assert.doesNotMatch(moved, /Run .* connect to refresh/, moved);
  assert.ok(section(afterMove[0], 'alpha').includes('- `GET /items/0` (1)'), afterMove[0]);

  const source = mkdtempSync(join(tmpdir(), 'stacks-2-pointers-source-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  writeJson(join(source, LAYOUT.collection, 'pets', 'stack.json'), { v: 1, name: 'pets', default_environment: 'local',
    environments: { local: { baseUrl: 'https://pets.example.test' } } });
  const imported = JSON.parse(await run(f, ['stack', 'import', source, '--stack', 'pets', '--json']));
  assert.equal(imported.pointers.state, 'written', JSON.stringify(imported.pointers));
  const afterImport = await assertMatchesSecondConnect(f, before, 'stack import');
  assert.ok(section(afterImport[0], 'pets'), afterImport[0]);
});

test('stack add in a repository that never ran connect writes no agent file', async t => {
  const f = fixture(t);
  const claude = readFileSync(join(f.root, 'CLAUDE.md'), 'utf8');
  const report = JSON.parse(await run(f, ['stack', 'add', 'orders', '--base-url', 'http://127.0.0.1:9/v1', '--json']));
  assert.deepEqual(report.pointers, { state: 'unchanged', files: [] });
  assert.equal(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8'), claude);
  assert.throws(() => readFileSync(join(f.root, 'AGENTS.md')), { code: 'ENOENT' });
});

test('init --contract after connect refreshes the managed blocks to what a second connect writes', async t => {
  const f = fixture(t);
  const before = await connectedWithTeamText(f);
  writeJson(join(f.root, 'api', 'orders.json'), { openapi: '3.0.3', info: { title: 'Orders', version: '1' },
    paths: { '/orders/{id}': { get: { responses: { '200': { description: 'ok' } } } } } });
  const report = JSON.parse(await run(f, ['init', '--contract', 'api/orders.json']));
  const after = await assertMatchesSecondConnect(f, before, 'init --contract');
  for (const text of after) {
    assert.doesNotMatch(text, /No OpenAPI contract was selected|start --contract <path>/);
    assert.ok(section(text, 'orders'), text);
  }
  assert.equal(report.pointers.state, 'written', JSON.stringify(report));
  // A second init changes nothing and says so.
  assert.equal(JSON.parse(await run(f, ['init', '--contract', join(LAYOUT.collection, 'orders', 'orders.json')])).pointers.state, 'unchanged');
});

async function runAny(f, args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { exit, stdout, stderr };
}

test('a refresh that writes one file and fails on the other names each file', async t => {
  const f = fixture(t);
  await connectedWithTeamText(f);
  const claudePath = join(f.root, 'CLAUDE.md'), claude = readFileSync(claudePath, 'utf8');
  chmodSync(claudePath, 0o444); // the fixture's directory removal still deletes it
  const human = await runAny(f, ['stack', 'add', 'orders', '--base-url', 'http://127.0.0.1:9/v1']);
  assert.equal(human.exit, 1, human.stdout + human.stderr);
  assert.match(human.stdout, /^Managed instructions refreshed: AGENTS\.md\.$/m, human.stdout);
  assert.match(human.stdout, /^Managed instructions not refreshed in CLAUDE\.md \(POINTER_WRITE_FAILED\): The stack change was saved, but CLAUDE\.md could not be refreshed/m, human.stdout);
  assert.ok(section(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), 'orders'));
  assert.equal(readFileSync(claudePath, 'utf8'), claude);
  const json = await runAny(f, ['stack', 'add', 'billing', '--base-url', 'http://127.0.0.1:9/v2', '--json']);
  const report = JSON.parse(json.stdout);
  assert.equal(report.pointers.state, 'failed');
  assert.deepEqual(report.pointers.files, [{ file: 'AGENTS.md', action: 'updated' }]);
  assert.equal(report.pointers.failures[0].file, 'CLAUDE.md');
  assert.match(report.pointers.failures[0].reason, /^The stack change was saved, but CLAUDE\.md could not be refreshed/);
});

test('a malformed block names the file and asks for the markers to be repaired', async t => {
  const f = fixture(t);
  await connectedWithTeamText(f);
  const agentsPath = join(f.root, 'AGENTS.md');
  writeFileSync(agentsPath, `${readFileSync(agentsPath, 'utf8')}${POINTER_BEGIN}\n`);
  const agents = readFileSync(agentsPath, 'utf8');
  const result = await runAny(f, ['stack', 'add', 'orders', '--base-url', 'http://127.0.0.1:9/v1']);
  assert.equal(result.exit, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /not refreshed in AGENTS\.md \(POINTER_CONFLICT\)/, result.stdout);
  assert.ok(result.stdout.includes(`Repair the block's markers in AGENTS.md: it needs exactly one ${POINTER_BEGIN} followed by one ${POINTER_END}.`), result.stdout);
  assert.doesNotMatch(result.stdout, /run .*connect to refresh/, result.stdout);
  assert.equal(readFileSync(agentsPath, 'utf8'), agents, 'a malformed block is left as it is');
});

test('connect with several stacks lists every stack, marks the default and keeps evidence_classes', async t => {
  const f = fixture(t);
  await connect(f);
  for (const name of ['orders', 'billing', 'zeta']) await run(f, ['stack', 'add', name, '--base-url', `http://127.0.0.1:9/${name}`]);
  stack(f, 'nourl', [], { empty: true });
  const knowledge = name => `${LAYOUT.collection}/${name}/${CONTEXT_BASENAME}`;
  for (const withDefault of [false, true]) {
    if (withDefault) writeJson(join(f.root, LAYOUT.directory, 'defaults.json'), { default_stack: 'orders' });
    const human = await run(f, ['connect']);
    for (const name of ['orders', 'billing', 'zeta', 'nourl'])
      assert.ok(human.split('\n').some(line => line.includes(knowledge(name))
        && (name === 'orders' && withDefault ? line.endsWith('(default stack)') : !line.includes('(default'))), `${name}\n${human}`);
    assert.match(human, new RegExp(`API context: 4 stacks\\. .*orders${withDefault ? ' \\(default\\)' : ''}: 0 operations`), human);
    const report = JSON.parse(await run(f, ['connect', '--json']));
    assert.deepEqual(report.stacks.map(row => [row.stack, Boolean(row.default)]).sort(),
      [['billing', false], ['nourl', false], ['orders', withDefault], ['zeta', false]]);
    assert.deepEqual(report.setup.context.evidence_classes, { written: 0, observed: 0, asserted: 0, verified: 0 });
    if (withDefault) {
      // The selected default keeps the context and api fields it had before.
      assert.equal(report.setup.api.source, 'config');
      assert.equal(report.setup.context.stacks.find(row => row.stack === 'orders').selected, true);
    } else {
      assert.equal(report.setup.api.source, 'stacks');
      assert.ok(report.setup.api.next.includes(`${LAYOUT.collection}/nourl/stack.json`), report.setup.api.next);
      assert.ok(!report.setup.api.next.includes('<name>'), report.setup.api.next);
    }
  }
});

// The refresh stops at its first failure (shared with note), and
// the report names every file: written, failed with its reason, not attempted.
test('a failed refresh names the files written, the one that failed and those not attempted', async t => {
  const cases = [
    ['read-only AGENTS.md', f => chmodSync(join(f.root, 'AGENTS.md'), 0o444),
      { written: [], failed: 'AGENTS.md', code: 'POINTER_WRITE_FAILED', notAttempted: ['CLAUDE.md'] }],
    ['read-only CLAUDE.md', f => chmodSync(join(f.root, 'CLAUDE.md'), 0o444),
      { written: ['AGENTS.md'], failed: 'CLAUDE.md', code: 'POINTER_WRITE_FAILED', notAttempted: [] }],
    ['symlinked CLAUDE.md', f => {
      const real = join(f.root, 'team', 'claude.md');
      mkdirSync(dirname(real), { recursive: true });
      writeFileSync(real, readFileSync(join(f.root, 'CLAUDE.md'), 'utf8'));
      rmSync(join(f.root, 'CLAUDE.md')); symlinkSync(real, join(f.root, 'CLAUDE.md'));
    }, { written: [], failed: 'CLAUDE.md', code: 'POINTER_CONFLICT', notAttempted: ['AGENTS.md'] }],
    ['malformed AGENTS.md', f => writeFileSync(join(f.root, 'AGENTS.md'), `${readFileSync(join(f.root, 'AGENTS.md'), 'utf8')}${POINTER_END}\n`),
      { written: [], failed: 'AGENTS.md', code: 'POINTER_CONFLICT', notAttempted: ['CLAUDE.md'] }],
    ['malformed CLAUDE.md', f => writeFileSync(join(f.root, 'CLAUDE.md'), `${readFileSync(join(f.root, 'CLAUDE.md'), 'utf8')}${POINTER_BEGIN}\n`),
      { written: [], failed: 'CLAUDE.md', code: 'POINTER_CONFLICT', notAttempted: ['AGENTS.md'] }],
  ];
  for (const [label, damage, expected] of cases) {
    for (const json of [false, true]) {
      const f = fixture(t);
      await connectedWithTeamText(f);
      damage(f);
      const result = await runAny(f, ['stack', 'add', 'orders', '--base-url', 'http://127.0.0.1:9/o', ...(json ? ['--json'] : [])]);
      assert.equal(result.exit, 1, `${label}\n${result.stdout}${result.stderr}`);
      if (json) {
        const { pointers } = JSON.parse(result.stdout);
        assert.deepEqual(pointers.files.filter(row => row.action !== 'unchanged').map(row => row.file), expected.written, label);
        assert.deepEqual(pointers.failures.map(row => [row.file, row.code]), [[expected.failed, expected.code]], label);
        assert.deepEqual(pointers.not_attempted ?? [], expected.notAttempted, label);
      } else {
        if (expected.written.length) assert.match(result.stdout, new RegExp(`^Managed instructions refreshed: ${expected.written.join(', ')}\\.$`, 'm'), `${label}\n${result.stdout}`);
        assert.match(result.stdout, new RegExp(`not refreshed in ${expected.failed} \\(${expected.code}\\)`), `${label}\n${result.stdout}`);
        if (expected.notAttempted.length) assert.ok(result.stdout.includes(`not attempted because of that failure: ${expected.notAttempted.join(', ')}.`), `${label}\n${result.stdout}`);
      }
    }
  }
});

// No canned cause the failure did not report.
test('a hard-linked AGENTS.md is reported with its own reason, not as an irregular file', async t => {
  const f = fixture(t);
  await connectedWithTeamText(f);
  const agents = join(f.root, 'AGENTS.md'), copy = join(f.root, 'team', 'agents.md');
  mkdirSync(dirname(copy), { recursive: true });
  writeFileSync(copy, readFileSync(agents, 'utf8')); rmSync(agents); linkSync(copy, agents);
  const result = await runAny(f, ['stack', 'add', 'orders', '--base-url', 'http://127.0.0.1:9/o']);
  assert.equal(result.exit, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /not refreshed in AGENTS\.md \(POINTER_CONFLICT\): pointer target is not a single-link regular file/, result.stdout);
  assert.doesNotMatch(result.stdout, /so it is a regular file inside the repository/, result.stdout);
  assert.match(result.stdout, /Fix AGENTS\.md as the reason above says, then run .* connect/, result.stdout);
});

test('a failure without a file and a file changed mid-refresh get advice that fits', () => {
  const unnamed = stackRefreshLines({ state: 'failed', files: [], failures: [{ code: 'CONTEXT_UNAVAILABLE',
    reason: 'The stack change was saved, but the managed instruction blocks could not be refreshed: the saved context is unavailable.' }] }, 'cli');
  assert.equal(unnamed[0], 'Managed instructions not refreshed (CONTEXT_UNAVAILABLE): The stack change was saved, but the managed instruction blocks could not be refreshed: the saved context is unavailable.');
  assert.equal(unnamed[1], '  Run cli connect to refresh the managed instructions; the stack change is saved.');
  assert.ok(!unnamed.join('\n').includes('in managed instructions'));
  const changed = stackRefreshLines({ state: 'failed', files: [], failures: [{ file: 'AGENTS.md', code: 'POINTER_WRITE_CONFLICT',
    reason: 'The stack change was saved, but AGENTS.md could not be refreshed: the managed instruction file changed during refresh.' }], not_attempted: ['CLAUDE.md'] }, 'cli');
  assert.equal(changed[1], '  AGENTS.md changed while it was being refreshed; run cli connect to refresh it. The stack change is saved.');
  assert.ok(!changed.join('\n').includes('can be written'));
  assert.equal(changed[2], 'Managed instructions not attempted because of that failure: CLAUDE.md.');
});

// The advice after a failed refresh must work when followed. On
// init's first-stack path, repeating init would refuse (the stack binds its
// own copy of the contract), so the advice is: fix the file, run connect.
test('init after a failed refresh advises fixing the file and running connect, and that works', async t => {
  const f = fixture(t);
  const before = await connectedWithTeamText(f);
  writeJson(join(f.root, 'api', 'orders.json'), { openapi: '3.0.3', info: { title: 'Orders', version: '1' },
    paths: { '/orders/{id}': { get: { responses: { '200': { description: 'ok' } } } } } });
  const agents = join(f.root, 'AGENTS.md');
  chmodSync(agents, 0o444);
  const failed = await runAny(f, ['init', '--contract', 'api/orders.json']);
  assert.equal(failed.exit, 1, failed.stdout + failed.stderr);
  const { pointers } = JSON.parse(failed.stdout);
  assert.equal(pointers.failures[0].file, 'AGENTS.md');
  assert.match(pointers.failures[0].next, /^Make AGENTS\.md writable, then run .* connect; the stack change is saved\.$/, pointers.failures[0].next);
  assert.deepEqual(pointers.not_attempted, ['CLAUDE.md']);
  assert.doesNotMatch(JSON.stringify(pointers), /repeat the same init/i);
  // Do what it says.
  chmodSync(agents, 0o644);
  await run(f, ['connect', '--json']);
  const after = await assertMatchesSecondConnect(f, before, 'connect after the failed init refresh');
  for (const text of after) assert.ok(section(text, 'orders'), text);
});

test('init gives the repair-the-markers advice for a malformed block, as stack add does', async t => {
  const f = fixture(t);
  await connectedWithTeamText(f);
  writeJson(join(f.root, 'api', 'orders.json'), { openapi: '3.0.3', info: { title: 'Orders', version: '1' },
    paths: { '/orders/{id}': { get: { responses: { '200': { description: 'ok' } } } } } });
  writeFileSync(join(f.root, 'AGENTS.md'), `${readFileSync(join(f.root, 'AGENTS.md'), 'utf8')}${POINTER_END}\n`);
  const result = await runAny(f, ['init', '--contract', 'api/orders.json']);
  assert.equal(result.exit, 1, result.stdout + result.stderr);
  const { pointers } = JSON.parse(result.stdout);
  assert.ok(pointers.failures[0].next.startsWith(`Repair the block's markers in AGENTS.md: it needs exactly one ${POINTER_BEGIN} followed by one ${POINTER_END}.`), pointers.failures[0].next);
  assert.match(pointers.retry, /Fix the named file, then run .* connect/);
});

// Stack import reports a refresh the same way stack add does.
function petsSource(t, name = 'pets') {
  const source = mkdtempSync(join(tmpdir(), 'stacks-2-pointers-source-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  writeJson(join(source, LAYOUT.collection, name, 'stack.json'), { v: 1, name, default_environment: 'local',
    environments: { local: { baseUrl: `https://${name}.example.test` } } });
  return source;
}
test('stack import reports its refresh file by file with the stack wording and advice', async t => {
  const ok = fixture(t);
  await connectedWithTeamText(ok);
  const success = await run(ok, ['stack', 'import', petsSource(t), '--stack', 'pets']);
  assert.match(success, /^Managed instructions: written \(AGENTS\.md, CLAUDE\.md\)\.$/m, success);

  const readOnly = fixture(t);
  await connectedWithTeamText(readOnly);
  chmodSync(join(readOnly.root, 'CLAUDE.md'), 0o444);
  const text = await runAny(readOnly, ['stack', 'import', petsSource(t), '--stack', 'pets']);
  assert.equal(text.exit, 1, text.stdout + text.stderr);
  assert.match(text.stdout, /^Managed instructions refreshed: AGENTS\.md\.$/m, text.stdout);
  assert.match(text.stdout, /^Managed instructions not refreshed in CLAUDE\.md \(POINTER_WRITE_FAILED\): The stack change was saved, but CLAUDE\.md could not be refreshed/m, text.stdout);
  assert.match(text.stdout, /Make CLAUDE\.md writable, then run .* connect/, text.stdout);
  const json = await runAny(readOnly, ['stack', 'import', petsSource(t, 'cats'), '--stack', 'cats', '--json']);
  const failure = JSON.parse(json.stdout).pointers.failures[0];
  assert.match(failure.reason, /^The stack change was saved, but CLAUDE\.md could not be refreshed/, failure.reason);
  assert.doesNotMatch(failure.reason, /The context was saved/);

  const malformed = fixture(t);
  await connectedWithTeamText(malformed);
  writeFileSync(join(malformed.root, 'AGENTS.md'), `${readFileSync(join(malformed.root, 'AGENTS.md'), 'utf8')}${POINTER_END}\n`);
  const stray = await runAny(malformed, ['stack', 'import', petsSource(t), '--stack', 'pets']);
  assert.equal(stray.exit, 1, stray.stdout + stray.stderr);
  assert.ok(stray.stdout.includes(`Repair the block's markers in AGENTS.md: it needs exactly one ${POINTER_BEGIN} followed by one ${POINTER_END}.`), stray.stdout);
  assert.ok(stray.stdout.includes('not attempted because of that failure: CLAUDE.md.'), stray.stdout);
});

// With no managed block anywhere there is nothing to refresh, so a pointer
// file the refresh cannot inspect is not a failure of a stack command.
test('a never-connected repository with a linked CLAUDE.md or AGENTS.md adds a stack and runs init without a refresh failure', async t => {
  const layouts = [
    ['CLAUDE.md as a symbolic link to AGENTS.md', f => {
      writeFileSync(join(f.root, 'AGENTS.md'), '# Team rules\n\nKeep this line.\n');
      rmSync(join(f.root, 'CLAUDE.md')); symlinkSync('AGENTS.md', join(f.root, 'CLAUDE.md'));
    }],
    ['AGENTS.md hard-linked to another file', f => {
      mkdirSync(join(f.root, 'team'), { recursive: true });
      writeFileSync(join(f.root, 'team', 'agents.md'), '# Team rules\n\nKeep this line.\n');
      linkSync(join(f.root, 'team', 'agents.md'), join(f.root, 'AGENTS.md'));
    }],
  ];
  for (const [label, arrange] of layouts) for (const command of ['stack add', 'init']) {
    const f = fixture(t);
    arrange(f);
    const before = ['AGENTS.md', 'CLAUDE.md'].map(file => readFileSync(join(f.root, file), 'utf8'));
    writeJson(join(f.root, 'api', 'orders.json'), { openapi: '3.0.3', info: { title: 'Orders', version: '1' },
      paths: { '/orders/{id}': { get: { responses: { '200': { description: 'ok' } } } } } });
    const args = command === 'init' ? ['init', '--contract', 'api/orders.json'] : ['stack', 'add', 'orders', '--base-url', 'http://127.0.0.1:9/v1', '--json'];
    const result = await runAny(f, args);
    assert.equal(result.exit, 0, `${label}, ${command}\n${result.stdout}${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).pointers, { state: 'unchanged', files: [] }, `${label}, ${command}`);
    assert.deepEqual(['AGENTS.md', 'CLAUDE.md'].map(file => readFileSync(join(f.root, file), 'utf8')), before, `${label}, ${command}`);
    const human = command === 'init' ? null : await runAny(f, ['stack', 'add', 'billing', '--base-url', 'http://127.0.0.1:9/v2']);
    if (human) {
      assert.equal(human.exit, 0, `${label}\n${human.stdout}${human.stderr}`);
      assert.doesNotMatch(human.stdout, /not refreshed|Managed instructions/, `${label}\n${human.stdout}`);
    }
  }
});
