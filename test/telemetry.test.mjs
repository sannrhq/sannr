// USE-1: the anonymous daily usage document, observed only from outside —
// through the CLI and the MCP server's stdio — in an isolated machine state
// directory. A harness-owned fetch preload (never a product override) records
// every attempted request and answers for the fixed destination; anything else
// that is not loopback is blocked before the wire, so nothing reaches a real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CI_VARIABLES } from '../lib/telemetry.mjs';
import { HOME_ENV_NAME, PRODUCT, TELEMETRY_ENV_NAME, USAGE_URL } from '../lib/brand.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'bin/cli.mjs');
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'lib/usage.schema.json'), 'utf8'));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

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
  t.after(() => { try { chmodSync(join(parent, 'state'), 0o700); } catch { /* absent */ } rmSync(parent, { recursive: true, force: true }); });
  const home = join(parent, 'home'), state = join(parent, 'state'), root = join(parent, project);
  mkdirSync(home); mkdirSync(root);
  const calls = join(parent, 'calls.jsonl'), mode = join(parent, 'mode.txt'), preload = join(parent, 'preload.mjs');
  writeFileSync(mode, 'accept');
  writeFileSync(preload, `import { appendFileSync, readFileSync } from 'node:fs';
const actual = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url instanceof Request ? url.url : url);
  const target = new URL(href);
  if (target.hostname === '127.0.0.1') return actual(url, init);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ url: href, method: init.method, redirect: init.redirect,
    headers: Object.fromEntries(new Headers(init.headers)), body: init.body === undefined ? null : Buffer.from(init.body).toString('base64') }) + '\\n');
  if (href !== ${JSON.stringify(USAGE_URL)}) throw new Error('blocked by the test harness');
  const mode = readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
  if (mode === 'throw') throw new TypeError('fetch failed');
  if (mode === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
  if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://example.invalid/elsewhere' } });
  return new Response(null, { status: mode === 'accept' ? 202 : Number(mode) });
};
`);
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, [HOME_ENV_NAME]: state,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, NO_COLOR: '1', API_FRICTION_OFF: '1' };
  const m = {
    parent, home, state, root, env,
    stateFile: join(state, 'telemetry.json'), lock: join(state, 'telemetry', '.send.lock'), sent: join(state, 'telemetry', 'sent'),
    setMode: value => writeFileSync(mode, value),
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line); return { ...row, body: row.body === null ? null : Buffer.from(row.body, 'base64').toString('utf8') };
    }) : [],
    readState: () => JSON.parse(readFileSync(join(state, 'telemetry.json'), 'utf8')),
    editState: change => { const s = m.readState(); writeFileSync(join(state, 'telemetry.json'), JSON.stringify({ ...s, ...change(s) })); },
    // Pretend the notice was emitted more than a day ago (the 24-hour wait is
    // a rule this test does not want to sleep through).
    age: () => m.editState(() => ({ noticed_at: new Date(Date.now() - 25 * 3_600_000).toISOString() })),
    run: (args, options = {}) => run(args, { cwd: options.cwd ?? root, env: { ...env, ...options.env }, input: options.input }),
    // A started send owns the lock until its detached sender finishes.
    settle: async (limit = 15_000) => {
      const end = Date.now() + limit;
      while (existsSync(m.lock)) { if (Date.now() > end) throw new Error('sender did not finish'); await new Promise(r => setTimeout(r, 50)); }
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
const NOTICE = /telemetry: .* sends anonymous usage counts/;
const usagePosts = m => m.calls().filter(call => call.url === USAGE_URL);

async function gitInit(cwd) {
  const git = spawn('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => git.once('close', resolve)), 0);
}

async function loopbackApi(t) {
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
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
  await m.settle();
  assert.deepEqual(m.calls(), [], 'a request was attempted on the first day');
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
  m.age();
  const first = await m.run(['--version']);
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
  assert.ok(Buffer.byteLength(post.body) <= 2048);
  const document = JSON.parse(post.body);
  assert.deepEqual(validate(SCHEMA, document), []);
  assert.deepEqual(Object.keys(document).sort(), [...SCHEMA.required].sort());
  assert.equal(document.since, null);
  assert.equal(document.version, VERSION);
  assert.deepEqual(document.features, { stacks: 1, version: 1 });
  const receipts = readdirSync(m.sent);
  assert.equal(receipts.length, 1);
  assert.equal(readFileSync(join(m.sent, receipts[0]), 'utf8'), post.body, 'the receipt is not the sent bytes');

  for (const args of [['--version'], ['stacks', '--json']]) await m.run(args);
  await m.settle();
  assert.equal(m.calls().length, 1, 'a second document went out the same UTC day');

  // USE-1-06: the next day, show prints exactly what the next send carries.
  m.editState(() => ({ last_sent: yesterday() }));
  const shown = json(await m.run(['telemetry', 'show', '--json']));
  assert.equal(shown.destination.url, USAGE_URL);
  assert.equal(shown.last_receipt.body, post.body);
  await m.run(['--help']);
  await m.settle();
  assert.equal(m.calls().length, 2);
  assert.equal(m.calls()[1].body, shown.body, 'show differed from the bytes sent');
  assert.equal(JSON.parse(shown.body).install, document.install);
});

// --- USE-1-03 -------------------------------------------------------------------
test('USE-1-03: the document carries each command under its fixed name, the API requests and since', async t => {
  const m = machine(t);
  const api = await loopbackApi(t);
  await m.run(['--version']);
  assert.equal((await m.run(['stack', 'add', 'local', '--base-url', api, '--json'])).code, 0);
  for (let i = 0; i < 3; i++) {
    const result = await m.run(['request', 'GET', '/ping', '--stack', 'local']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  await m.run(['suite', 'list']);
  await m.run(['status', '--offline']);
  await m.run(['context', '--env', 'x', 'nonsense']);
  m.age();
  m.editState(() => ({ last_sent: yesterday(), install: '00000000-0000-4000-8000-000000000000' }));
  await m.run(['--help']);
  await m.settle();
  const [post] = m.calls();
  const document = JSON.parse(post.body);
  assert.deepEqual(document.features, { context: 1, doctor: 1, request: 3, stack_add: 1, suite_list: 1, version: 1 });
  assert.equal(document.api_calls, 3);
  assert.equal(document.since, yesterday());
  assert.equal(document.install, '00000000-0000-4000-8000-000000000000');
  // The next document starts from zero and says when the previous one went.
  const status = json(await m.run(['telemetry', 'status', '--json']));
  assert.equal(status.last_sent, today());
  const shown = JSON.parse(json(await m.run(['telemetry', 'show', '--json'])).body);
  assert.deepEqual(shown.features, { help: 1 });
  assert.equal(shown.api_calls, 0);
  assert.equal(shown.since, today());
});

// --- USE-1-04 -------------------------------------------------------------------
test('USE-1-04: off sends nothing, deletes the identifier and counts, and holds across processes and projects; on starts again', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.age();
  await m.run(['--version']);
  await m.settle();
  assert.equal(m.calls().length, 1);
  const oldInstall = JSON.parse(m.calls()[0].body).install;
  m.editState(() => ({ last_sent: yesterday() }));
  // counts waiting to be sent, then off
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
  assert.equal(JSON.parse(json(await m.run(['telemetry', 'show', '--json'])).body).api_calls, 0);
  const other = join(m.parent, 'second-project');
  mkdirSync(other);
  for (const cwd of [m.root, other]) for (const args of [['--version'], ['stacks', '--json'], ['--help']]) {
    const result = await m.run(args, { cwd });
    assert.doesNotMatch(result.stderr, NOTICE);
  }
  await m.settle();
  assert.equal(m.calls().length, before, 'a request was made while off');
  assert.equal(json(await m.run(['telemetry', 'status', '--json'])).state, 'off');
  assert.deepEqual(readdirSync(join(m.state, 'telemetry')).filter(name => name !== '.send.lock'), []);

  const on = json(await m.run(['telemetry', 'on', '--json']));
  assert.equal(on.state, 'on');
  await m.run(['--version']);
  await m.settle();
  assert.equal(m.calls().length, before + 1);
  const fresh = JSON.parse(m.calls().at(-1).body);
  assert.notEqual(fresh.install, oldInstall);
  assert.equal(fresh.since, null);
});

// --- USE-1-05 -------------------------------------------------------------------
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
    // An install already told and due: still nothing counted or sent.
    await m.run(['--version']);
    m.age();
    await m.run(['stacks', '--json'], { env: { [name]: value } });
    await m.run(['--version'], { env: { [name]: value } });
    await m.settle();
    assert.deepEqual(m.calls(), [], `${name}=${value} sent`);
    assert.deepEqual(JSON.parse(json(await m.run(['telemetry', 'show', '--json'])).body).features, { version: 1 }, `${name}=${value} counted`);
  }
  for (const value of ['0', 'false']) {
    const m = machine(t);
    assert.match((await m.run(['--version'], { env: { CI: value } })).stderr, NOTICE, `CI=${value} is not a CI environment`);
  }
});

// --- USE-1-07 -------------------------------------------------------------------
test('USE-1-07: a failing, refusing, redirecting or silent endpoint changes no output or exit code, and counts wait for a 2xx', async t => {
  for (const mode of ['throw', '400', '429', '500', '503', 'redirect', 'hang']) {
    const m = machine(t);
    await m.run(['--version']);
    await m.run(['stacks', '--json']);
    m.age();
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
    // The next UTC day, an accepting endpoint receives the counts kept so far.
    m.setMode('accept');
    m.editState(() => ({ attempt_day: yesterday() }));
    await m.run(['--help']);
    await m.settle();
    const delivered = JSON.parse(usagePosts(m).at(-1).body);
    assert.equal(usagePosts(m).length, attempts.length + 1, `${mode}: no delivery after recovery`);
    assert.ok(delivered.features.stacks >= 1 + runs, `${mode}: counts were lost: ${JSON.stringify(delivered.features)}`);
    assert.equal(delivered.install, JSON.parse(attempts[0].body).install);
  }
});

// --- USE-1-08 -------------------------------------------------------------------
test('USE-1-08: JSON stays JSON with the notice pending, and connect carries the notice as a field', async t => {
  for (const args of [['stacks', '--json'], ['telemetry', 'status', '--json'], ['telemetry', 'show', '--json'],
    ['capabilities', '--json'], ['doctor', '--offline', '--json']]) {
    const m = machine(t);
    const result = await m.run(args);
    json(result);
    if (args[0] !== 'telemetry') assert.match(result.stderr, NOTICE);
  }
  const m = machine(t);
  await gitInit(m.root);
  const connect = await m.run(['connect', '--json']);
  const report = json(connect);
  assert.match(report.telemetry_notice, NOTICE);
  assert.doesNotMatch(connect.stderr, NOTICE);
  const again = json(await m.run(['connect', '--json']));
  assert.equal(again.telemetry_notice, undefined);
  const human = machine(t);
  await gitInit(human.root);
  const text = await human.run(['connect']);
  assert.match(text.stdout, NOTICE);
});

// --- USE-1-09 -------------------------------------------------------------------
function mcp(m, { lines }) {
  const child = spawn(process.execPath, [CLI, 'mcp', 'serve'], { cwd: m.root, env: { ...m.env, API_CONTEXT_DIR: m.root }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const call = (id, message) => new Promise(resolve => {
    const sent = performance.now();
    waiters.set(id, () => resolve({ ...replies.get(id), ms: replies.get(id).at - sent }));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...message }) + '\n');
  });
  const close = () => new Promise(resolve => { child.once('close', resolve); child.stdin.end(); });
  return { call, close, lines };
}

test('USE-1-09: the MCP server counts tool calls, relays the notice once and sends in the background', async t => {
  const m = machine(t);
  const server = mcp(m, {});
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
  const shown = JSON.parse(json(await m.run(['telemetry', 'show', '--json'])).body);
  assert.deepEqual(shown.features, { mcp_api_saved_requests: 1 }, 'the call before the notice is counted, or an undeclared name was');

  m.age();
  m.setMode('hang');
  const later = mcp(m, {});
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
  m.age();
  await m.run(['stacks', '--json'], { env });
  await m.settle();
  assert.equal(usagePosts(m).length, 1);
  const receipts = readdirSync(m.sent).map(name => readFileSync(join(m.sent, name), 'utf8'));
  const bytes = [...usagePosts(m).map(call => JSON.stringify(call)), ...receipts].join('\n').toLowerCase();
  const known = ['zqfolder', 'zqrepository', 'zqowner', 'zqstackname', 'zqpath', 'zqquery', 'zqvalue', 'zqheader', 'zq_credential',
    'zq-credential', secret, '127.0.0.1', `:${port}`, m.parent.toLowerCase(), userInfo().username.toLowerCase(), hostname().toLowerCase()];
  for (const value of known) assert.equal(bytes.includes(value), false, `${value} left the machine`);
  assert.equal(JSON.parse(usagePosts(m)[0].body).api_calls, 2);
});

// --- USE-1-11 -------------------------------------------------------------------
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
  // off replaces a corrupt record, which is the person's way out.
  assert.equal(json(await corrupt.run(['telemetry', 'off', '--json'])).state, 'off');
});

// --- USE-1-12 -------------------------------------------------------------------
test('USE-1-12: commands started together when a document is due send at most one', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.age();
  await Promise.all(Array.from({ length: 6 }, (_, i) => m.run(i % 2 ? ['--version'] : ['stacks', '--json'])));
  await m.settle();
  assert.equal(usagePosts(m).length, 1);
});

// --- USE-1-13 -------------------------------------------------------------------
test('USE-1-13: the contract is pinned, the destination is documented, the notice says what it must, no retired phrase ships', async t => {
  assert.equal(createHash('sha256').update(readFileSync(join(ROOT, 'lib/usage.schema.json'))).digest('hex'),
    'b326dd62c8bf63c5ac787a178e8c562e80c91d7dbe6214bd24181e12853fe3a5');
  assert.ok(readFileSync(join(ROOT, 'docs/network-behavior.md'), 'utf8').includes(USAGE_URL));
  const m = machine(t);
  const notice = (await m.run(['--version'])).stderr.trim();
  for (const required of [/telemetry/, /random install ID/, /version/, /operating system/, /each .* command ran/, /API calls/,
    /Nothing about your repositories, APIs or requests is sent/, /on unless you turn it off/, /telemetry off`/, /"opt out"/,
    /telemetry show` prints exactly what is sent/, /24 hours/]) assert.match(notice, required);
  assert.doesNotMatch(notice, /\bjust\b|only a little/i);
  assert.equal(notice.split('\n').length, 1, 'the notice is one paragraph');

  const retired = [/no telemetry/i, /nothing phones home/i, /never phones home/i, /only thing it sends us is feedback/i,
    /only thing [^.]* sends us is feedback/i, /no sannr server/i, /only thing it will ever send/i];
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const inventory = JSON.parse(readFileSync(join(ROOT, 'packaging/public-source-files.json'), 'utf8')).files;
  const shipped = new Set(inventory.filter(path => !path.startsWith('test/') && /\.(md|mjs|json|yml|txt)$/.test(path)));
  for (const entry of pkg.files) if (!entry.endsWith('/')) shipped.add(entry);
  for (const path of shipped) {
    if (!existsSync(join(ROOT, path))) continue;
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const phrase of retired) assert.doesNotMatch(text, phrase, `${path} still makes the retired promise`);
  }
});
