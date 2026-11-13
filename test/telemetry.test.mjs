// USE-1: the daily usage document, observed only from outside — through the
// CLI and the MCP server's stdio — in an isolated machine state directory and
// HOME. A harness-owned preload (never a product override) records every
// attempted fetch, answers for the fixed destination in the mode under test,
// passes loopback API traffic through and blocks everything else before the
// wire, so nothing reaches a real host. The same preload pins every process's
// clock to a fixed midday that only the test moves (m.advance), so no test
// depends on the time of day or on file times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOME_ENV_NAME, PRODUCT, TELEMETRY_CHECKOUT_ENV_NAME, TELEMETRY_ENV_NAME, TOOL_NAME, USAGE_URL } from '../lib/brand.mjs';
import { cliFeatureNames } from '../lib/telemetry.mjs';
import { SAVED_REQUEST_TOOL } from '../lib/saved-request-actions.mjs';
import { WORKBENCH_AGENT_TOOL } from '../lib/workbench-agent-tools.mjs';
import { NOTE_REVIEW_TOOL, NOTE_RETIRE_TOOL, NOTE_CONTEXT_TOOL } from '../lib/note-review-actions.mjs';

const ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'lib/usage.schema.json'), 'utf8'));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// Written out here, not imported, so a variable dropped from the code fails.
const CI_VARIABLES = ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION'];
const START = Date.parse('2026-06-15T12:00:00.000Z');
const day = n => new Date(START + n * 86_400_000).toISOString().slice(0, 10);
const IS_CHECKOUT = existsSync(join(ROOT, '.git'));

// --- a minimal validator for exactly the keywords the contract uses ----------
function validate(schema, value, path = '$') {
  const errors = [];
  const type = t => t === 'integer' ? Number.isInteger(value) : t === 'null' ? value === null
    : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === t;
  if (schema.anyOf) return schema.anyOf.some(option => !validate(option, value, path).length) ? [] : [`${path}: anyOf`];
  if (schema.type && !type(schema.type)) return [`${path}: type ${schema.type}`];
  if ('const' in schema && value !== schema.const) errors.push(`${path}: const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: enum`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern`);
  if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: minLength`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: maxLength`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: minimum`);
  if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: maximum`);
  if (schema.type === 'object') {
    const keys = Object.keys(value);
    for (const key of schema.required ?? []) if (!keys.includes(key)) errors.push(`${path}.${key}: required`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${path}: maxProperties`);
    for (const key of keys) {
      if (schema.propertyNames) errors.push(...validate({ type: 'string', ...schema.propertyNames }, key, `${path}[name]`));
      if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], value[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

// --- one isolated machine --------------------------------------------------------
function machine(t, { project = 'project' } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-')));
  t.after(() => { for (const dir of ['state', 'other-state', 'home']) try { chmodSync(join(parent, dir), 0o700); } catch { /* absent */ }
    rmSync(parent, { recursive: true, force: true }); });
  const home = join(parent, 'home'), state = join(parent, 'state'), root = join(parent, project);
  mkdirSync(home); mkdirSync(root);
  const calls = join(parent, 'calls.jsonl'), mode = join(parent, 'mode.txt'), clock = join(parent, 'clock.txt'), preload = join(parent, 'preload.mjs');
  writeFileSync(mode, 'accept');
  writeFileSync(clock, String(START - Date.now()));
  writeFileSync(preload, `import { appendFileSync, readFileSync } from 'node:fs';
const RealDate = Date;
const offset = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset()); }
  static now() { return RealDate.now() + offset(); }
};
const actual = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url instanceof Request ? url.url : url);
  if (new URL(href).hostname === '127.0.0.1') return actual(url, init);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ url: href, method: init.method, redirect: init.redirect, cwd: process.cwd(),
    proxy: Object.keys(process.env).filter(name => /proxy/i.test(name)),
    headers: Object.fromEntries(new Headers(init.headers)), body: init.body === undefined ? null : Buffer.from(init.body).toString('base64') }) + '\\n');
  if (href !== ${JSON.stringify(USAGE_URL)}) throw new Error('blocked by the test harness');
  const mode = readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
  if (mode === 'throw') throw new TypeError('fetch failed');
  if (mode === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 400));
  if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://example.invalid/elsewhere' } });
  return new Response(null, { status: ['accept', 'slow'].includes(mode) ? 202 : Number(mode) });
};
`);
  // The checkout switch names this checkout's own real path: only a test does.
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, [HOME_ENV_NAME]: state, [TELEMETRY_CHECKOUT_ENV_NAME]: ROOT,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, NO_COLOR: '1', API_FRICTION_OFF: '1' };
  const m = {
    parent, home, state, root, env,
    stateFile: join(state, 'telemetry.json'), lock: join(state, 'telemetry', '.send.lock'), sent: join(state, 'telemetry', 'sent'),
    counts: join(state, 'telemetry', 'counts.jsonl'),
    setMode: value => writeFileSync(mode, value),
    advance: hours => writeFileSync(clock, String(Number(readFileSync(clock, 'utf8')) + hours * 3_600_000)),
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line); return { ...row, body: row.body === null ? null : Buffer.from(row.body, 'base64').toString('utf8') };
    }) : [],
    readState: (file = join(state, 'telemetry.json')) => JSON.parse(readFileSync(file, 'utf8')),
    run: (args, options = {}) => run(args, { cwd: options.cwd ?? root, env: { ...env, ...options.env }, input: options.input }),
    // A started send owns the lock until its detached sender finishes.
    settle: async (limit = 15_000) => {
      const end = Date.now() + limit;
      const locks = [m.lock, ...['other-state', join('home', `.${PRODUCT}`)].map(dir => join(parent, dir, 'telemetry', '.send.lock'))];
      while (locks.some(lock => existsSync(lock))) { if (Date.now() > end) throw new Error('sender did not finish'); await new Promise(r => setTimeout(r, 50)); }
    },
  };
  return m;
}

function run(args, { cwd, env, input }) {
  const started = performance.now();
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  if (input !== undefined) child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: performance.now() - started }); });
  });
}
const json = result => { try { return JSON.parse(result.stdout); } catch { assert.fail(`not JSON: ${result.stdout}${result.stderr}`); } };
const NOTICE = /telemetry: once a day .* sends usage counts/;
const usagePosts = m => m.calls().filter(call => call.url === USAGE_URL);
const show = async m => json(await m.run(['telemetry', 'show', '--json']));

async function gitInit(cwd) {
  const git = spawn('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => git.once('close', resolve)), 0);
}

async function loopbackApi(t) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.url === '/redir') { res.writeHead(302, { location: '/final' }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/graphql' ? '{"data":{"state":"ready"}}' : '{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

// --- USE-1-01 -------------------------------------------------------------------
test('USE-1-01: a fresh machine shows the notice once on stderr, sends nothing and makes no identifier', async t => {
  const m = machine(t);
  const off = await m.run(['--version'], { env: { [TELEMETRY_ENV_NAME]: '0' } });
  assert.equal(existsSync(m.state), false, 'the off run wrote machine state');
  const first = await m.run(['--version']);
  assert.equal(first.code, off.code);
  assert.equal(first.stdout, off.stdout, 'the notice changed stdout');
  assert.match(first.stderr, NOTICE);
  assert.equal(first.stderr.match(/telemetry:/g).length, 1);
  for (const args of [['--version'], ['stacks', '--json'], ['--help']]) {
    const later = await m.run(args);
    assert.doesNotMatch(later.stderr, NOTICE, `${args.join(' ')} repeated the notice`);
  }
  m.advance(23);
  await m.run(['--version']);
  await m.settle();
  assert.deepEqual(m.calls(), [], 'a request was attempted within 24 hours of the notice');
  const status = json(await m.run(['telemetry', 'status', '--json']));
  assert.equal(status.state, 'on');
  assert.equal(status.install, 'absent');
  assert.equal(m.readState().install, null);
  assert.equal(existsSync(m.sent), false);
});

// --- USE-1-02 and USE-1-06 ------------------------------------------------------
test('USE-1-02/06: a day after the notice one command sends exactly one valid document, its receipt first; show is the truth', async t => {
  const m = machine(t);
  await m.run(['--version']);
  await m.run(['stacks', '--json']);
  m.advance(25);
  const first = await m.run(['--version'], { env: { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', all_proxy: 'x', NODE_USE_ENV_PROXY: '1' } });
  assert.equal(first.code, 0);
  await m.settle();
  const posts = m.calls();
  assert.equal(posts.length, 1, JSON.stringify(posts));
  const [post] = posts;
  assert.equal(post.url, USAGE_URL);
  assert.equal(post.method, 'POST');
  assert.equal(post.redirect, 'manual', 'redirects must not be followed');
  assert.deepEqual(Object.keys(post.headers).sort(), ['content-type', 'user-agent']);
  assert.equal(post.headers['content-type'], 'application/json');
  assert.equal(post.headers['user-agent'], `${PRODUCT}/${VERSION}`);
  assert.deepEqual(post.proxy, [], 'a proxy variable reached the sender');
  assert.equal(post.cwd, realpathSync(join(m.state, 'telemetry')), 'the sender holds the project directory');
  assert.ok(Buffer.byteLength(post.body) <= 2048);
  const document = JSON.parse(post.body);
  assert.deepEqual(validate(SCHEMA, document), []);
  assert.deepEqual(Object.keys(document).sort(), [...SCHEMA.required].sort());
  assert.equal(document.since, null);
  assert.equal(document.version, VERSION);
  assert.deepEqual(document.features, { stacks: 1, version: 1 });
  const shownAfter = await show(m);
  assert.equal(shownAfter.last_delivered.body, post.body, 'the delivered receipt is not the sent bytes');
  assert.equal(shownAfter.last_attempt.outcome, 'delivered');
  assert.equal(readdirSync(m.sent).length, 1);

  m.advance(9); // still the same UTC day (22:00)
  for (const args of [['--version'], ['stacks', '--json']]) await m.run(args);
  await m.settle();
  assert.equal(m.calls().length, 1, 'a second document went out the same UTC day');

  // USE-1-06: the next day, show prints exactly what the next send carries.
  m.advance(24);
  const shown = await show(m);
  assert.equal(shown.destination.url, USAGE_URL);
  await m.run(['--help']);
  await m.settle();
  assert.equal(m.calls().length, 2);
  assert.equal(m.calls()[1].body, shown.body, 'show differed from the bytes sent');
  assert.equal(JSON.parse(shown.body).install, document.install);
  assert.equal(JSON.parse(shown.body).since, day(1));
});

// --- USE-1-03 and F7 ------------------------------------------------------------
test('USE-1-03: counts under fixed names; api_calls counts requests to the person\'s APIs, protocol included, not the probe', async t => {
  const m = machine(t);
  const api = await loopbackApi(t);
  await m.run(['--version']);
  assert.equal((await m.run(['stack', 'add', 'local', '--base-url', api, '--json'])).code, 0);
  for (let i = 0; i < 3; i++) {
    const result = await m.run(['request', 'GET', '/ping', '--stack', 'local']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  const redirected = await m.run(['request', 'GET', '/redir', '--stack', 'local']);
  assert.equal(JSON.parse(redirected.stdout).status, 200, redirected.stdout + redirected.stderr);
  writeFileSync(join(m.root, 'graphql.json'), JSON.stringify({ protocol: 'graphql', path: '/graphql', graphql: { document: 'query Probe { state }' } }));
  const protocol = await m.run(['protocol', 'graphql.json', '--stack', 'local']);
  assert.equal(protocol.code, 0, protocol.stdout + protocol.stderr);
  await m.run(['doctor', '--probe', `${api}/ping`]);
  await m.run(['suite', 'list']);
  await m.run(['context', '--env', 'x', 'nonsense']);
  m.advance(25);
  await m.run(['--help']);
  await m.settle();
  const [post] = m.calls();
  const document = JSON.parse(post.body);
  assert.deepEqual(document.features, { context: 1, doctor: 1, protocol: 1, request: 4, stack_add: 1, suite_list: 1, version: 1 });
  assert.equal(document.api_calls, 5, 'three requests, one redirected request and one GraphQL request; not the probe');
  const status = json(await m.run(['telemetry', 'status', '--json']));
  assert.equal(status.last_sent, day(1));
  const next = JSON.parse((await show(m)).body);
  assert.deepEqual(next.features, { help: 1 });
  assert.equal(next.api_calls, 0);
  assert.equal(next.since, day(1));
});

// --- USE-1-04 -------------------------------------------------------------------
test('USE-1-04: off sends nothing, deletes the identifier and counts, and holds across processes and projects; on starts again', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await m.run(['--version']);
  await m.settle();
  assert.equal(m.calls().length, 1);
  const oldInstall = JSON.parse(m.calls()[0].body).install;
  m.advance(24);
  await m.run(['stacks', '--json']);
  await m.settle();
  const before = m.calls().length;
  const off = json(await m.run(['telemetry', 'off', '--json']));
  assert.equal(off.state, 'off');
  assert.equal(off.sent, false);
  await m.settle();
  assert.equal(m.calls().length, before, 'opting out sent something');
  const stored = readdirSync(m.state, { recursive: true }).map(name => join(m.state, name))
    .filter(path => statSync(path).isFile()).map(path => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(stored, new RegExp(oldInstall), 'the identifier survived off');
  assert.equal(JSON.parse((await show(m)).body).api_calls, 0);
  const other = join(m.parent, 'second-project');
  mkdirSync(other);
  for (const cwd of [m.root, other]) for (const args of [['--version'], ['stacks', '--json'], ['--help']]) {
    m.advance(25);
    const result = await m.run(args, { cwd });
    assert.doesNotMatch(result.stderr, NOTICE);
  }
  await m.settle();
  assert.equal(m.calls().length, before, 'a request was made while off');
  assert.equal(json(await m.run(['telemetry', 'status', '--json'])).state, 'off');

  assert.equal(json(await m.run(['telemetry', 'on', '--json'])).state, 'on');
  await m.run(['--version']);
  await m.settle();
  assert.equal(m.calls().length, before + 1);
  const fresh = JSON.parse(m.calls().at(-1).body);
  assert.notEqual(fresh.install, oldInstall);
  assert.equal(fresh.since, null);
  assert.deepEqual(fresh.features, {}, 'counts from before off survived it');
  assert.equal(fresh.api_calls, 0);
});

// --- A5a / F1 ------------------------------------------------------------------
test('A5a: off racing a send in progress is never undone, and nothing is sent afterwards', async t => {
  for (let i = 0; i < 12; i++) {
    const m = machine(t);
    await m.run(['--version']);
    m.advance(25);
    m.setMode('slow');
    const due = m.run(['stacks', '--json']);
    await new Promise(resolve => setTimeout(resolve, (i % 6) * 15));
    const off = await m.run(['telemetry', 'off', '--json']);
    await due;
    assert.equal(json(off).state, 'off');
    await m.settle();
    assert.equal(m.readState().state, 'off', `run ${i}: off was written back to on`);
    const seen = usagePosts(m).length;
    assert.ok(seen <= 1, `run ${i}: ${seen} documents`);
    m.setMode('accept');
    for (let d = 0; d < 2; d++) { m.advance(25); await m.run(['--version']); await m.settle(); }
    assert.equal(usagePosts(m).length, seen, `run ${i}: sending continued after off`);
  }
});

// --- A5b / F3 ------------------------------------------------------------------
test('A5b: off holds for the operating-system user whatever SANNR_HOME a process uses', async t => {
  const m = machine(t);
  const other = join(m.parent, 'other-state');
  assert.equal(json(await m.run(['telemetry', 'off', '--json'])).state, 'off');
  assert.equal(m.readState(join(m.home, `.${PRODUCT}`, 'telemetry.json')).state, 'off', 'off was not recorded for the user');
  const result = await m.run(['--version'], { env: { [HOME_ENV_NAME]: other } });
  assert.doesNotMatch(result.stderr, NOTICE);
  assert.equal(existsSync(join(other, 'telemetry.json')), false);
  const status = json(await m.run(['telemetry', 'status', '--json'], { env: { [HOME_ENV_NAME]: other } }));
  assert.equal(status.state, 'off');
  const server = mcp(t, m, { [HOME_ENV_NAME]: other });
  await server.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
  const reply = (await server.call(2, { method: 'tools/call', params: { name: 'api_saved_requests', arguments: { action: 'list' } } })).msg;
  assert.equal(reply.result.content.filter(block => NOTICE.test(block.text)).length, 0);
  await server.close();
  assert.equal(existsSync(join(other, 'telemetry.json')), false);
});

// --- USE-1-05 and A17 ----------------------------------------------------------
test('USE-1-05: every environment switch and CI variable means no count, identifier, request, notice or state', async t => {
  const switches = [[TELEMETRY_ENV_NAME, '0'], [TELEMETRY_ENV_NAME, 'off'], [TELEMETRY_ENV_NAME, 'false'], [TELEMETRY_ENV_NAME, 'NO'],
    ['DO_NOT_TRACK', '1'], ['CI', 'true'], ['CI', '1'], ...CI_VARIABLES.map(name => [name, 'true'])];
  for (const [name, value] of switches) {
    const m = machine(t);
    const result = await m.run(['--version'], { env: { [name]: value } });
    await m.run(['stacks', '--json'], { env: { [name]: value } });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, NOTICE, `${name}=${value} showed the notice`);
    assert.equal(existsSync(m.state), false, `${name}=${value} wrote state`);
    const status = json(await m.run(['telemetry', 'status', '--json'], { env: { [name]: value } }));
    assert.equal(status.state, 'off');
    assert.equal(status.reason.variable, name);
    await m.run(['--version']);
    m.advance(25);
    await m.run(['stacks', '--json'], { env: { [name]: value } });
    await m.run(['--version'], { env: { [name]: value } });
    await m.settle();
    assert.deepEqual(m.calls(), [], `${name}=${value} sent`);
    assert.deepEqual(JSON.parse((await show(m)).body).features, { version: 1 }, `${name}=${value} counted`);
  }
  for (const value of ['0', 'false']) {
    const m = machine(t);
    assert.match((await m.run(['--version'], { env: { CI: value } })).stderr, NOTICE, `CI=${value} is not a CI environment`);
  }
});

test('A17: a source checkout never counts or sends unless a test names the checkout', async t => {
  if (!IS_CHECKOUT) { t.skip('this package is not a source checkout'); return; }
  for (const value of [undefined, '', '1', 'true', '/', join(ROOT, 'lib')]) {
    const m = machine(t);
    const env = value === undefined ? {} : { [TELEMETRY_CHECKOUT_ENV_NAME]: value };
    if (value === undefined) delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
    const result = await m.run(['--version'], { env });
    assert.doesNotMatch(result.stderr, NOTICE, `checkout switch ${value} showed the notice`);
    await m.run(['stacks', '--json'], { env });
    assert.equal(existsSync(m.state), false, `checkout switch ${value} wrote state`);
    const status = json(await m.run(['telemetry', 'status', '--json'], { env }));
    assert.equal(status.state, 'off');
    assert.equal(status.reason.source, 'checkout');
  }
});

// --- USE-1-07 -------------------------------------------------------------------
test('USE-1-07: a failing, refusing, redirecting or silent endpoint changes no output or exit code, and counts wait for a 2xx', async t => {
  for (const mode of ['throw', '400', '429', '500', '503', 'redirect', 'hang']) {
    const m = machine(t);
    await m.run(['--version']);
    await m.run(['stacks', '--json']);
    m.advance(25);
    m.setMode(mode);
    const runs = mode === 'hang' ? 2 : 4;
    for (let i = 0; i < runs; i++) {
      for (const args of [['--version'], ['stacks', '--json'], ['telemetry', 'status', '--json']]) {
        const offRun = await m.run(args, { env: { [TELEMETRY_ENV_NAME]: '0' } });
        const onRun = await m.run(args);
        assert.equal(onRun.code, offRun.code, `${mode}: ${args.join(' ')} exit`);
        if (args[0] !== 'telemetry') assert.equal(onRun.stdout, offRun.stdout, `${mode}: ${args.join(' ')} stdout`);
        assert.equal(onRun.stderr, offRun.stderr, `${mode}: ${args.join(' ')} stderr`);
        if (mode === 'hang' && args[0] === '--version')
          assert.ok(onRun.ms - offRun.ms <= 1000, `${mode}: --version waited ${onRun.ms - offRun.ms} ms for the network`);
      }
      await m.settle();
    }
    const attempts = usagePosts(m);
    assert.ok(attempts.length >= 1 && attempts.length <= 3, `${mode}: ${attempts.length} attempts`);
    if (mode !== 'hang') assert.equal(attempts.length, 3, `${mode}: retries in a day`);
    const failed = await show(m);
    assert.equal(failed.last_delivered, null, `${mode}: a failed attempt reads as delivered`);
    assert.equal(failed.last_attempt.outcome, 'not-delivered');
    // The next UTC day, an accepting endpoint receives the counts kept so far.
    m.setMode('accept');
    m.advance(24);
    await m.run(['--help']);
    await m.settle();
    const delivered = JSON.parse(usagePosts(m).at(-1).body);
    assert.equal(usagePosts(m).length, attempts.length + 1, `${mode}: no delivery after recovery`);
    assert.ok(delivered.features.stacks >= 1 + runs, `${mode}: counts were lost: ${JSON.stringify(delivered.features)}`);
    assert.equal(delivered.install, JSON.parse(attempts[0].body).install);
  }
});

// --- USE-1-08 and F9 -------------------------------------------------------------
test('USE-1-08: JSON stays JSON with the notice pending, connect carries it as a field, and a dry run writes and sends nothing', async t => {
  for (const args of [['stacks', '--json'], ['telemetry', 'status', '--json'], ['telemetry', 'show', '--json'],
    ['capabilities', '--json'], ['doctor', '--offline', '--json']]) {
    const m = machine(t);
    const result = await m.run(args);
    json(result);
    if (args[0] !== 'telemetry') assert.match(result.stderr, NOTICE);
  }
  const m = machine(t);
  await gitInit(m.root);
  const dry = json(await m.run(['connect', '--dry-run', '--json']));
  assert.equal(dry.telemetry_notice, undefined, 'a dry run recorded the notice');
  assert.equal(existsSync(m.state), false, 'a dry run wrote telemetry state');
  const connect = await m.run(['connect', '--json']);
  assert.match(json(connect).telemetry_notice, NOTICE);
  assert.doesNotMatch(connect.stderr, NOTICE);
  assert.equal(json(await m.run(['connect', '--json'])).telemetry_notice, undefined);
  m.advance(25);
  const before = readFileSync(m.stateFile, 'utf8');
  await m.run(['migrate', '--dry-run', '--json']);
  await m.run(['connect', '--dry-run', '--json']);
  await m.settle();
  assert.deepEqual(m.calls(), [], 'a dry run started the daily send');
  assert.equal(readFileSync(m.stateFile, 'utf8'), before);
  const human = machine(t);
  await gitInit(human.root);
  assert.match((await human.run(['connect'])).stdout, NOTICE);
});

// --- A14a / F5 -----------------------------------------------------------------
test('A14a: the pointer block connect writes and the request skill say what "opt out" means', async t => {
  // Both shapes of the block: a repository with no API stack yet, and one with a stack.
  for (const withStack of [false, true]) {
    const m = machine(t);
    await gitInit(m.root);
    if (withStack) assert.equal((await m.run(['stack', 'add', 'local', '--base-url', 'http://127.0.0.1:9', '--json'])).code, 0);
    assert.equal((await m.run(['connect', '--json'])).code, 0);
    let blocks = 0;
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      if (!existsSync(join(m.root, file))) continue;
      const text = readFileSync(join(m.root, file), 'utf8');
      if (!text.includes(`<!-- ${PRODUCT}:begin -->`)) continue;
      blocks++;
      assert.match(text, /usage counts once a day unless turned off; if a person says "opt out", run .*telemetry off/, `${file} (stack: ${withStack})`);
    }
    assert.ok(blocks >= 1, 'connect wrote no pointer block');
  }
  assert.match(readFileSync(join(ROOT, 'skill/SKILL.md'), 'utf8'), /"opt out", run `\w+ telemetry off`/);
});

// --- USE-1-09 -------------------------------------------------------------------
// The server is killed when the test ends, passed or failed, and every wait
// for a reply has a deadline, so a broken behavior fails instead of hanging.
function mcp(t, m, extraEnv = {}) {
  const child = spawn(process.execPath, [CLI, 'mcp', 'serve'], { cwd: m.root, env: { ...m.env, API_CONTEXT_DIR: m.root, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const replies = new Map(), waiters = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const parts = buffer.split('\n'); buffer = parts.pop();
    for (const part of parts) if (part.trim()) {
      const msg = JSON.parse(part);
      replies.set(msg.id, { msg, at: performance.now() });
      waiters.get(msg.id)?.();
    }
  });
  const call = (id, message) => new Promise((resolve, reject) => {
    const sent = performance.now();
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`MCP reply ${id} did not arrive within 15 s`)); }, 15_000);
    waiters.set(id, () => { clearTimeout(timer); resolve({ ...replies.get(id), ms: replies.get(id).at - sent }); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...message }) + '\n');
  });
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited; clearTimeout(timer);
  };
  return { call, close };
}

test('USE-1-09: the MCP server counts tool calls, relays the notice once and sends in the background', async t => {
  const m = machine(t);
  const server = mcp(t, m);
  await server.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
  const tool = { method: 'tools/call', params: { name: 'api_saved_requests', arguments: { action: 'list' } } };
  const first = (await server.call(2, tool)).msg;
  const texts = first.result.content.map(block => block.text);
  assert.equal(texts.filter(text => NOTICE.test(text)).length, 1, JSON.stringify(texts));
  assert.doesNotThrow(() => JSON.parse(texts[0]), 'the tool result moved from the first block');
  const second = (await server.call(3, tool)).msg;
  assert.equal(second.result.content.filter(block => NOTICE.test(block.text)).length, 0);
  await server.call(4, { method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  await server.close();
  assert.deepEqual(JSON.parse((await show(m)).body).features, { mcp_api_saved_requests: 1 },
    'the call before the notice is counted, or an undeclared name was');

  m.advance(25);
  m.setMode('hang');
  const later = mcp(t, m);
  await later.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
  const reply = await later.call(2, tool);
  assert.ok(reply.ms < 3000, `the tool result waited ${reply.ms} ms for the send`);
  assert.equal(reply.msg.result.content.filter(block => NOTICE.test(block.text)).length, 0);
  await later.close();
  await m.settle();
  assert.equal(usagePosts(m).length, 1, 'no document went out in the background');
  assert.deepEqual(JSON.parse(usagePosts(m)[0].body).features, { mcp_api_saved_requests: 1 });
});

// --- USE-1-10 -------------------------------------------------------------------
test('USE-1-10: no folder, repository, host, path, header, credential name or machine identity leaves', async t => {
  const m = machine(t, { project: 'zqfolder-private-name' });
  const api = await loopbackApi(t);
  const port = new URL(api).port;
  const secret = 'zq-credential-value-7781';
  const env = { ZQ_CREDENTIAL_VARIABLE: secret };
  await gitInit(m.root);
  const remote = spawn('git', ['remote', 'add', 'origin', 'https://example.invalid/zqowner/zqrepository-name.git'], { cwd: m.root });
  await new Promise(resolve => remote.once('close', resolve));
  await m.run(['--version'], { env });
  assert.equal((await m.run(['stack', 'add', 'zqstackname', '--base-url', api, '--auth', 'header:X-Zqheader-Name:ZQ_CREDENTIAL_VARIABLE'], { env })).code, 0);
  for (const path of ['/zqpath-private/one', '/zqpath-private/two?zqquery=zqvalue'])
    await m.run(['request', 'GET', path, '--stack', 'zqstackname'], { env });
  m.advance(25);
  await m.run(['stacks', '--json'], { env });
  await m.settle();
  assert.equal(usagePosts(m).length, 1);
  const receipts = readdirSync(m.sent).map(name => readFileSync(join(m.sent, name), 'utf8'));
  const bytes = [...usagePosts(m).map(call => JSON.stringify({ ...call, cwd: undefined })), ...receipts].join('\n').toLowerCase();
  const known = ['zqfolder', 'zqrepository', 'zqowner', 'zqstackname', 'zqpath', 'zqquery', 'zqvalue', 'zqheader', 'zq_credential',
    'zq-credential', secret, '127.0.0.1', `:${port}`, m.parent.toLowerCase(), userInfo().username.toLowerCase(), hostname().toLowerCase()];
  for (const value of known) assert.equal(bytes.includes(value), false, `${value} left the machine`);
  assert.equal(JSON.parse(usagePosts(m)[0].body).api_calls, 2);
});

// --- USE-1-11 and F11 ------------------------------------------------------------
test('USE-1-11: a corrupt state file, a read-only or file state directory: commands work, nothing is sent, status says why', async t => {
  const corrupt = machine(t);
  mkdirSync(corrupt.state);
  writeFileSync(corrupt.stateFile, '{"v":1,"state":"on",');
  const cases = [[corrupt, 'TELEMETRY_STATE_INVALID']];
  const asFile = machine(t);
  writeFileSync(asFile.state, 'not a directory');
  cases.push([asFile, 'TELEMETRY_STATE_DIRECTORY_INVALID']);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const readOnly = machine(t);
    mkdirSync(readOnly.state);
    chmodSync(readOnly.state, 0o500);
    cases.push([readOnly, 'TELEMETRY_STATE_UNWRITABLE']);
  } else t.diagnostic('read-only state directory case skipped: Windows or root');
  for (const [m, code] of cases) {
    for (const args of [['--version'], ['stacks', '--json']]) {
      const off = await m.run(args, { env: { [TELEMETRY_ENV_NAME]: '0' } });
      const on = await m.run(args);
      assert.equal(on.code, off.code, `${code}: ${args[0]}`);
      assert.equal(on.stdout, off.stdout, `${code}: ${args[0]}`);
      assert.doesNotMatch(on.stderr, NOTICE, `${code}: a notice it cannot record`);
    }
    await m.settle().catch(() => {});
    assert.deepEqual(m.calls(), [], `${code}: sent`);
    const status = json(await m.run(['telemetry', 'status', '--json']));
    assert.equal(status.state, 'unavailable', code);
    assert.equal(status.problem?.code, code);
  }
  // connect records its notice itself; a damaged record is still not replaced.
  await gitInit(corrupt.root);
  const before = readFileSync(corrupt.stateFile, 'utf8');
  assert.equal(json(await corrupt.run(['connect', '--json'])).telemetry_notice, undefined, 'connect showed a notice it cannot record');
  assert.equal(readFileSync(corrupt.stateFile, 'utf8'), before, 'connect replaced a damaged state file');
  // off replaces a corrupt record, which is the person's way out.
  assert.equal(json(await corrupt.run(['telemetry', 'off', '--json'])).state, 'off');
});

test('F11: a broken or abandoned send lock does not stop sending; a live one holds', async t => {
  for (const kind of ['file', 'empty', 'old', 'future']) {
    const m = machine(t);
    await m.run(['--version']);
    m.advance(25);
    mkdirSync(join(m.state, 'telemetry'), { recursive: true });
    if (kind === 'file') writeFileSync(m.lock, 'stray');
    else {
      mkdirSync(m.lock);
      const created = kind === 'old' ? START + 25 * 3_600_000 - 10 * 60_000 : START + 30 * 86_400_000;
      if (kind !== 'empty') writeFileSync(join(m.lock, 'owner.json'), JSON.stringify({ nonce: 'abandoned', created_at: created, pid: 1 }));
    }
    assert.match(json(await m.run(['telemetry', 'status', '--json'])).send_lock, /stale/, kind);
    await m.run(['--version']);
    await m.settle().catch(error => { throw new Error(`${kind}: ${error.message}; lock now ${existsSync(m.lock) ? readdirSync(m.lock).join(',') : 'gone'}`); });
    assert.equal(usagePosts(m).length, 1, `${kind}: the lock stopped the send`);
  }
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  mkdirSync(m.lock, { recursive: true });
  writeFileSync(join(m.lock, 'owner.json'), JSON.stringify({ nonce: 'live', created_at: START + 25 * 3_600_000, pid: process.pid }));
  await m.run(['--version']);
  assert.deepEqual(usagePosts(m), [], 'a live lock was taken');
  assert.match(json(await m.run(['telemetry', 'status', '--json'])).send_lock, /held/);
});

// --- USE-1-12 -------------------------------------------------------------------
// --- Amendment 4 -------------------------------------------------------------------

// Off, once returned, holds: whichever command or sender races it, the state
// stays off and nothing is sent later, until telemetry on.
async function offHolds(m, label) {
  await m.settle();
  assert.equal(m.readState().state, 'off', `${label}: off was undone`);
  const seen = usagePosts(m).length;
  m.setMode('accept');
  for (let d = 0; d < 2; d++) { m.advance(25); await m.run(['--version']); await m.settle(); }
  assert.equal(usagePosts(m).length, seen, `${label}: sending continued after off`);
}

test('A5d: every writer of the state goes through the lock; nothing but on turns a recorded off into on', async t => {
  const racers = {
    reset: m => m.run(['telemetry', 'reset', '--json']),
    sender: m => m.run(['stacks', '--json']),
    'reset+sender': m => Promise.all([m.run(['telemetry', 'reset', '--json']), m.run(['stacks', '--json'])]),
  };
  for (const [name, racer] of Object.entries(racers)) for (let i = 0; i < 8; i++) {
    const m = machine(t);
    await m.run(['--version']);
    m.advance(25);
    m.setMode('slow');
    const before = i % 2 === 0;
    const first = before ? racer(m) : m.run(['telemetry', 'off', '--json']);
    await new Promise(resolve => setTimeout(resolve, (i % 4) * 10));
    const second = before ? m.run(['telemetry', 'off', '--json']) : racer(m);
    await Promise.all([first, second]);
    await offHolds(m, `${name} ${before ? 'before' : 'after'} off, run ${i}`);
  }
});

test('A5e: off reaches every state directory: old identifiers and counts are discarded, and on revives none', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), other = join(m.parent, 'other-state');
  const inOther = { [HOME_ENV_NAME]: other }, inUser = { [HOME_ENV_NAME]: user };
  await m.run(['--version'], { env: inOther });
  m.advance(25);
  await m.run(['--version'], { env: inOther });
  await m.settle();
  const old = JSON.parse(usagePosts(m)[0].body).install;
  await m.run(['stacks', '--json'], { env: inOther });
  assert.equal(json(await m.run(['telemetry', 'off', '--json'], { env: inUser })).scope, 'user');
  await m.run(['--help'], { env: inOther });
  assert.equal(m.readState(join(other, 'telemetry.json')).install, null, 'the other directory kept its identifier while off');
  assert.equal(existsSync(join(other, 'telemetry', 'counts.jsonl')), false, 'the other directory kept its counts while off');
  const on = json(await m.run(['telemetry', 'on', '--json'], { env: inUser }));
  assert.equal(on.state, 'on');
  m.advance(24);
  await m.run(['--version'], { env: inOther });
  await m.settle();
  const next = JSON.parse(usagePosts(m).at(-1).body);
  assert.equal(usagePosts(m).length, 2);
  assert.notEqual(next.install, old, 'on revived an old identifier');
  assert.equal(next.since, null);
  assert.deepEqual(next.features, {}, 'counts from before off were sent');
});

test('A5e: a directory not touched while off still discards its old data after on', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), other = join(m.parent, 'other-state');
  const inOther = { [HOME_ENV_NAME]: other }, inUser = { [HOME_ENV_NAME]: user };
  await m.run(['--version'], { env: inOther });
  m.advance(25);
  await m.run(['--version'], { env: inOther });
  await m.settle();
  const old = JSON.parse(usagePosts(m)[0].body).install;
  await m.run(['stacks', '--json'], { env: inOther });
  await m.run(['telemetry', 'off', '--json'], { env: inUser });
  await m.run(['telemetry', 'on', '--json'], { env: inUser });
  m.advance(24);
  await m.run(['--version'], { env: inOther });
  await m.settle();
  const next = JSON.parse(usagePosts(m).at(-1).body);
  assert.notEqual(next.install, old);
  assert.deepEqual(next.features, {});
});

test('A5f: off never claims more than it recorded, and exits 1 when it could not record off for the user', async t => {
  const m = machine(t);
  writeFileSync(join(m.home, `.${PRODUCT}`), 'a file where the default state directory should be');
  const human = await m.run(['telemetry', 'off']);
  assert.equal(human.code, 1, human.stdout + human.stderr);
  assert.match(human.stdout, /^Telemetry is off only for /);
  assert.doesNotMatch(human.stdout, /for this operating-system user/);
  const value = json(await m.run(['telemetry', 'off', '--json']));
  assert.equal(value.ok, false);
  assert.equal(value.scope, 'directory');
  // Another state directory still counts, which is exactly what it said.
  const other = join(m.parent, 'other-state');
  assert.match((await m.run(['--version'], { env: { [HOME_ENV_NAME]: other } })).stderr, NOTICE);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const none = machine(t);
    mkdirSync(none.state);
    chmodSync(none.state, 0o500);
    chmodSync(none.home, 0o500);
    const result = await none.run(['telemetry', 'off']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^Telemetry could not be turned off/);
  }
  const ok = machine(t);
  const recorded = await ok.run(['telemetry', 'off']);
  assert.equal(recorded.code, 0);
  assert.match(recorded.stdout, /^Telemetry is off for this operating-system user, recorded in /);
});

test('N5, N7: the day\'s document survives off, on and reset, and on says what it lifted', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await m.run(['--version']);
  await m.settle();
  await m.run(['telemetry', 'off', '--json']);
  const on = json(await m.run(['telemetry', 'on', '--json']));
  assert.equal(on.user_off_lifted, true);
  assert.match((await m.run(['telemetry', 'off'])) && (await m.run(['telemetry', 'on'])).stdout, /off recorded for this operating-system user in .* is lifted, so every .* state directory of this user can count again/);
  await m.run(['telemetry', 'reset', '--json']);
  await m.run(['stacks', '--json']);
  await m.settle();
  assert.equal(usagePosts(m).length, 1, 'off, on or reset added a document to the day');
  m.advance(24);
  await m.run(['--version']);
  await m.settle();
  assert.equal(usagePosts(m).length, 2);
});

test('N8: a lock left by a process that has ended is neither waited for nor called a send in progress', async t => {
  const dead = spawn(process.execPath, ['-e', '0']);
  const pid = dead.pid;
  await new Promise(resolve => dead.once('close', resolve));
  const m = machine(t);
  await m.run(['--version']);
  mkdirSync(m.lock, { recursive: true });
  writeFileSync(join(m.lock, 'owner.json'), JSON.stringify({ nonce: 'ended', created_at: START, pid }));
  assert.match(json(await m.run(['telemetry', 'status', '--json'])).send_lock, /ended/);
  const off = await m.run(['telemetry', 'off', '--json']);
  assert.equal(json(off).ok, true);
  assert.ok(off.ms < 4000, `off waited ${Math.round(off.ms)} ms for a process that has ended`);
});

test('N9: a command run with --offline starts no send', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await m.run(['doctor', '--offline', '--json']);
  await m.run(['stacks', '--json', '--offline']);
  await m.settle();
  assert.deepEqual(usagePosts(m), []);
  await m.run(['--version']);
  await m.settle();
  assert.equal(usagePosts(m).length, 1);
});

test('N10: the day is the UTC day, whatever the time zone', async t => {
  for (const TZ of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    const m = machine(t);
    await m.run(['--version'], { env: { TZ } });
    m.advance(25); // 13:00 UTC: already the next local day in Kiritimati
    await m.run(['--version'], { env: { TZ } });
    await m.settle();
    m.advance(10); // 23:00 UTC: the same UTC day, a different local day in both zones
    await m.run(['--version'], { env: { TZ } });
    await m.settle();
    assert.equal(usagePosts(m).length, 1, `${TZ}: a second document in one UTC day`);
    m.advance(2); // 01:00 UTC the next day
    await m.run(['--version'], { env: { TZ } });
    await m.settle();
    assert.equal(usagePosts(m).length, 2, `${TZ}: no document on the next UTC day`);
  }
});

test('A17a: a test run never counts or sends, and a packed copy run as the package test runs it leaves no state', async t => {
  for (const name of ['NODE_TEST_CONTEXT', 'VITEST', 'JEST_WORKER_ID']) {
    const m = machine(t);
    const result = await m.run(['--version'], { env: { [name]: name === 'NODE_TEST_CONTEXT' ? 'child-v8' : '1' } });
    assert.doesNotMatch(result.stderr, NOTICE, name);
    assert.equal(existsSync(m.state), false, `${name}: state written`);
    assert.equal(json(await m.run(['telemetry', 'status', '--json'], { env: { [name]: '1' } })).reason.source, 'test');
  }
  // A copy without .git behaves as an installed package. Run it the way
  // test/package.test.mjs runs its packed copy: the test process's own
  // environment, which carries the test runner's mark, and only HOME moved.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-packed-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const copy = join(parent, 'package'), home = join(parent, 'home');
  mkdirSync(home);
  for (const entry of ['bin', 'lib', 'skill', 'stacks', 'server.mjs', 'package.json', 'docs'])
    cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
  cpSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), { recursive: true });
  assert.equal(existsSync(join(copy, '.git')), false);
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this file runs under node --test');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env[HOME_ENV_NAME]; delete env.DO_NOT_TRACK; delete env[TELEMETRY_ENV_NAME]; delete env.CI;
  for (const name of CI_VARIABLES) delete env[name];
  const packed = args => new Promise(resolve => {
    const child = spawn(process.execPath, [join(copy, 'bin/cli.mjs'), ...args], { cwd: parent, env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
  await packed(['--help']);
  await packed(['map', '.', '--text', '--no-execute']);
  assert.equal(existsSync(join(home, `.${PRODUCT}`, 'telemetry.json')), false, 'the packed copy wrote telemetry state in a test run');
  assert.equal(existsSync(join(home, `.${PRODUCT}`, 'telemetry')), false);
});

test('USE-1-12: eight commands started together when a document is due send one, whatever the file times say', async t => {
  // Every process's clock is months away from the file system's clock here.
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await Promise.all(Array.from({ length: 8 }, (_, i) => m.run(i % 2 ? ['--version'] : ['stacks', '--json'])));
  await m.settle();
  assert.equal(usagePosts(m).length, 1);
});

// --- F8, F10, F15 and the limits ------------------------------------------------
test('F8: reset makes a new identifier at the next document without adding a document to the day', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await m.run(['--version']);
  await m.settle();
  const first = JSON.parse(usagePosts(m)[0].body).install;
  for (let i = 0; i < 3; i++) {
    assert.equal(json(await m.run(['telemetry', 'reset', '--json'])).install, 'made at the next send');
    await m.run(['stacks', '--json']);
    await m.settle();
  }
  assert.equal(usagePosts(m).length, 1, 'reset bought another document the same day');
  m.advance(24);
  await m.run(['--version']);
  await m.settle();
  const next = JSON.parse(usagePosts(m).at(-1).body);
  assert.equal(usagePosts(m).length, 2);
  assert.notEqual(next.install, first);
  assert.equal(next.since, null);
});

test('A8/F10: receipts keep the last 30 and say whether each was delivered', async t => {
  const m = machine(t);
  await m.run(['--version']);
  mkdirSync(m.sent, { recursive: true });
  for (let i = 0; i < 35; i++) writeFileSync(join(m.sent, `20260101T0000${String(i).padStart(2, '0')}Z-0000000${i % 10}.delivered.json`), '{}');
  m.advance(25);
  m.setMode('500');
  await m.run(['--version']);
  await m.settle();
  assert.ok(readdirSync(m.sent).length <= 30, `${readdirSync(m.sent).length} receipts kept`);
  const shown = await show(m);
  assert.equal(shown.last_attempt.outcome, 'not-delivered');
  assert.equal(shown.last_attempt.body, usagePosts(m)[0].body);
  assert.equal(shown.last_delivered.body, '{}', 'the failed attempt was reported as the last delivery');
});

test('A9: counts clamp at 10,000, and features beyond 64 or 2,048 bytes wait for the next document', async t => {
  const m = machine(t);
  await m.run(['--version']);
  const names = JSON.parse(readFileSync(join(ROOT, 'lib/usage-features.json'), 'utf8'));
  const lines = [...Array.from({ length: 10_005 }, () => '{"f":"stacks"}'), ...Array.from({ length: 1_000_003 }, () => '{"a":1}'),
    ...names.map(name => JSON.stringify({ f: name }))];
  writeFileSync(m.counts, lines.join('\n') + '\n');
  m.advance(25);
  await m.run(['--help']);
  await m.settle();
  const first = JSON.parse(usagePosts(m)[0].body);
  assert.deepEqual(validate(SCHEMA, first), []);
  assert.equal(first.features.stacks, 10_000);
  assert.equal(first.api_calls, 1_000_000);
  assert.ok(Object.keys(first.features).length <= 64 && Buffer.byteLength(usagePosts(m)[0].body) <= 2048);
  m.advance(24);
  await m.run(['--help']);
  await m.settle();
  const second = JSON.parse(usagePosts(m)[1].body);
  assert.deepEqual(validate(SCHEMA, second), []);
  const sent = new Set([...Object.keys(first.features), ...Object.keys(second.features)]);
  for (const name of names) assert.ok(sent.has(name), `${name} was dropped instead of waiting`);
});

// --- A16 -------------------------------------------------------------------------
test('A16: lib/usage-features.json is the one sorted list of names, pinned, shipped and equal to what is counted', () => {
  const bytes = readFileSync(join(ROOT, 'lib/usage-features.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'de500569c131717a620ad08e9c974a347bf2e7ad34b28df1845b08ce5eb08771');
  const names = JSON.parse(bytes);
  assert.ok(Array.isArray(names) && names.every(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(name)));
  assert.deepEqual(names, [...new Set(names)].sort());
  const mcpNames = [TOOL_NAME, SAVED_REQUEST_TOOL.name, WORKBENCH_AGENT_TOOL.name, NOTE_REVIEW_TOOL.name, NOTE_RETIRE_TOOL.name,
    NOTE_CONTEXT_TOOL.name, 'api_context', 'api_context_record'].map(name => `mcp_${name}`);
  assert.deepEqual(names, [...new Set([...cliFeatureNames(), ...mcpNames])].sort());
  const inventory = JSON.parse(readFileSync(join(ROOT, 'packaging/public-source-files.json'), 'utf8')).files;
  assert.ok(inventory.includes('lib/usage-features.json'));
  assert.match(readFileSync(join(ROOT, 'docs/telemetry.md'), 'utf8'), /lib\/usage-features\.json/);
});

// --- USE-1-13 -------------------------------------------------------------------
test('USE-1-13: the contract is pinned, the destination is documented, the notice says what it must, the words are exact', async t => {
  assert.equal(createHash('sha256').update(readFileSync(join(ROOT, 'lib/usage.schema.json'))).digest('hex'),
    'b326dd62c8bf63c5ac787a178e8c562e80c91d7dbe6214bd24181e12853fe3a5');
  assert.ok(readFileSync(join(ROOT, 'docs/network-behavior.md'), 'utf8').includes(USAGE_URL));
  const m = machine(t);
  const notice = (await m.run(['--version'])).stderr.trim();
  for (const required of [/telemetry/, /random install ID/, /linked to the next/, /version/, /operating system/, /each .* command and MCP tool ran/,
    /API calls/, /Nothing about your repositories, APIs or requests is sent/, /on unless you turn it off/, /telemetry off`/, /"opt out"/,
    /telemetry show` prints exactly what is sent/, /24 hours/]) assert.match(notice, required);
  assert.doesNotMatch(notice, /\bjust\b|only a little|anonymous/i);
  assert.equal(notice.split('\n').length, 1, 'the notice is one paragraph');

  const retired = [/no telemetry/i, /nothing phones home/i, /never phones home/i, /only thing it sends us is feedback/i,
    /only thing [^.]* sends us is feedback/i, /no sannr server/i, /only thing it will ever send/i,
    /before it has told you/i, /stores no IP address/i, /no (?:setting, )?environment variable[^.]*changes/i];
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const inventory = JSON.parse(readFileSync(join(ROOT, 'packaging/public-source-files.json'), 'utf8')).files;
  const shipped = new Set(inventory.filter(path => !path.startsWith('test/') && /\.(md|mjs|json|yml|txt)$/.test(path)));
  for (const entry of pkg.files) if (!entry.endsWith('/')) shipped.add(entry);
  for (const path of shipped) {
    if (!existsSync(join(ROOT, path))) continue;
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const phrase of retired) assert.doesNotMatch(text, phrase, `${path} still makes a retired or overstated promise`);
    // "Anonymous" only where the same paragraph says the identifier links days.
    if (path.endsWith('.md')) for (const paragraph of text.split(/\n\s*\n/))
      if (/anonymous/i.test(paragraph) && /usage|telemetry/i.test(paragraph))
        assert.match(paragraph, /link/i, `${path}: "anonymous" without saying the identifier links days: ${paragraph.slice(0, 120)}`);
  }
});
