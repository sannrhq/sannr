import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { createFixtureStack } from './helpers/stack-fixture.mjs';
import { saveSavedRequest, showSavedRequest, listSavedRequests, renameSavedRequest, deleteSavedRequest, reopenSavedRequest, savedRequestContext } from '../lib/saved-requests.mjs';
import { readSavedRequestInputFile, resolveSavedRequestInputs } from '../lib/saved-request-inputs.mjs';
import { savedRequestAction, savedActionFailure } from '../lib/saved-request-actions.mjs';
import { inspectRecordedResponse } from '../lib/response-inspection.mjs';
import { scrubForTest } from '../lib/client.mjs';
import { withPrivateRequestInputs } from '../lib/request-private-inputs.mjs';

const moduleUrl = new URL('../lib/saved-requests.mjs', import.meta.url).href;
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
const document = () => ({ kind: 'saved-request', format_version: 1, folder: 'orders', name: 'lookup', stack: 'fixture', environment: 'local',
  request: { method: 'GET', path: '/orders/{id}', bindings: { path: { id: { $input: 'order_id' } }, query: { detail: { $enum: 'compact' } }, headers: { 'x-private-note': { $input: 'private_note' } } } },
  inputs: { order_id: { type: 'string' }, private_note: { type: 'string', sensitive: true, source: { env: 'FIXTURE_NOTE' } } }, credentials: [] });
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'saved-requests-')), seen = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body });
      res.writeHead(req.url.includes('missing') ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'synthetic-order', note: req.headers['x-private-note'] ?? null, body }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const contract = { openapi: '3.0.3', info: { title: 'Fixture', version: '1' }, paths: {
    '/orders/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: { parameters: [
      { name: 'detail', in: 'query', required: true, schema: { type: 'string', enum: ['compact', 'full'] } },
      { name: 'x-private-note', in: 'header', schema: { type: 'string' } }], responses: { 200: { description: 'ok' }, 404: { description: 'absent' } } } },
    '/orders': { post: { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } } }, responses: { 200: { description: 'ok' } } } },
  } };
  write(join(root, 'openapi.json'), contract);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  createFixtureStack(root, { contract: 'openapi.json', baseUrl });
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'machine', 'usage.jsonl'), API_BUDGET: '6000', API_FRICTION_OFF: '1', NO_COLOR: '1' };
  mkdirSync(env.HOME, { recursive: true });
  return { root, seen, env, contract, baseUrl };
}
function run(f, data, extraEnv = {}) {
  const script = `import {readFileSync} from 'node:fs'; const api=await import(${JSON.stringify(moduleUrl)}); const data=JSON.parse(readFileSync(0,'utf8')); try { const result=await api.runSavedRequest(process.cwd(),data.ref??data.document,{...data.options,initiator:'cli.saved'});console.log(JSON.stringify(result));} catch(error){console.log(JSON.stringify({ok:false,error:{code:error.code,message:error.message,next:error.next,details:error.details}}));}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, env: { ...f.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject); child.once('close', code => { if (code) reject(new Error(`Child ${code}: ${stderr}`)); else try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid child output: ${stdout} ${stderr}`)); } });
    child.stdin.end(JSON.stringify(data));
  });
}
const refusal = (action, code) => assert.throws(action, error => error.code === code);

test('private response preview curates and re-masks headers, bounds UTF-8 and distinguishes absent API time', t => {
  const root = mkdtempSync(join(tmpdir(), 'response-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createFixtureStack(root);
  const runId = 'run-preview', file = join(root, LAYOUT.evidence, 'fixture', `${runId}.json`);
  const token = 'synthetic-private-credential', signed = 'https://files.example.test/object?X-Amz-Signature=synthetic-signature';
  const record = { runId, durationMs: 12.5, response: { status: 200,
    headers: { 'Content-Type': 'application/json', 'content-length': '48000', etag: token,
      location: signed, link: `Bearer ${'a'.repeat(32)}`, 'x-request-id': 'x'.repeat(1023) + '🐦'.repeat(400),
      authorization: 'Bearer private-header-only-credential', 'set-cookie': 'session=private-cookie-value',
      'x-provider-private': 'unselected-header-value', 'retry-after': { invalid: 'not a string' } },
    body: { password: token, message: '🐦'.repeat(12000) },
  } };
  write(file, record);
  const before = readFileSync(file), preview = inspectRecordedResponse(root, { runId, stack: 'fixture' });
  assert.equal(preview.duration_ms, 12.5);
  assert.equal(preview.headers['content-type'], 'application/json');
  assert.equal(preview.headers['content-length'], '48000');
  assert.deepEqual(Object.keys(preview.headers).sort(), ['content-length', 'content-type', 'etag', 'link', 'location', 'x-request-id']);
  for (const value of [token, signed, 'a'.repeat(32), 'private-header-only-credential', 'private-cookie-value', 'unselected-header-value'])
    assert.ok(!JSON.stringify(preview).includes(value), 'secret and uncurated header values remain private');
  assert.match(preview.headers.etag, /withheld/); assert.match(preview.headers.location, /withheld/);
  assert.equal(preview.headers_total, 10); assert.equal(preview.headers_omitted, 4);
  assert.equal(preview.header_values_truncated, 1);
  assert.ok(Buffer.byteLength(preview.headers['x-request-id']) <= 1024);
  assert.ok(Buffer.byteLength(preview.body_text) <= 32768); assert.ok(preview.omitted_bytes > 0);
  assert.equal(preview.omitted_bytes, preview.body_bytes - Buffer.byteLength(preview.body_text));
  assert.ok(!preview.headers['x-request-id'].includes('\ufffd')); assert.ok(!preview.body_text.includes('\ufffd'));
  assert.deepEqual(readFileSync(file), before, 'inspection never rewrites the original receipt');
  for (const duration of [undefined, null, '12', -1, 0]) {
    write(file, { ...record, durationMs: duration });
    assert.equal(inspectRecordedResponse(root, { runId, stack: 'fixture' }).duration_ms, duration === 0 ? 0 : null);
  }
  // JSON can represent an overflowing number lexically; accepting it as API time
  // would make an invalid historical receipt look like a measured duration.
  writeFileSync(file, JSON.stringify(record).replace('"durationMs":12.5', '"durationMs":1e999'));
  assert.equal(inspectRecordedResponse(root, { runId, stack: 'fixture' }).duration_ms, null);
  for (const response of [{ status: 200, headers: { 'content-type': 'image/png' } }, { status: 200, body: null }]) {
    write(file, { runId, response });
    const read = inspectRecordedResponse(root, { runId, stack: 'fixture' });
    assert.equal(read.body_available, Object.hasOwn(response, 'body'));
    if (!read.body_available) assert.match(read.body_unavailable_reason, /not retained/);
    else { assert.equal(read.body_text, 'null'); assert.equal(read.body_unavailable_reason, null); }
  }
  for (const password of ['body', 'headers', 'etag']) {
    write(file, { runId, response: { body: { password }, headers: { etag: password } } });
    const read = inspectRecordedResponse(root, { runId, stack: 'fixture' });
    assert.match(read.body_text, /withheld/);
    if (password === 'etag') { assert.deepEqual(read.headers, {}); assert.equal(read.headers_omitted, 1); }
    else assert.match(read.headers.etag, /withheld/);
  }
});

test('portable create/show/list preserve shape; literals, required inputs and unsafe paths refuse without traffic', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document());
  assert.equal(f.seen.length, 0); assert.equal(saved.ref, 'orders/lookup');
  assert.equal(showSavedRequest(f.root, saved.ref).document.id, saved.document.id);
  assert.equal(listSavedRequests(f.root).requests[0].id, saved.document.id);
  const literal = document(); literal.request.bindings.query.detail = 'private-query-value';
  refusal(() => saveSavedRequest(f.root, literal), 'SAVED_BINDING_INVALID');
  const missing = document(); delete missing.request.bindings.query.detail;
  refusal(() => saveSavedRequest(f.root, missing), 'SAVED_BINDING_MISSING');
  const enumBad = document(); enumBad.request.bindings.query.detail = { $enum: 'private-query-value' };
  refusal(() => saveSavedRequest(f.root, enumBad), 'SAVED_LITERAL_NOT_ENUM');
  refusal(() => showSavedRequest(f.root, '../outside'), 'SAVED_REQUEST_PATH');
  const outside = join(f.root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(f.root, LAYOUT.directory, 'requests', 'linked'));
  refusal(() => saveSavedRequest(f.root, { ...document(), folder: 'linked' }), 'SAVED_REQUEST_UNSAFE_PATH');
  assert.equal(listSavedRequests(f.root).issues[0].code, 'SAVED_REQUEST_UNSAFE_PATH');
  assert.equal(f.seen.length, 0);
});

test('send uses current engine, creates separate receipts, preserves HTTP failure, masks sensitive reflections and discovers bounded references', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document()), secret = 'private-runtime-note-739204';
  const data = { ref: saved.ref, options: { inputStdin: JSON.stringify({ order_id: 'missing', private_note: secret }) } };
  const first = await run(f, data), second = await run(f, { ...data, options: { inputStdin: JSON.stringify({ order_id: 'found', private_note: secret }) } });
  assert.equal(first.status, 404); assert.equal(second.status, 200);
  assert.equal(first.assertions, null); assert.equal(second.saved_request.assertions, 'not_run');
  assert.notEqual(first.evidence, second.evidence); assert.notEqual(first.saved_request.execution_id, second.saved_request.execution_id);
  assert.equal(f.seen[0].headers['x-private-note'], secret); assert.equal(f.seen[0].path, '/v1/orders/missing?detail=compact');
  assert.ok(!JSON.stringify(first).includes(secret)); assert.ok(!JSON.stringify(second).includes(secret));
  const evidence = join(f.root, LAYOUT.evidence, 'fixture');
  for (const file of readdirSync(evidence).filter(file => file.endsWith('.json'))) assert.ok(!readFileSync(join(evidence, file), 'utf8').includes(secret), file);
  assert.ok(!readFileSync(join(f.root, 'machine', 'usage.jsonl'), 'utf8').includes(secret));
  assert.equal(second.known.saved_requests.requests[0].ref, saved.ref);
  const context = savedRequestContext(f.root, { stack: 'fixture', environment: 'local', operation: 'GET /orders/{id}', maxBytes: 180 });
  assert.equal(context.bytes, Buffer.byteLength(JSON.stringify(context))); assert.ok(context.bytes <= 180);
  assert.ok(!JSON.stringify(context).includes('private_note'));
  const expanded = await run(f, { ref: saved.ref, options: { inputs: { order_id: 'found', private_note: 'lookup' } } });
  assert.equal(expanded.known.saved_requests.bytes, Buffer.byteLength(JSON.stringify(expanded.known.saved_requests)));
  assert.equal(expanded.known.saved_requests.requests[0].ref, 'orders/[redacted]');
  assert.equal(savedRequestContext(f.root, { stack: 'fixture', environment: 'local', operation: 'GET /orders/{id}', env: { API_CONTEXT_OFF: '1' } }), null);
  const off = await run(f, data, { API_CONTEXT_OFF: '1' }); assert.equal(off.known, null);
});

test('wrong scope, missing/type input, changed credential reference and production refusal send no traffic', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document());
  const cases = [
    [{ environment: 'production', inputs: {} }, 'SAVED_REQUEST_SCOPE_MISMATCH'],
    [{ inputs: {} }, 'SAVED_INPUT_MISSING'],
    [{ inputs: { order_id: 3, private_note: 'synthetic' } }, 'SAVED_INPUT_TYPE'],
    [{ inputs: { order_id: 'found', private_note: 'synthetic', unknown: 'never-print-me' } }, 'SAVED_INPUT_UNKNOWN'],
  ];
  for (const [options, code] of cases) { const out = await run(f, { ref: saved.ref, options }); assert.equal(out.error.code, code); assert.ok(!JSON.stringify(out).includes('never-print-me')); }
  const file = join(f.root, LAYOUT.collection, 'fixture', 'stack.json'), config = JSON.parse(readFileSync(file));
  config.environments.local.auth = 'bearer:FIXTURE_TOKEN'; write(file, config);
  assert.equal((await run(f, { ref: saved.ref })).error.code, 'SAVED_CREDENTIAL_SCOPE_MISMATCH');
  const bound = saveSavedRequest(f.root, { ...saved.document, credentials: ['bearer:FIXTURE_TOKEN'] }, { overwrite: true });
  const missingCredential = await run(f, { ref: bound.ref, options: { inputs: { order_id: 'found', private_note: 'synthetic' } } });
  assert.equal(missingCredential.error.code, 'IMPORTED_AUTH_VALUE_REQUIRED');
  delete config.environments.local.auth; config.environments.local.production = true; write(file, config);
  const post = saveSavedRequest(f.root, { ...document(), name: 'create', request: { method: 'POST', path: '/orders', bindings: { body: { title: { $input: 'title' } } } }, inputs: { title: { type: 'string' } } });
  const production = await run(f, { ref: post.ref, options: { inputs: { title: 'synthetic' } } });
  assert.equal(production.mode, 'refused'); assert.match(production.error.code, /PROD/);
  assert.equal(f.seen.length, 0);
});

test('safe local file inputs require Git ignored/untracked regular files; environment references work', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document()), secret = 'local-file-private-text-8297';
  write(join(f.root, 'local-inputs.json'), { order_id: 'found', private_note: secret });
  refusal(() => readSavedRequestInputFile(f.root, 'local-inputs.json'), 'SAVED_INPUT_FILE_NOT_PRIVATE');
  writeFileSync(join(f.root, '.gitignore'), 'local-inputs.json\n');
  const out = await run(f, { ref: saved.ref, options: { inputFile: 'local-inputs.json' } }); assert.equal(out.status, 200); assert.ok(!JSON.stringify(out).includes(secret));
  execFileSync('git', ['add', '--force', 'local-inputs.json'], { cwd: f.root });
  refusal(() => readSavedRequestInputFile(f.root, 'local-inputs.json'), 'SAVED_INPUT_FILE_NOT_PRIVATE');
  const envOut = await run(f, { ref: saved.ref, options: { inputs: { order_id: 'found' } } }, { FIXTURE_NOTE: secret });
  assert.equal(envOut.status, 200); assert.ok(!JSON.stringify(envOut).includes(secret));
  const ordinary = structuredClone(saved.document); ordinary.inputs.private_note.sensitive = false;
  saveSavedRequest(f.root, ordinary, { overwrite: true });
  const opaque = await run(f, { ref: saved.ref, options: { inputs: { order_id: 'found' } } }, { FIXTURE_NOTE: secret });
  assert.equal(opaque.status, 200); assert.ok(!JSON.stringify(opaque).includes(secret));
  const configFile = join(f.root, LAYOUT.collection, 'fixture', 'stack.json'), config = JSON.parse(readFileSync(configFile));
  config.environments.local.auth = 'bearer:FIXTURE_NOTE'; write(configFile, config);
  refusal(() => saveSavedRequest(f.root, { ...ordinary, credentials: ['bearer:FIXTURE_NOTE'] }, { overwrite: true }), 'SAVED_CREDENTIAL_BINDING');
});

test('history reopen never copies values, rename/delete retain receipts, and clone reuse needs fresh inputs', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document());
  const original = await run(f, { ref: saved.ref, options: { inputs: { order_id: 'private-order-id', private_note: 'private-history-note' } } });
  const draft = reopenSavedRequest(f.root, { runId: original.evidence, stack: 'fixture' });
  assert.equal(draft.traffic, 'none'); assert.equal(f.seen.length, 1); assert.ok(!JSON.stringify(draft).includes('private-order-id')); assert.ok(!JSON.stringify(draft).includes('private-history-note'));
  assert.equal(draft.document.source.run_id, original.evidence); assert.ok(draft.missing_inputs.length >= 2);
  const renamed = renameSavedRequest(f.root, saved.ref, { folder: 'archive', name: 'renamed' }); assert.equal(renamed.document.id, saved.document.id);
  const clone = join(f.root, 'clone'); mkdirSync(clone); cpSync(join(f.root, LAYOUT.collection), join(clone, LAYOUT.collection), { recursive: true }); cpSync(join(f.root, LAYOUT.directory, 'requests'), join(clone, LAYOUT.directory, 'requests'), { recursive: true });
  const fresh = { ...f, root: clone, env: { ...f.env, API_CONTEXT_DIR: clone, HOME: join(clone, 'home'), [HOME_ENV_NAME]: join(clone, 'machine'), API_USAGE_LOG: join(clone, 'machine', 'usage.jsonl') } }; mkdirSync(fresh.env.HOME);
  assert.equal(showSavedRequest(clone, renamed.ref).document.id, saved.document.id);
  const missing = await run(fresh, { ref: renamed.ref }); assert.equal(missing.error.code, 'SAVED_INPUT_MISSING');
  refusal(() => reopenSavedRequest(clone, { runId: original.evidence, stack: 'fixture' }), 'SAVED_HISTORY_UNAVAILABLE');
  const resumed = await run(fresh, { ref: renamed.ref, options: { inputs: { order_id: 'fresh', private_note: 'fresh-local-secret' } } }); assert.equal(resumed.status, 200); assert.notEqual(resumed.evidence, original.evidence);
  deleteSavedRequest(f.root, renamed.ref); assert.equal(listSavedRequests(f.root).requests.length, 0);
  assert.ok(readFileSync(join(f.root, LAYOUT.evidence, 'fixture', `${original.evidence}.json`)));
});

test('contractless bound drafts are author-declared, enum promotion is refused, and runtime file directives never read', async t => {
  const f = await fixture(t), file = join(f.root, LAYOUT.collection, 'fixture', 'stack.json'), config = JSON.parse(readFileSync(file)); delete config.contract; write(file, config);
  const raw = { ...document(), name: 'blank', request: { method: 'POST', path: '/orders', bindings: { body: { $input: 'payload' } } }, inputs: { payload: { type: 'object' } } };
  const saved = saveSavedRequest(f.root, raw); assert.match(showSavedRequest(f.root, saved.ref).readiness.basis, /author-declared/);
  const out = await run(f, { ref: saved.ref, options: { inputs: { payload: { $file: '/etc/passwd' } } } }); assert.equal(out.error.code, 'SAVED_INPUT_STRUCTURE'); assert.equal(f.seen.length, 0);
  const noContractEnum = document(); refusal(() => saveSavedRequest(f.root, noContractEnum), 'SAVED_LITERAL_NOT_ENUM');
  const clean = await run(f, { ref: saved.ref, options: { inputs: { payload: { title: 'synthetic' } } } }); assert.equal(clean.status, 200);
});

test('whole-body inputs check nested contract schemas and expanded environment inputs stay bounded', async t => {
  const f = await fixture(t), contractPath = join(f.root, LAYOUT.collection, 'fixture', 'openapi.json');
  const raw = { ...document(), name: 'structured', request: { method: 'POST', path: '/orders', bindings: { body: { $input: 'payload' } } }, inputs: { payload: { type: 'object' } } };
  const schema = f.contract.paths['/orders'].post.requestBody.content['application/json'];
  schema.schema = { type: 'object', required: ['nested'], properties: { nested: { type: 'object', allOf: [{ required: ['missing'] }] } } };
  write(contractPath, f.contract);
  const saved = saveSavedRequest(f.root, raw);
  const composed = await run(f, { ref: saved.ref, options: { inputs: { payload: { nested: {} } } } });
  assert.equal(composed.error.code, 'SAVED_CONTRACT_UNSUPPORTED');
  schema.schema = { type: 'object', additionalProperties: { type: 'string' } }; write(contractPath, f.contract);
  const wrongType = await run(f, { ref: saved.ref, options: { inputs: { payload: { undeclared: 123 } } } });
  assert.equal(wrongType.error.code, 'SAVED_INPUT_TYPE');
  schema.schema = { type: 'object', additionalProperties: false }; write(contractPath, f.contract);
  const unexpected = await run(f, { ref: saved.ref, options: { inputs: { payload: { undeclared: 'value' } } } });
  assert.equal(unexpected.error.code, 'SAVED_INPUT_FIELD');
  assert.equal(f.seen.length, 0);
  const keys = ['SAVED_FIXTURE_ENV_A', 'SAVED_FIXTURE_ENV_B', 'SAVED_FIXTURE_ENV_C'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'x'.repeat(100000);
    const declarations = Object.fromEntries(keys.map((key, index) => [`input_${index}`, { type: 'string', source: { env: key } }]));
    refusal(() => resolveSavedRequestInputs(f.root, declarations), 'SAVED_INPUT_LIMIT');
  } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
});


test('contract draft declares required request fields without examples, private values, writes or traffic', async t => {
  const f = await fixture(t), contractFile = join(f.root, LAYOUT.collection, 'fixture', 'openapi.json');
  f.contract.paths['/sessions/{id}'] = { post: {
    parameters: [
      { in: 'path', name: 'id', required: true, schema: { type: 'string', example: 'private-example-path' } },
      { in: 'query', name: 'retry', required: true, schema: { type: 'integer', enum: [0, 1, 2], default: 99 } },
      { in: 'header', name: 'x-confirm', required: true, schema: { type: 'boolean' } },
      { in: 'query', name: 'optional', schema: { type: 'string' } },
    ],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['session_token', 'settings'], properties: {
        session_token: { type: 'string', description: 'private-description', example: 'private-example-token' },
        settings: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' }, label: { type: 'string' } } },
      },
    } } } }, responses: { 200: { description: 'ok' } },
  } };
  write(contractFile, f.contract);
  const configFile = join(f.root, LAYOUT.collection, 'fixture', 'stack.json'), config = JSON.parse(readFileSync(configFile));
  config.environments.local.auth = 'bearer:FIXTURE_TOKEN'; write(configFile, config);
  const before = readdirSync(join(f.root, LAYOUT.directory), { recursive: true }).sort();
  const result = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'POST /sessions/{id}' }, { readOnly: true });
  assert.equal(result.ready, true); assert.equal(result.traffic, 'none'); assert.equal(result.document.environment, 'local');
  assert.equal(result.document.request.body_type, 'json'); assert.deepEqual(result.document.credentials, ['bearer:FIXTURE_TOKEN']);
  assert.deepEqual(result.fields.map(field => [field.label, field.type]), [['path.id', 'string'], ['query.retry', 'integer'], ['headers.x-confirm', 'boolean'], ['body.session_token', 'string'], ['body.settings.enabled', 'boolean']]);
  assert.deepEqual(result.fields.find(field => field.label === 'query.retry').enum, [0, 1, 2]);
  const tokenField = result.fields.find(field => field.label === 'body.session_token');
  assert.equal(result.document.inputs[tokenField.input].sensitive, true);
  assert.deepEqual(result.document.request.bindings.body.session_token, { $input: tokenField.input });
  assert.match(result.warnings.find(w => w.code === 'SAVED_DRAFT_OPTIONAL_OMITTED').message, /2/);
  assert.ok(!JSON.stringify(result).match(/private-example|private-description|default|\b99\b/));
  assert.deepEqual(readdirSync(join(f.root, LAYOUT.directory), { recursive: true }).sort(), before); assert.equal(f.seen.length, 0);
  saveSavedRequest(f.root, result.document);
});

test('incomplete contract drafts block with a named field; missing-body errors explain the required fields', async t => {
  const f = await fixture(t), request = { ...document(), request: { method: 'POST', path: '/orders', bindings: {} }, inputs: {} };
  let failure; try { saveSavedRequest(f.root, request); } catch (error) { failure = savedActionFailure(error); }
  assert.equal(failure.error.code, 'SAVED_BINDING_MISSING'); assert.match(failure.error.message, /body.title/);
  assert.match(failure.error.next, /required.*field/i);
  f.contract.paths['/orders'].post.requestBody.content['application/json'].schema.properties.title = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
  const result = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'POST /orders' });
  assert.equal(result.ready, false); assert.equal(result.warnings.some(w => w.blocking && /body.title/.test(w.message)), true);
  f.contract.paths['/orders'].post.requestBody.content = { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } };
  write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
  const form = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'POST /orders' });
  assert.equal(form.ready, true); assert.equal(form.document.request.body_type, 'form');
  saveSavedRequest(f.root, form.document);
  f.contract.paths['/orders'].post.requestBody.content['application/x-www-form-urlencoded'].schema.properties.title = { type: 'object', required: ['nested'], properties: { nested: { type: 'string' } } };
  write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
  const nestedForm = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'POST /orders' });
  assert.equal(nestedForm.ready, false); assert.equal(nestedForm.warnings.some(w => w.blocking && /scalar fields/.test(w.message)), true);
  for (const location of ['cookie', 'formData']) {
    f.contract.paths['/unsupported'] = { get: { parameters: [{ in: location, name: 'required_field', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } };
    write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
    const unsupported = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'GET /unsupported' });
    assert.equal(unsupported.ready, false, location);
    assert.equal(unsupported.warnings.some(w => w.blocking && w.message.includes(`${location}.required_field`)), true);
  }
  for (const choices of [[{ hidden: 'not-a-scalar' }], ['sk_syntheticNeverUseThisValue']]) {
    f.contract.paths['/enum'] = { get: { parameters: [{ in: 'query', name: 'choice', required: true, schema: { type: 'string', enum: choices } }], responses: { 200: { description: 'ok' } } } };
    write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
    const unsafeEnum = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'GET /enum' });
    assert.equal(unsafeEnum.ready, false);
    assert.equal(JSON.stringify(unsafeEnum).includes('not-a-scalar'), false);
    assert.equal(JSON.stringify(unsafeEnum).includes('sk_syntheticNeverUseThisValue'), false);
  }
  assert.equal(f.seen.length, 0);
});

// QA-L3-01. A private request input (a saved request's sensitive string, as
// the Workbench's Request view and `saved run` send it) is removed from what
// the client records and returns. A value shorter than six characters is
// removed only where it stands as a whole value; longer values and configured
// credentials keep the substring scrub. orderId "1" had rewritten the stored
// host, port and Date header.
const R = '[redacted]';
const showSavedRequestDocument = (root, ref) => structuredClone(showSavedRequest(root, ref).document);
const scrubWith = (inputs, value, secrets = [], structure) =>
  JSON.parse(withPrivateRequestInputs(inputs, () => scrubForTest(JSON.stringify(value), secrets, structure)));
// Inputs whose declaration names an environment source.
const scrubWithEnvironment = (inputs, value, structure) =>
  JSON.parse(withPrivateRequestInputs(inputs, () => scrubForTest(JSON.stringify(value), [], structure), { environment: inputs }));

test('a short private input is removed only where it stands as a whole value', () => {
  const out = scrubWith(['1'], {
    request: { url: 'http://127.0.0.1:4731/v1/orders/1/quote?ref=1&page=10#1' },
    response: { headers: { date: 'Thu, 19 Nov 2026 02:46:59 GMT', 'x-order': '1', location: '/v1/orders/1?ref=1' },
      body: { orderId: '1', label_id: 'lbl_1', count: 1, list: ['1', '11'], 1: 'keyed', text: 'order 1 at 127.0.0.1' } },
  }, [], 'httpEvidence');
  assert.equal(out.request.url, `http://127.0.0.1:4731/v1/orders/${R}/quote?ref=${R}&page=10#1`);
  assert.equal(out.response.headers.date, 'Thu, 19 Nov 2026 02:46:59 GMT');
  assert.equal(out.response.headers['x-order'], R);
  assert.equal(out.response.headers.location, `/v1/orders/${R}?ref=${R}`);
  assert.deepEqual(out.response.body, { orderId: R, label_id: 'lbl_1', count: 1, list: [R, '11'], [R]: 'keyed', text: 'order 1 at 127.0.0.1' });
  // Encoded forms of a short value still count as the whole value.
  const spaced = scrubWith(['a b'], { url: 'https://api.example.test/x/a%20b?q=a+b&r=a%20b', v: 'a b', w: 'a%20b' });
  assert.deepEqual(spaced, { url: `https://api.example.test/x/${R}?q=${R}&r=${R}`, v: R, w: R });
  const encoded = Buffer.from('abcd').toString('base64');
  assert.deepEqual(scrubWith(['abcd'], { b: encoded, c: `x${encoded}` }), { b: R, c: `x${encoded}` });
  // Non-JSON text is one whole value.
  assert.equal(withPrivateRequestInputs(['M'], () => scrubForTest('M', [])), R);
  assert.equal(withPrivateRequestInputs(['M'], () => scrubForTest('GMT M', [])), 'GMT M');
});

test('a private input of six characters or more is still removed inside longer strings', () => {
  const out = scrubWith(['secret7'], { a: 'lbl_secret7', b: 'http://h.test/p/xsecret7y', c: Buffer.from('secret7').toString('base64') });
  assert.deepEqual(out, { a: `lbl_${R}`, b: `http://h.test/p/x${R}y`, c: R });
});

test('an input value never alters what the client writes about the request (origin, method, authUsed); a credential still does', () => {
  const origin = { observed_at: '2026-11-19T16:03:07.575Z', package_version: '0.1.0-beta.2', build_id: 'build-secret7-1',
    session_id: 'sess-1111', scope: { provider: 'http://127.0.0.1:4731/v1', operation: 'GET /orders/{orderId}/quote', contract_digest: 'sha256:11secret7' } };
  const record = { runId: 'run-1', origin, request: { method: 'GET', url: 'http://127.0.0.1:4731/v1/orders/1/secret7', authUsed: 'bearer:ORDERS_TOKEN' },
    drift: [{ kind: 'pagination-loop', requested: '/v1/orders/1' }] };
  for (const inputs of [['1'], ['secret7'], ['1', 'secret7', 'v1'], ['GET'], ['bearer'], ['ORDERS_TOKEN']]) {
    const out = scrubWith(inputs, record, [], 'httpEvidence');
    assert.deepEqual(out.origin, origin, inputs.join());
    assert.equal(out.request.method, 'GET', inputs.join());
    assert.equal(out.request.authUsed, 'bearer:ORDERS_TOKEN', inputs.join());
  }
  // Drift quotes what the API returned, so an input is still removed there.
  assert.equal(scrubWith(['1'], record, [], 'httpEvidence').drift[0].requested, `/v1/orders/${R}`);
  assert.equal(scrubWith([], record, ['bearer'], 'httpEvidence').request.authUsed, `${R}:ORDERS_TOKEN`);
  assert.equal(scrubWith(['1', 'secret7'], record, [], 'httpEvidence').request.url, `http://127.0.0.1:4731/v1/orders/${R}/${R}`);
  const credential = scrubWith(['1'], record, ['secret7'], 'httpEvidence');
  assert.equal(credential.origin.build_id, `build-${R}-1`);
  assert.equal(credential.origin.scope.contract_digest, `sha256:11${R}`);
  assert.equal(credential.origin.observed_at, origin.observed_at);
});

test('configured credentials keep the substring scrub, short ones included, beside short private inputs', () => {
  const value = { url: 'http://127.0.0.1:4731/v1/xabz/q?k=ab', header: 'Bearer ab', body: { k: 'zzabzz', ab: 'x', n: '9' } };
  const today = JSON.parse(scrubForTest(JSON.stringify(value), ['ab']));
  assert.deepEqual(today, { url: `http://127.0.0.1:4731/v1/x${R}z/q?k=${R}`, header: `Bearer ${R}`, body: { k: `zz${R}zz`, [R]: 'x', n: '9' } });
  // A short private input that matches nothing, or that equals the credential,
  // leaves the credential's scrub exactly as it was.
  for (const input of ['7', 'ab', 'zz']) assert.deepEqual(scrubWith([input], value, ['ab']), today, input);
  // Today's credential output, byte for byte, with no private input in scope.
  assert.equal(scrubForTest(JSON.stringify({ d: 'Thu, 19 Nov', u: 'http://127.0.0.1/1' }), ['1']), JSON.stringify({ d: `Thu, ${R}9 Nov`, u: `http://${R}27.0.0.${R}/${R}` }));
});

const DATE = 'Thu, 19 Nov 2026 02:46:59 GMT';

async function scrubFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'private-input-scrub-')), seen = [];
  const server = createServer((req, res) => {
    let text = ''; req.on('data', chunk => text += chunk); req.on('end', () => {
      seen.push(req.url);
      const url = new URL(req.url, 'http://local'), id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
      const sent = text ? JSON.parse(text) : {}, size = req.headers['x-size'] ?? sent.size ?? '', note = req.headers['x-note'] ?? '';
      res.setHeader('date', DATE);
      res.writeHead(200, { 'content-type': 'application/json', location: `${url.pathname}?ref=${url.searchParams.get('ref')}`, 'x-label': `lbl_${size}`, 'x-trace': 'trace-1111-ok' });
      res.end(JSON.stringify({ orderId: id, label_id: `lbl_${id}`, echo: { size }, quote: { window: 'am', amount: 1250 }, message: `saw ${note} here` }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  write(join(root, 'openapi.json'), { openapi: '3.0.3', info: { title: 'Fixture', version: '1' }, paths: {
    '/orders/{orderId}/quote': { get: { parameters: [
      { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'ref', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'x-size', in: 'header', required: true, schema: { type: 'string' } },
      { name: 'x-note', in: 'header', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } },
    '/labels': { post: { parameters: [{ name: 'x-note', in: 'header', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['size'], properties: { size: { type: 'string' } } } } } },
      responses: { 200: { description: 'ok' } } } } } });
  const port = server.address().port, baseUrl = `http://127.0.0.1:${port}/v1`;
  createFixtureStack(root, { contract: 'openapi.json', baseUrl });
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'machine', 'usage.jsonl'), API_BUDGET: '6000', API_FRICTION_OFF: '1', NO_COLOR: '1' };
  mkdirSync(env.HOME, { recursive: true });
  const saved = saveSavedRequest(root, { kind: 'saved-request', format_version: 1, folder: 'orders', name: 'quote', stack: 'fixture', environment: 'local',
    request: { method: 'GET', path: '/orders/{orderId}/quote', bindings: { path: { orderId: { $input: 'orderId' } }, query: { ref: { $input: 'ref' } },
      headers: { 'x-size': { $input: 'size' }, 'x-note': { $input: 'note' } } } },
    inputs: { orderId: { type: 'string', sensitive: true }, ref: { type: 'string', sensitive: true }, size: { type: 'string', sensitive: true }, note: { type: 'string', sensitive: true } },
    credentials: [] });
  // The note here comes from an environment variable: a secret by declaration.
  const label = saveSavedRequest(root, { kind: 'saved-request', format_version: 1, folder: 'labels', name: 'create', stack: 'fixture', environment: 'local',
    request: { method: 'POST', path: '/labels', bindings: { headers: { 'x-note': { $input: 'pin' } }, body: { size: { $input: 'size' } } } },
    inputs: { pin: { type: 'string', source: { env: 'FIXTURE_PIN' } }, size: { type: 'string', sensitive: true } }, credentials: [] });
  return { root, seen, env, port, ref: saved.ref, labelRef: label.ref };
}
// The same library call `saved run` and the Workbench's Send make, in its own process.
function scrubRun(f, inputs, { ref = f.ref, env = {} } = {}) {
  const script = `const api=await import(${JSON.stringify(moduleUrl)}); try { console.log(JSON.stringify(await api.runSavedRequest(process.cwd(), ${JSON.stringify(ref)}, { inputs: ${JSON.stringify(inputs)}, initiator: 'cli.saved' }))); } catch (error) { console.log(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, env: { ...f.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); if (code) reject(new Error(`Child ${code}: ${stderr}`)); else try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid child output: ${stdout} ${stderr}`)); } });
  });
}

test('saved run with short sensitive inputs keeps the stored host, port, Date and unrelated text intact', async t => {
  const f = await scrubFixture(t), note = 'private-note-4412';
  const result = await scrubRun(f, { orderId: '1', ref: 'M', size: 'M', note });
  assert.equal(result.status, 200, JSON.stringify(result.error ?? null));
  assert.equal(f.seen[0], `/v1/orders/1/quote?ref=M`);
  const dir = join(f.root, LAYOUT.evidence, 'fixture');
  const evidence = JSON.parse(readFileSync(join(dir, `${result.evidence}.json`), 'utf8'));
  assert.equal(evidence.request.url, `http://127.0.0.1:${f.port}/v1/orders/${R}/quote?ref=${R}`);
  assert.equal(evidence.response.headers.date, DATE);
  assert.equal(evidence.response.headers['content-type'], 'application/json');
  assert.equal(evidence.response.headers.location, `/v1/orders/${R}/quote?ref=${R}`);
  assert.equal(evidence.response.headers['x-label'], 'lbl_M');
  assert.equal(evidence.response.headers['x-trace'], 'trace-1111-ok');
  // The record's own provenance is never altered by an input value.
  const origin = JSON.stringify(evidence.origin);
  assert.ok(origin && !origin.includes(R), origin);
  assert.match(evidence.origin.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(evidence.response.body.orderId, R);
  assert.equal(evidence.response.body.label_id, 'lbl_1');
  // What the request carried: whole header values.
  assert.equal(evidence.request.headers['x-size'], R);
  assert.equal(evidence.request.headers['x-note'], R);
  // The returned envelope's data.
  assert.equal(result.data.orderId, R);
  assert.deepEqual(result.data.echo, { size: R });
  assert.equal(result.data.label_id, 'lbl_1');
  assert.deepEqual(evidence.response.body.echo, { size: R });
  assert.deepEqual(evidence.response.body.quote, { window: 'am', amount: 1250 });
  // A value of six characters or more is still removed inside a longer string.
  assert.equal(evidence.response.body.message, `saw ${R} here`);
  for (const file of readdirSync(dir)) assert.ok(!readFileSync(join(dir, file), 'utf8').includes(note), file);
  assert.ok(!readFileSync(f.env.API_USAGE_LOG, 'utf8').includes(note));
  assert.ok(!JSON.stringify(result).includes(note));
  assert.ok(!readFileSync(f.env.API_USAGE_LOG, 'utf8').includes(`127.0.0.${R}`));
  assert.ok(!JSON.stringify(result).includes(`${R}27.0.0`));
  // The stored request body, and the usage row: a path segment the usage log
  // keeps (it templates digits, not "Q7") is removed as a whole value.
  const posted = await scrubRun(f, { size: 'M' }, { ref: f.labelRef, env: { FIXTURE_PIN: 'long-pin-value' } });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${posted.evidence}.json`), 'utf8')).request.body, { size: R });
  const named = await scrubRun(f, { orderId: 'Q7', ref: 'M', size: 'M', note });
  assert.equal(f.seen.at(-1), '/v1/orders/Q7/quote?ref=M');
  const rows = readFileSync(f.env.API_USAGE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const row = rows.find(r => r.runId === named.evidence);
  assert.equal(row.path, `/v1/orders/${R}/quote`);
  assert.equal(row.method, 'GET');
  // A typed value equal to the method leaves the row's method, and the run
  // record's, as the client wrote them.
  const method = await scrubRun(f, { orderId: 'Q8', ref: 'M', size: 'GET', note });
  const methodRow = readFileSync(f.env.API_USAGE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(r => r.runId === method.evidence);
  assert.equal(methodRow.method, 'GET');
  assert.equal(JSON.parse(readFileSync(join(dir, `${method.evidence}.json`), 'utf8')).request.method, 'GET');
  assert.equal(JSON.parse(readFileSync(join(dir, `${method.evidence}.json`), 'utf8')).request.headers['x-size'], R);
});

test('an input value never alters the usage row\'s client-written fields; the row\'s path stays scrubbed; a credential still does', () => {
  const row = { ts: '2026-11-19T16:03:07.575Z', project: 'repo-1', origin: 'own', host: '127.0.0.1', method: 'GET', stack: 'fixture',
    path: '/v1/orders/Q7/quote', queryKeys: ['ref'], status: 200, ok: true, mode: 'passthrough', authUsed: 'bearer:ORDERS_TOKEN',
    environment: 'local', drift: ['pagination-loop'], knownOp: 'GET /orders/{orderId}/quote', friction: 'retry', runId: 'run-1', session_id: 'sess-1' };
  for (const input of ['GET', 'bearer', 'fixture', 'local', 'repo-1', 'retry', 'ORDERS_TOKEN', 'pagination-loop']) {
    // None of these occurs in knownOp except as part of a longer value.
    const out = scrubWith([input, 'Q7'], row, [], 'usage');
    assert.deepEqual({ ...out, path: row.path }, row, input);
    assert.equal(out.path, `/v1/orders/${R}/quote`, input);
  }
  assert.equal(scrubWith(['orders'], row, [], 'usage').knownOp, `GET /${R}/{orderId}/quote`);
  const credential = scrubWith(['GET'], row, ['GET', 'fixture', 'bearer'], 'usage');
  assert.equal(credential.method, R);
  assert.equal(credential.stack, R);
  assert.equal(credential.authUsed, `${R}:ORDERS_TOKEN`);
  assert.equal(credential.knownOp, `${R} /orders/{orderId}/quote`);
});

test('the usage row\'s URL- and API-derived fields, and fields not listed, stay scrubbed for inputs', () => {
  const row = { origin: 'own', host: '127.0.0.1', method: 'GET', path: '/v1/x', queryKeys: ['ref', 'page'], rateLimitRemaining: '59', futureField: 'zz' };
  assert.deepEqual(scrubWith(['ref'], row, [], 'usage').queryKeys, [R, 'page']);
  assert.equal(scrubWith(['127.0.0.1'], row, [], 'usage').host, R);
  assert.equal(scrubWith(['59'], row, [], 'usage').rateLimitRemaining, R);
  assert.equal(scrubWith(['zz'], row, [], 'usage').futureField, R);
  assert.equal(scrubWith(['GET'], row, [], 'usage').method, 'GET');
});

test('an environment-declared input scrubs everywhere except the fields the client writes about the request', () => {
  const origin = { observed_at: '2026-11-19T16:03:07.575Z', package_version: '0.1.0-beta.2', scope: { operation: 'GET /orders/{orderId}/quote' } };
  const record = { origin, request: { method: 'GET', url: 'http://127.0.0.1:4731/v1/GET/x', authUsed: 'bearer:ORDERS_TOKEN', headers: { 'x-a': 'xxGETxx bearer' } } };
  for (const input of ['GET', 'bearer', 'beta', '0.1.0', '16:03', 'orders']) {
    const out = scrubWithEnvironment([input], record, 'httpEvidence');
    assert.deepEqual(out.origin, origin, input);
    assert.equal(out.request.method, 'GET', input);
    assert.equal(out.request.authUsed, 'bearer:ORDERS_TOKEN', input);
  }
  // Elsewhere the same short values keep the full substring scrub.
  assert.equal(scrubWithEnvironment(['GET'], record, 'httpEvidence').request.headers['x-a'], `xx${R}xx bearer`);
  assert.equal(scrubWithEnvironment(['GET'], record, 'httpEvidence').request.url, `http://127.0.0.1:4731/v1/${R}/x`);
  const row = { origin: 'own', method: 'GET', authUsed: 'bearer:ORDERS_TOKEN', knownOp: 'GET /orders/{orderId}/quote', path: '/v1/own/GET' };
  const out = scrubWithEnvironment(['GET', 'own', 'bearer'], row, 'usage');
  assert.deepEqual({ ...out, path: row.path, knownOp: row.knownOp }, row);
  assert.equal(out.path, `/v1/${R}/${R}`);
  // knownOp can be the concrete request path, so it is scrubbed like the path.
  assert.equal(out.knownOp, `${R} /orders/{orderId}/quote`);
});

test('an input read from an environment variable keeps the full scrub at any length; the same value typed is removed only whole', async t => {
  const f = await scrubFixture(t), pin = '4412';
  const dir = join(f.root, LAYOUT.evidence, 'fixture');
  const fromEnv = await scrubRun(f, { size: 'M' }, { ref: f.labelRef, env: { FIXTURE_PIN: pin } });
  assert.equal(fromEnv.status, 200, JSON.stringify(fromEnv.error ?? null));
  const envEvidence = JSON.parse(readFileSync(join(dir, `${fromEnv.evidence}.json`), 'utf8'));
  assert.equal(envEvidence.response.body.message, `saw ${R} here`);
  assert.equal(fromEnv.data.message, `saw ${R} here`);
  assert.equal(envEvidence.request.headers['x-note'], R);
  assert.equal(envEvidence.request.method, 'POST');
  for (const file of readdirSync(dir)) assert.ok(!readFileSync(join(dir, file), 'utf8').includes(pin), file);
  assert.ok(!JSON.stringify(fromEnv).includes(pin));
  assert.ok(!readFileSync(f.env.API_USAGE_LOG, 'utf8').includes(pin));
  const typed = await scrubRun(f, { orderId: 'Q7', ref: 'M', size: 'M', note: pin });
  const typedEvidence = JSON.parse(readFileSync(join(dir, `${typed.evidence}.json`), 'utf8'));
  assert.equal(typedEvidence.request.headers['x-note'], R);
  assert.equal(typedEvidence.response.body.message, `saw ${pin} here`);
  assert.equal(typed.data.message, `saw ${pin} here`);
});

test('an input whose declaration names an environment source keeps the full scrub when the caller supplies the value, sensitive or not', async t => {
  const f = await scrubFixture(t), pin = '4412';
  const dir = join(f.root, LAYOUT.evidence, 'fixture');
  const { id: _id, ...copy } = showSavedRequestDocument(f.root, f.labelRef);
  const marked = saveSavedRequest(f.root, { ...copy, name: 'create-marked',
    inputs: { pin: { type: 'string', sensitive: true, source: { env: 'FIXTURE_PIN' } }, size: { type: 'string', sensitive: true } } });
  for (const [ref, label] of [[f.labelRef, 'sensitive omitted'], [marked.ref, 'sensitive: true']]) {
    const result = await scrubRun(f, { pin, size: 'M' }, { ref });
    assert.equal(result.status, 200, label);
    assert.equal(f.seen.length > 0 && f.seen.at(-1), '/v1/labels', label);
    const evidence = JSON.parse(readFileSync(join(dir, `${result.evidence}.json`), 'utf8'));
    assert.equal(evidence.request.headers['x-note'], R, label);
    assert.equal(evidence.response.body.message, `saw ${R} here`, label);
    assert.equal(result.data.message, `saw ${R} here`, label);
    assert.ok(!JSON.stringify(result).includes(pin), label);
    for (const file of readdirSync(dir)) assert.ok(!readFileSync(join(dir, file), 'utf8').includes(pin), `${label}: ${file}`);
    assert.ok(!readFileSync(f.env.API_USAGE_LOG, 'utf8').includes(pin), label);
  }
});

test('the usage row\'s knownOp is scrubbed for inputs like the path, through a real run', async t => {
  const f = await scrubFixture(t);
  const rows = () => readFileSync(f.env.API_USAGE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  // Accepted by ruling: a typed value equal to a word of the template alters it.
  const typed = await scrubRun(f, { orderId: 'Q7', ref: 'M', size: 'orders', note: 'private-note-4412' });
  assert.equal(rows().find(r => r.runId === typed.evidence).knownOp, `GET /${R}/{orderId}/quote`);
  const fromEnv = await scrubRun(f, { size: 'M' }, { ref: f.labelRef, env: { FIXTURE_PIN: 'POST' } });
  assert.equal(fromEnv.status, 200);
  assert.equal(rows().find(r => r.runId === fromEnv.evidence).knownOp, `${R} /labels`);
  // A short typed value that only stands inside the template leaves it.
  const short = await scrubRun(f, { orderId: 'Q8', ref: 'M', size: 'GET', note: 'private-note-4412' });
  assert.equal(rows().find(r => r.runId === short.evidence).knownOp, 'GET /orders/{orderId}/quote');
});

test('the usage row\'s origin is a fixed word the client writes; a typed value equal to it leaves it', async t => {
  const f = await scrubFixture(t);
  const result = await scrubRun(f, { orderId: 'Q7', ref: 'M', size: 'M', note: 'own' });
  const row = readFileSync(f.env.API_USAGE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(r => r.runId === result.evidence);
  assert.equal(row.origin, 'own');
  assert.equal(JSON.parse(readFileSync(join(f.root, LAYOUT.evidence, 'fixture', `${result.evidence}.json`), 'utf8')).request.headers['x-note'], R);
});

// Review of PR 25, condition 1. With no contract the operation the client
// matched is the method and the concrete path, and an unusable file in
// .sannr/requests makes the saved-request context attach to it as known.op.
// The usage row's knownOp must then be scrubbed like everything else.
test('on a stack with no contract, a private path value never reaches the usage row, a stored file or the receipt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'no-contract-scrub-')), seen = [];
  const server = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { id: 7 } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const home = join(root, 'home'), state = join(root, 'machine');
  mkdirSync(home, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: state, API_CONTEXT_DIR: root, API_BUDGET: '6000', API_FRICTION_OFF: '1', NO_COLOR: '1' };
  const cli = args => spawnSync(process.execPath, [new URL('../bin/cli.mjs', import.meta.url).pathname, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  const added = cli(['stack', 'add', 'nocon', '--base-url', `http://127.0.0.1:${server.address().port}`]);
  assert.equal(added.status, 0, added.stderr + added.stdout);
  const fact = cli(['note', '--stack', 'nocon', '--scope', 'stack', 'Documented: the bot API answers ok true on success.']);
  assert.equal(fact.status, 0, fact.stderr + fact.stdout);
  const saved = saveSavedRequest(root, { kind: 'saved-request', format_version: 1, folder: 'nocon', name: 'getme', stack: 'nocon', environment: JSON.parse(readFileSync(join(root, LAYOUT.collection, 'nocon', 'stack.json'), 'utf8')).default_environment,
    request: { method: 'GET', path: '/bot/{token}/getMe', bindings: { path: { token: { $input: 'path_token' } }, headers: { 'x-pin': { $input: 'pin' } } } },
    inputs: { path_token: { type: 'string', sensitive: true }, pin: { type: 'string', source: { env: 'BOT_PIN' } } }, credentials: [] });
  writeFileSync(join(root, LAYOUT.requests, 'nocon', 'damaged.json'), '{ not json');
  const token = 'pathsecret-Zq5a-long', pin = 'Kx7Q';
  assert.equal(token.length, 20);
  const script = `const api=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await api.runSavedRequest(process.cwd(), ${JSON.stringify(saved.ref)}, { inputs: { path_token: ${JSON.stringify(token)} }, initiator: 'cli.saved' })));`;
  // Asynchronous, so this process's loopback server can answer.
  const run = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: { ...env, BOT_PIN: pin }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', reject); child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, 200, run.stdout);
  assert.deepEqual(seen, [`/bot/${token}/getMe`]);
  assert.ok(!run.stdout.includes(token) && !run.stdout.includes(pin));
  const files = [];
  const walk = dir => { for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile()) files.push(path); } };
  walk(state); walk(home); walk(join(root, '.sannr'));
  assert.ok(files.some(file => file.endsWith('usage.jsonl')), 'the usage log was written');
  const row = readFileSync(files.find(file => file.endsWith('usage.jsonl')), 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(r => r.runId === result.evidence);
  assert.ok(row.knownNotes > 0, 'a stack fact was delivered on the row');
  for (const file of files) for (const value of [token, pin]) assert.ok(!readFileSync(file, 'utf8').includes(value), `${file} holds a private value`);
  const human = cli(['receipt']), machine = cli(['receipt', '--json']);
  assert.equal(machine.status, 0, machine.stderr);
  assert.ok(JSON.parse(machine.stdout).gotchas.operations.length > 0, 'the receipt lists the operation');
  for (const output of [human.stdout, human.stderr, machine.stdout, machine.stderr]) for (const value of [token, pin]) assert.ok(!output.includes(value), 'the receipt prints a private value');
});

// A short private input is removed from a URL or absolute path that sits
// inside a longer string (an operation name, a receipt line, a message), as it
// is when the whole string is a URL or a path. Everything else in the string
// is kept byte for byte.
test('a short private input is removed from a URL or absolute path inside a longer string', () => {
  const text = (inputs, value) => withPrivateRequestInputs(inputs, () => scrubForTest(value, []));
  // An operation name: the method word, then the concrete path.
  assert.equal(scrubWith(['7'], { knownOp: 'GET /bot/7/getMe' }, [], 'usage').knownOp, `GET /bot/${R}/getMe`);
  assert.equal(scrubWith(['7'], { ok: true, known: { op: 'GET /bot/7/getMe' } }, [], 'envelope').known.op, `GET /bot/${R}/getMe`);
  assert.equal(text(['7'], 'GET /bot/7/getMe'), `GET /bot/${R}/getMe`);
  // A receipt or view line: trailing punctuation is not part of the last segment.
  assert.deepEqual(scrubWith(['Kx3vP'], { line: 'GET /bot/Kx3vP/getMe: 2 notes delivered in 2 calls.' }),
    { line: `GET /bot/${R}/getMe: 2 notes delivered in 2 calls.` });
  // A message embedding a URL keeps its scheme, host and port.
  assert.deepEqual(scrubWith(['7'], { message: 'The request to http://127.0.0.1:47980/bot/7/getMe failed.' }),
    { message: `The request to http://127.0.0.1:47980/bot/${R}/getMe failed.` });
  // Quoted and bracketed paths, and trailing punctuation.
  const quoted = scrubWith(['7'], {
    command: 'Do this now: sannr note "GET /bot/7/getMe" "<one sentence>"',
    single: "see '/bot/7' and `/bot/7`", brackets: '[GET /bot/7/getMe] (/bot/7) </bot/7>; {/bot/7}',
    drift: 'Redirect returned to /bot/7, which was already visited.', ends: 'at /bot/7. at /bot/7; at /bot/7: at /bot/7! at /bot/7),',
  });
  assert.deepEqual(quoted, {
    command: `Do this now: sannr note "GET /bot/${R}/getMe" "<one sentence>"`,
    single: `see '/bot/${R}' and \`/bot/${R}\``, brackets: `[GET /bot/${R}/getMe] (/bot/${R}) </bot/${R}>; {/bot/${R}}`,
    drift: `Redirect returned to /bot/${R}, which was already visited.`, ends: `at /bot/${R}. at /bot/${R}; at /bot/${R}: at /bot/${R}! at /bot/${R}),`,
  });
  // Whole query values, as written and URL-decoded; the fragment is kept as in a whole URL.
  assert.deepEqual(scrubWith(['7', 'a b'], { a: 'GET /orders?id=7&page=10 failed', b: 'GET /orders/7?ref=a%20b, then', c: 'saw http://h.test/x?q=7#7 twice' }),
    { a: `GET /orders?id=${R}&page=10 failed`, b: `GET /orders/${R}?ref=${R}, then`, c: `saw http://h.test/x?q=${R}#7 twice` });
  // Whitespace and the text around the path are kept byte for byte.
  assert.equal(text(['7'], 'x  GET\t/bot/7/getMe\n2 calls, 7 notes.'), `x  GET\t/bot/${R}/getMe\n2 calls, 7 notes.`);
});

test('a short private input is not removed from dates, hosts, ports, words or templates inside a longer string', () => {
  const kept = (inputs, value, structure) => assert.deepEqual(scrubWith(inputs, value, [], structure), value, inputs.join());
  // Dates.
  kept(['19', 'Nov', '2026', '02', '1'], { d: 'Thu, 19 Nov 2026 02:46:59 GMT', m: 'sent Thu, 19 Nov 2026 02:46:59 GMT to /v1/x', iso: 'at 2026-11-19T02:46:59.000Z', us: 'on 11/19/2026' });
  // Hosts and ports, alone and inside a URL in a message.
  kept(['1', '127', '0', '4730', '47980'], { a: 'connect to 127.0.0.1:4730 refused', b: 'The request to http://127.0.0.1:4730/v1/x failed.',
    c: 'GET http://127.0.0.1:47980', d: 'host 127.0.0.1:4730/v1' });
  // A word or a segment that contains the value without being it.
  kept(['1', '7'], { a: 'GET /orders/a1b/x17', b: 'order 1 at /orders/11/x', c: 'and/or 7/8 a/7/b', d: 'GET /bot/7x/getMe: 17 notes' });
  // A template whose segments contain the value as a substring.
  kept(['der', 'Id', 'quot', 'rId}'], { knownOp: 'GET /orders/{orderId}/quote', line: 'GET /orders/{orderId}/quote: 2 notes delivered in 2 calls.' }, 'usage');
  // What the client writes about the request itself is never altered by an input.
  const record = { origin: { scope: { operation: 'GET /bot/7/getMe' } }, request: { method: 'GET', url: 'http://127.0.0.1:4731/bot/7/getMe' } };
  const out = scrubWith(['7'], record, [], 'httpEvidence');
  assert.deepEqual(out.origin, record.origin);
  assert.equal(out.request.url, `http://127.0.0.1:4731/bot/${R}/getMe`);
});
