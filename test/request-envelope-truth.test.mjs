// What an HTTP request envelope tells the caller must be so. Each test drives a
// real entry point (MCP stdio, the CLI, the library) against a loopback server
// that counts what it received; nothing here reaches another host.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const clientUrl = new URL('../lib/client.mjs', import.meta.url).href;

// One repository with one stack `lab` pointed at a loopback server. `auth`, when
// given, is the stack's credential reference; `reply` shapes the response.
async function fixture(t, { auth, reply } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'envelope-truth-')));
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, hasAuthorization: 'authorization' in req.headers });
    const r = reply?.(req) ?? {};
    if (r.hang) return;
    if (r.reset) { req.socket.destroy(); return; }
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? { id: 'item-1', name: 'first', secretish: 'not-requested', extra: [1, 2, 3] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null)
      await new Promise(resolve => { child.once('close', resolve); child.kill(); });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(join(root, 'home'));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'state'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: '', API_FRICTION_OFF: '1', NO_COLOR: '1', API_TIMEOUT_MS: '5000' };
  const cli = (args, extra = {}) => new Promise(resolve => {
    execFile(process.execPath, [cliPath, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
  });
  const library = (code, extra = {}) => new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', `const client = await import(${JSON.stringify(clientUrl)});\n${code}`],
      { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 },
      (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
  });
  const mcp = (extra = {}) => {
    const child = spawn(process.execPath, [serverPath], { cwd: root, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const pending = new Map(); let buffer = ''; let next = 0;
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line); const done = pending.get(message.id);
        if (done) { pending.delete(message.id); done(message); }
      }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 15000);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    return {
      rpc,
      call: async args => {
        const message = await rpc('tools/call', { name: 'api_request', arguments: args });
        return { isError: message.result.isError === true, body: JSON.parse(message.result.content[0].text) };
      },
    };
  };
  const added = await cli(['stack', 'add', 'lab', '--base-url', origin, ...(auth ? ['--auth', auth] : []), '--json']);
  assert.equal(added.code, 0, `stack add failed: ${added.stderr}`);
  return { root, origin, calls, cli, library, mcp };
}

const NOT_ARRAYS = [['an object', { status: 201 }], ['a string', 'status 201'], ['a number', 201], ['true', true]];

test('an expect that is not an array refuses before traffic through MCP, single and batch', async t => {
  const f = await fixture(t);
  const server = f.mcp();
  // The description agents read says what the code does.
  const listed = await server.rpc('tools/list', {});
  const described = listed.result.tools.find(tool => tool.name === 'api_request').inputSchema.properties.expect.description;
  assert.match(described, /null/);
  assert.match(described, /EXPECT_NOT_ARRAY/);
  assert.match(described, /PROTOCOL_INPUT_INVALID/);
  for (const [label, expect] of NOT_ARRAYS) {
    const single = await server.call({ method: 'GET', path: '/health', stack: 'lab', expect });
    assert.equal(single.isError, false, `${label}: refusals keep today's isError convention`);
    assert.equal(single.body.ok, false, `${label}: a dropped check must not read ok:true`);
    assert.equal(single.body.mode, 'refused', label);
    assert.equal(single.body.error.code, 'EXPECT_NOT_ARRAY', label);
    assert.match(single.body.error.message, /array of assertion clauses/, label);
    assert.equal(single.body.assertions, null, label);
    // A batch refuses whole, before the earlier valid step runs.
    const batch = await server.call({ stack: 'lab', requests: [
      { method: 'POST', path: '/write', body: { change: true }, expect: [{ status: 200 }] },
      { method: 'GET', path: '/health', expect },
    ] });
    assert.equal(batch.body.ok, false, label);
    assert.equal(batch.body.attempted, 0, label);
    assert.equal(batch.body.error.code, 'EXPECT_NOT_ARRAY', label);
    assert.equal(batch.body.error.details.request_index, 1, label);
    // Protocol steps are checked in the same pass, before the earlier write.
    for (const step of [
      { protocol: 'jsonrpc', path: '/rpc', rpc: { method: 'jobs.get', params: {} }, expect },
      { protocol: 'graphql', path: '/graphql', graphql: { document: 'query Q { a }' }, expect },
    ]) {
      const mixed = await server.call({ stack: 'lab', requests: [
        { method: 'POST', path: '/write', body: { change: true }, expect: [{ status: 200 }] }, step] });
      assert.equal(mixed.body.ok, false, `${label} ${step.protocol}`);
      assert.equal(mixed.body.attempted, 0, `${label} ${step.protocol}: no earlier write goes out`);
      assert.equal(mixed.body.error.code, 'EXPECT_NOT_ARRAY', `${label} ${step.protocol}`);
    }
  }
  assert.deepEqual(f.calls, [], 'nothing reached the server');
  // A missing expect, null (an unset optional input) and an empty array keep
  // their meaning: no assertions.
  for (const args of [{}, { expect: null }, { expect: [] }]) {
    const result = await server.call({ method: 'GET', path: '/health', stack: 'lab', ...args });
    assert.equal(result.body.ok, true);
    assert.equal(result.body.assertions, null);
  }
  // A malformed clause inside an array still fails as `invalid`.
  const malformed = await server.call({ method: 'GET', path: '/health', stack: 'lab', expect: [{ nonsense: 1 }] });
  assert.equal(malformed.body.ok, false);
  assert.equal(malformed.body.assertions.failures[0].op, 'invalid');
  const nullBatch = await server.call({ stack: 'lab', requests: [{ path: '/health', expect: null }] });
  assert.equal(nullBatch.body.ok, true, 'null in a batch step is absent too');
  assert.equal(f.calls.length, 5);
});

test('an expect that is not an array refuses before traffic from CLI JSON input, finally steps and suite files', async t => {
  const f = await fixture(t);
  // request envelope: a step and a cleanup step.
  for (const envelope of [
    { v: 2, requests: [{ path: '/health', expect: { status: 201 } }] },
    { v: 2, requests: [{ path: '/health', expect: [{ status: 200 }] }], finally: [{ method: 'DELETE', path: '/x', expect: 'status 204' }] },
  ]) {
    const out = await f.cli(['request', 'envelope', JSON.stringify(envelope), '--stack', 'lab']);
    assert.equal(out.code, 1);
    const result = JSON.parse(out.stdout);
    assert.equal(result.error.code, 'EXPECT_NOT_ARRAY');
    assert.equal(result.attempted, 0);
    // The index counts through requests and then finally.
    assert.equal(result.error.details.request_index, envelope.finally ? 1 : 0);
  }
  // protocol command: a single HTTP request from a JSON file.
  writeFileSync(join(f.root, 'one.json'), JSON.stringify({ protocol: 'http', method: 'GET', path: '/health', stack: 'lab', expect: { status: 201 } }));
  const protocol = await f.cli(['protocol', 'one.json']);
  assert.equal(protocol.code, 1);
  assert.equal(JSON.parse(protocol.stdout).error.code, 'EXPECT_NOT_ARRAY');
  // A hand-edited suite file: save a valid suite, then break its expect.
  writeFileSync(join(f.root, 'suite.json'), JSON.stringify({ v: 2, requests: [{ path: '/health', expect: [{ status: 200 }] }] }));
  const save = await f.cli(['suite', 'save', 'smoke', 'suite.json', '--stack', 'lab']);
  assert.equal(save.code, 0, save.stderr);
  const file = save.stdout.match(/(\/\S+smoke\.json)/)[1];
  const suite = JSON.parse(readFileSync(file, 'utf8'));
  suite.requests[0].expect = { status: 200 };
  writeFileSync(file, JSON.stringify(suite));
  const run = await f.cli(['suite', 'run', 'smoke', '--stack', 'lab', '--json']);
  assert.notEqual(run.code, 0);
  assert.match(run.stdout + run.stderr, /EXPECT_NOT_ARRAY/);
  assert.deepEqual(f.calls, [], 'nothing reached the server');
});

const TOKEN_VAR = 'QAFIX_CLIENT_TOKEN';
const TOKEN_VALUE = 'synthetic-qafix-token-not-real';

test('a request sent without its configured credential says so on every status, through MCP and the CLI', async t => {
  const f = await fixture(t, { auth: `bearer:${TOKEN_VAR}`,
    reply: req => req.method === 'POST' ? { status: 401, body: { error: 'unauthorized' } } : {} });
  const server = f.mcp();
  const read = (await server.call({ method: 'GET', path: '/health', stack: 'lab', expect: [{ status: 200 }] })).body;
  // Existing design: the unauthenticated read is still sent and still ok.
  assert.equal(read.ok, true);
  assert.equal(read.error, undefined);
  assert.deepEqual(read.auth_missing && { code: read.auth_missing.code, env: read.auth_missing.env,
    sent: read.auth_missing.sent_without_credentials },
  { code: 'AUTH_ENV_MISSING', env: [TOKEN_VAR], sent: true }, 'a 200 names the missing variable too');
  assert.match(read.auth_missing.message, /sent without credentials/);
  // It names where the reference was configured (stack add --auth), not API_AUTH.
  assert.match(read.auth_missing.message, /^stack 'lab' environment '[^']+' auth \(\.sannr\/stacks\/lab\/stack\.json\) references environment variable QAFIX_CLIENT_TOKEN/);
  assert.doesNotMatch(read.auth_missing.message, /API_AUTH/);
  // A 401 keeps today's error and carries the same field.
  const write = (await server.call({ method: 'POST', path: '/items', stack: 'lab', body: { a: 1 } })).body;
  assert.equal(write.ok, false);
  assert.equal(write.error.code, 'AUTH_ENV_MISSING');
  assert.deepEqual(write.auth_missing.env, [TOKEN_VAR]);
  const batch = (await server.call({ stack: 'lab', requests: [{ path: '/health', expect: [{ status: 200 }] }] })).body;
  assert.equal(batch.ok, true);
  assert.deepEqual(batch.results[0].auth_missing.env, [TOKEN_VAR]);
  assert.deepEqual(f.calls.map(call => call.hasAuthorization), [false, false, false], 'dispatch is unchanged');

  const cliRead = await f.cli(['request', 'GET', '/health', '--stack', 'lab', '--expect-status', '200']);
  assert.equal(cliRead.code, 0, 'the exit code is unchanged');
  assert.deepEqual(JSON.parse(cliRead.stdout).auth_missing.env, [TOKEN_VAR]);
  const warnings = cliRead.stderr.split('\n').filter(line => line.includes(TOKEN_VAR));
  assert.equal(warnings.length, 1, `one stderr line names the variable: ${cliRead.stderr}`);
  assert.match(warnings[0], /AUTH_ENV_MISSING/);
  const cliEnvelope = await f.cli(['request', 'envelope', JSON.stringify({ v: 2, requests: [{ path: '/health', expect: [{ status: 200 }] }] }), '--stack', 'lab']);
  assert.equal(cliEnvelope.code, 0);
  assert.equal(cliEnvelope.stderr.split('\n').filter(line => line.includes(TOKEN_VAR)).length, 1);
  assert.equal(f.calls.length, 5);

  // With the variable set, the credential is sent and nothing is reported.
  const withToken = await f.cli(['request', 'GET', '/health', '--stack', 'lab'], { [TOKEN_VAR]: TOKEN_VALUE });
  assert.equal(withToken.code, 0);
  assert.equal(JSON.parse(withToken.stdout).auth_missing, undefined);
  assert.doesNotMatch(withToken.stderr, /AUTH_ENV_MISSING/);
  assert.equal(f.calls.at(-1).hasAuthorization, true);
  assert.equal(`${withToken.stdout}${withToken.stderr}`.includes(TOKEN_VALUE), false, 'never a credential value');
});

test('a missing Basic credential pair still refuses before traffic', async t => {
  const f = await fixture(t, { auth: 'basic:QAFIX_USER:QAFIX_PASS' });
  const result = (await f.mcp().call({ method: 'GET', path: '/health', stack: 'lab' })).body;
  assert.equal(result.mode, 'refused');
  assert.equal(result.error.code, 'AUTH_ENV_MISSING');
  assert.equal(result.auth_missing, undefined, 'nothing was sent, so nothing went out without credentials');
  assert.deepEqual(f.calls, []);
});

test('rate_limit holds what the server said, never the client lane width', async t => {
  const f = await fixture(t, { reply: req => req.url === '/limited'
    ? { headers: { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '99', 'x-ratelimit-reset': '60' } } : {} });
  const server = f.mcp();
  const limited = (await server.call({ method: 'GET', path: '/limited', stack: 'lab' })).body;
  assert.deepEqual(limited.rate_limit, { limit: 100, remaining: 99, reset: 60 });
  const plain = (await server.call({ method: 'GET', path: '/plain', stack: 'lab' })).body;
  assert.equal(plain.rate_limit, null, 'no rate-limit headers and no throttle: null');
  assert.doesNotMatch(JSON.stringify([limited, plain]), /concurrency/);
});

test('fields with a passing expect returns the projection; without fields a pass still omits the body', async t => {
  const f = await fixture(t, { reply: req => req.url === '/list'
    ? { body: { items: [{ id: 'a', name: 'one', other: 1 }, { id: 'b', name: 'two', other: 2 }] } }
    : req.url === '/text' ? { headers: { 'content-type': 'text/plain' }, body: 'id=item-1 plain words' } : {} });
  const server = f.mcp();
  const fields = ['id', 'name', 'absent'];
  const projected = (await server.call({ method: 'GET', path: '/one', stack: 'lab', fields })).body;
  assert.equal(projected.mode, 'projection');
  const both = (await server.call({ method: 'GET', path: '/one', stack: 'lab', fields, expect: [{ status: 200 }] })).body;
  assert.equal(both.ok, true);
  assert.equal(both.mode, 'assert');
  assert.deepEqual(both.assertions, { passed: 1, failed: 0, failures: [] });
  assert.deepEqual(both.data, { id: 'item-1', name: 'first' }, 'the same projection fields gives without expect');
  assert.deepEqual(both.data, projected.data);
  assert.deepEqual(both.discovery?.unknown_fields, ['absent']);
  const rows = (await server.call({ method: 'GET', path: '/list', stack: 'lab', fields: ['id'], expect: [{ status: 200 }] })).body;
  assert.deepEqual(rows.data, [{ id: 'a' }, { id: 'b' }]);
  // A response that is not JSON: the same summary the call returns without expect.
  const textAlone = (await server.call({ method: 'GET', path: '/text', stack: 'lab', fields: ['id'] })).body;
  const textBoth = (await server.call({ method: 'GET', path: '/text', stack: 'lab', fields: ['id'], expect: [{ status: 200 }] })).body;
  assert.equal(textBoth.mode, 'assert');
  assert.equal(textBoth.ok, true);
  assert.equal(textAlone.data, 'id=item-1 plain words');
  assert.deepEqual(textBoth.data, textAlone.data, 'a text response is not set aside');
  assert.deepEqual(textBoth.discovery, textAlone.discovery);
  const bare = (await server.call({ method: 'GET', path: '/one', stack: 'lab', expect: [{ status: 200 }] })).body;
  assert.equal(bare.data, null, 'without fields a passing expect omits the body, as before');
  const failing = (await server.call({ method: 'GET', path: '/one', stack: 'lab', fields, expect: [{ status: 201 }] })).body;
  assert.equal(failing.ok, false);
  assert.equal(failing.data.secretish, 'not-requested', 'a failure still carries the body sample, as before');
});

test('a missing credential reads sent after a response, attempted when none came back, and nothing when nothing went out', async t => {
  const f = await fixture(t, { auth: `bearer:${TOKEN_VAR}`,
    reply: req => req.url === '/hang' ? { hang: true } : req.url === '/reset' ? { reset: true } : {} });
  const fast = { API_TIMEOUT_MS: '1000' };
  const server = f.mcp(fast);
  const attempted = notice => {
    assert.equal(notice?.attempted_without_credentials, true);
    assert.equal(notice.sent_without_credentials, undefined, 'never reads as sent');
    assert.match(notice.message, /attempted without credentials and no response was received/);
    assert.doesNotMatch(notice.message, /was sent/);
    assert.deepEqual(notice.env, [TOKEN_VAR]);
  };
  // A 200: sent.
  const ok = (await server.call({ method: 'GET', path: '/health', stack: 'lab' })).body;
  assert.equal(ok.auth_missing.sent_without_credentials, true);
  assert.equal(ok.auth_missing.attempted_without_credentials, undefined);
  assert.match(ok.auth_missing.message, /was sent without credentials/);
  // A timeout and a reset: attempted, no response.
  const timedOut = (await server.call({ method: 'GET', path: '/hang', stack: 'lab' })).body;
  assert.equal(timedOut.error.code, 'REQUEST_TIMEOUT');
  attempted(timedOut.auth_missing);
  const reset = (await server.call({ stack: 'lab', requests: [{ path: '/reset', expect: [{ status: 200 }] }] })).body;
  assert.equal(reset.ok, false);
  attempted(reset.results[0].auth_missing);
  const cli = await f.cli(['request', 'GET', '/hang', '--stack', 'lab'], fast);
  assert.equal(cli.code, 1);
  attempted(JSON.parse(cli.stdout).auth_missing);
  const lines = cli.stderr.split('\n').filter(line => line.includes(TOKEN_VAR));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /attempted without credentials and no response was received/);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(call => !call.hasAuthorization));
  // Rejected by the client before any network attempt: no notice, nothing sent.
  for (const args of [
    { method: 'GET', path: '/health', headers: { 'x-a': 'bad\nvalue' } },
    { method: 'GET', path: '/health', headers: { 'bad name': 'v' } },
    { method: 'G E T', path: '/health' },
    { method: 'CONNECT', path: '/health' },
    { method: 'GET', path: '/health', body: { a: 1 } },
    { method: 'GET', path: '/health', expect: { status: 200 } },
  ]) {
    const label = JSON.stringify(args);
    const out = await server.call({ ...args, stack: 'lab' });
    assert.equal(out.body.ok === true, false, label);
    assert.equal(out.body.auth_missing, undefined, `${label}: no notice for a request that never went out`);
  }
  assert.equal(f.calls.length, 4, 'none of the rejected requests reached the server');
});

test('a stack whose port refuses connections reads attempted, not sent', async t => {
  const f = await fixture(t);
  // A second stack on a port nothing listens on: bind one, then close it.
  const closed = createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const added = await f.cli(['stack', 'add', 'gone', '--base-url', `http://127.0.0.1:${port}`, '--auth', `bearer:${TOKEN_VAR}`, '--json']);
  assert.equal(added.code, 0, added.stderr);
  const out = await f.cli(['request', 'GET', '/health', '--stack', 'gone']);
  assert.equal(out.code, 1);
  const result = JSON.parse(out.stdout);
  assert.equal(result.error.code, 'ECONNREFUSED');
  assert.equal(result.auth_missing.attempted_without_credentials, true);
  assert.equal(result.auth_missing.sent_without_credentials, undefined);
  assert.match(out.stderr, /QAFIX_CLIENT_TOKEN is not set; the request was attempted without credentials and no response was received/);
});

test('suite run and verify name a missing credential once per variable and in their JSON steps', async t => {
  const f = await fixture(t, { auth: `bearer:${TOKEN_VAR}` });
  for (const name of ['first', 'second']) {
    writeFileSync(join(f.root, `${name}.json`), JSON.stringify({ v: 2, requests: [
      { path: '/health', expect: [{ status: 200 }] }, { path: '/again', expect: [{ status: 200 }] }] }));
    const save = await f.cli(['suite', 'save', name, `${name}.json`, '--stack', 'lab']);
    assert.equal(save.code, 0, save.stderr);
  }
  for (const command of [['suite', 'run'], ['verify']]) {
    const out = await f.cli([...command, '--stack', 'lab', '--json']);
    assert.equal(out.code, 0, `${command.join(' ')}: ${out.stderr}`);
    const lines = out.stderr.split('\n').filter(line => line.includes(TOKEN_VAR));
    assert.equal(lines.length, 1, `${command.join(' ')}: one line for the whole command: ${out.stderr}`);
    const report = JSON.parse(out.stdout);
    const steps = report.suites.flatMap(suite => suite.steps);
    assert.equal(steps.length, 4);
    for (const step of steps) assert.deepEqual(step.auth_missing?.env, [TOKEN_VAR], `${command.join(' ')} step ${step.op}`);
  }
  assert.ok(f.calls.length >= 8 && f.calls.every(call => !call.hasAuthorization));
});

test('learn reports reads sent or attempted without their credential, in its JSON and once per variable on stderr', async t => {
  const f = await fixture(t, { reply: req => req.url === '/hang' ? { hang: true } : {} });
  const ok = { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } };
  writeFileSync(join(f.root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'fixture', version: '1' },
    paths: { '/health': { get: { responses: { 200: ok } } }, '/hang': { get: { responses: { 200: ok } } } } }));
  const added = await f.cli(['stack', 'add', 'learnlab', '--base-url', f.origin, '--auth', `bearer:${TOKEN_VAR}`, '--contract', 'openapi.json', '--json']);
  assert.equal(added.code, 0, added.stderr);
  const out = await f.cli(['learn', '--stack', 'learnlab'], { API_TIMEOUT_MS: '1000' });
  const report = JSON.parse(out.stdout);
  const byOp = Object.fromEntries(report.operations.map(item => [item.op, item]));
  assert.equal(byOp['GET /health'].auth_missing?.sent_without_credentials, true, `learn report: ${out.stdout}`);
  assert.deepEqual(byOp['GET /health'].auth_missing.env, [TOKEN_VAR]);
  assert.equal(byOp['GET /hang'].auth_missing?.attempted_without_credentials, true, 'the learn catch path keeps the notice');
  const lines = out.stderr.split('\n').filter(line => line.includes(TOKEN_VAR));
  assert.equal(lines.length, 1, out.stderr);
  assert.match(lines[0], /was sent without credentials/);
  // The notice is report-only: the committed knowledge file never carries it.
  const committed = readFileSync(join(f.root, '.sannr', 'stacks', 'learnlab', 'sannr.json'), 'utf8');
  assert.doesNotMatch(committed, /auth_missing|sent_without_credentials|attempted_without_credentials/);
});

test('the protocol command and request envelope keep the notice when a sent request then fails', async t => {
  const f = await fixture(t, { auth: `bearer:${TOKEN_VAR}`, reply: req => req.url === '/hang' ? { hang: true } : {} });
  const fast = { API_TIMEOUT_MS: '1000' };
  writeFileSync(join(f.root, 'hang.json'), JSON.stringify({ protocol: 'http', method: 'GET', path: '/hang', stack: 'lab' }));
  const protocol = await f.cli(['protocol', 'hang.json'], fast);
  assert.equal(protocol.code, 1);
  const single = JSON.parse(protocol.stdout);
  assert.equal(single.error.code, 'REQUEST_TIMEOUT');
  assert.equal(single.auth_missing?.attempted_without_credentials, true, 'the protocol command catch keeps the notice');
  assert.equal(protocol.stderr.split('\n').filter(line => line.includes(TOKEN_VAR)).length, 1);
  const envelope = await f.cli(['request', 'envelope', JSON.stringify({ v: 2, requests: [{ path: '/hang', expect: [{ status: 200 }] }] }), '--stack', 'lab'], fast);
  assert.equal(envelope.code, 1);
  assert.equal(JSON.parse(envelope.stdout).results[0].auth_missing?.attempted_without_credentials, true);
  assert.match(envelope.stderr, /QAFIX_CLIENT_TOKEN is not set; the request was attempted without credentials/);
  assert.equal(f.calls.length, 2);
});

test('the notice names a legacy environment, a hosts entry, API_AUTH and OAuth references without an absolute path', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'envelope-truth-legacy-')));
  const calls = [];
  const server = createServer((req, res) => { calls.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = (auth, args, extra = {}) => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ default: 'fixture',
      environments: { fixture: { baseUrl: origin, auth } }, hosts: { peer: { baseUrl: `${origin}/peer`, auth: 'bearer:QAFIX_PEER_TOKEN' } } }));
    return new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e',
      `const client = await import(${JSON.stringify(clientUrl)}); process.stdout.write(JSON.stringify(await client.apiRequest(${JSON.stringify(args)})));`],
    { cwd: root, encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'state'),
      API_CONFIG: join(root, 'config.json'), API_CONTEXT_DIR: root, API_CONTEXT_OFF: '1', API_EVIDENCE: join(root, 'evidence'),
      API_USAGE_LOG: '', API_FRICTION_OFF: '1', API_TIMEOUT_MS: '5000', ...extra } },
    (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout).auth_missing)));
  };
  const forms = [
    [await run(`bearer:${TOKEN_VAR}`, { path: '/health' }), /^environments\.fixture\.auth \(config\.json\) references environment variable QAFIX_CLIENT_TOKEN/],
    [await run(`bearer:${TOKEN_VAR}`, { path: '/health', upstream: 'peer' }), /^hosts\.peer\.auth references environment variable QAFIX_PEER_TOKEN/],
    [await run('bearer:QAFIX_OTHER_TOKEN', { path: '/health' }, { API_AUTH: `bearer:${TOKEN_VAR}` }), /^API_AUTH references environment variable QAFIX_CLIENT_TOKEN/],
    [await run('oauth:QAFIX_CID:QAFIX_SECRET', { path: '/health' }, { API_OAUTH_TOKEN_URL: `${origin}/token` }), /^environments\.fixture\.auth \(config\.json\) references environment variable QAFIX_CID/],
  ];
  for (const [notice, form] of forms) {
    assert.equal(notice?.sent_without_credentials, true);
    assert.match(notice.message, form);
    assert.equal(JSON.stringify(notice).includes(root), false, 'no absolute path');
    assert.doesNotMatch(notice.message, /(^|[\s(])\/[A-Za-z]/, 'no absolute path');
  }
  assert.deepEqual(forms[3][0].env, ['QAFIX_CID', 'QAFIX_SECRET']);
  assert.equal(calls.includes('/token'), false, 'OAuth with unset client variables never reaches the token endpoint');
});
