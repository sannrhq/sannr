// Anonymous usage counts: one small document a day, on unless turned off,
// never before the person has been told. docs/telemetry.md is the human page;
// lib/usage.schema.json is the whole contract with the receiving endpoint.
//
// What this module is allowed to know: fixed feature names written in this
// file, a count per name, a count of executed API requests, the package
// version, the platform family, the Node major version and a random install
// identifier. It never receives a path, an argument, a host, a header or any
// text a person typed, so it cannot leak one.
//
// Three rules shape the code:
//  1. Nothing here may break, slow or change a command. Every entry point is
//     synchronous, bounded local file work wrapped in try/catch; the network
//     send happens in a detached child process (lib/telemetry-send.mjs) that
//     the command never waits for.
//  2. The off switches win before any file is touched: an environment switch
//     or a CI environment means no state is read or written at all.
//  3. A state file that cannot be read or written means nothing is counted,
//     nothing is sent and no notice is shown; `telemetry status` says why.
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_NAME, PRODUCT, PROSE_PRODUCT_TITLE, TELEMETRY_ENV_NAME, USAGE_URL } from './brand.mjs';
import { machineStatePaths } from './machine-state.mjs';
import { safeOutputPath, writeOutputFile, writeOutputFileAtomic } from './output-path.mjs';

export const TELEMETRY_STATE_BASENAME = 'telemetry.json';
export const TELEMETRY_DIRECTORY = 'telemetry';
const COUNTS = 'counts.jsonl', BATCH = 'batch.json', LOCK = '.send.lock', SENT = 'sent';
const DAY_MS = 86_400_000;
export const TELEMETRY_LIMITS = Object.freeze({
  noticeWaitMs: DAY_MS, attemptsPerDay: 3, receiptsKept: 30, timeoutMs: 5_000, lockStaleMs: 60_000,
  featureMax: 10_000, apiCallsMax: 1_000_000, featuresMax: 64, bytesMax: 2_048,
});
const L = TELEMETRY_LIMITS;
const FEATURE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
export const CI_VARIABLES = Object.freeze(['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION']);
const OFF_VALUES = new Set(['0', 'off', 'false', 'no']);
const SENDER = fileURLToPath(new URL('./telemetry-send.mjs', import.meta.url));

let packageVersionCache;
function packageVersion() {
  if (packageVersionCache !== undefined) return packageVersionCache;
  try { packageVersionCache = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { packageVersionCache = null; }
  return packageVersionCache;
}

// --- the fixed feature names -------------------------------------------------

// One name per top-level command. Where the subcommand is the feature, it is
// folded in (suite_run, saved_run). A subcommand not listed here counts as its
// command; a command not listed here is not counted. Names come only from this
// table, never from what was typed.
const CLI_COMMANDS = Object.freeze({
  workbench: [], saved: ['draft', 'list', 'show', 'create', 'edit', 'run', 'rename', 'delete', 'reopen', 'inspect'],
  migrate: [], audit: [], map: ['reconcile'], graph: ['export', 'record', 'context', 'impact', 'stats'],
  survey: ['generate', 'status', 'query', 'render'], view: [], sessions: [], connect: [], repos: [], grant: [],
  revoke: [], stack: ['add', 'move'], stacks: [], init: [], learn: [], doctor: [], capabilities: [], show: [],
  note: [], verdict: [], import: [], postman: ['capture'], request: [], protocol: [],
  context: ['capture', 'query', 'migrate', 'keys'], suite: ['save', 'run', 'list'], verify: [], receipt: [],
  feedback: [], review: [], prune: [], unwire: [], start: [], mcp: ['inspect'],
});
const CLI_ALIASES = Object.freeze({ status: 'doctor', check: 'doctor', health: 'doctor', ping: 'doctor', disconnect: 'unwire',
  '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help', help: 'help' });
const VALUE_FLAGS = new Set(['--env', '--stack']);

/** The fixed feature name for one CLI invocation, or null when it has none.
 *  The telemetry command itself is never counted. */
export function cliFeature(argv) {
  const first = argv[0];
  if (first === undefined) return 'help';
  if (first === 'telemetry') return null;
  if (Object.hasOwn(CLI_ALIASES, first)) return CLI_ALIASES[first];
  if (!Object.hasOwn(CLI_COMMANDS, first)) return null;
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  const subs = CLI_COMMANDS[first];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (VALUE_FLAGS.has(token)) { i++; continue; }
    if (token.startsWith('-')) continue;
    return subs.includes(token) ? `${first}_${token}` : first;
  }
  return first;
}

/** The fixed feature name for one MCP tool call, or null for a name the
 *  server does not declare. */
export function mcpFeature(tool, declared) {
  if (typeof tool !== 'string' || !declared.includes(tool)) return null;
  const name = `mcp_${tool.replaceAll('-', '_')}`;
  return FEATURE_NAME.test(name) ? name : null;
}

// --- switches, paths and state -------------------------------------------------

/** The environment switch that turns telemetry off for this process, or null. */
export function environmentSwitch(env = process.env) {
  const own = env[TELEMETRY_ENV_NAME];
  if (typeof own === 'string' && OFF_VALUES.has(own.trim().toLowerCase())) return { source: 'environment', variable: TELEMETRY_ENV_NAME };
  if (env.DO_NOT_TRACK === '1') return { source: 'environment', variable: 'DO_NOT_TRACK' };
  if (typeof env.CI === 'string' && env.CI !== '' && !['0', 'false'].includes(env.CI.trim().toLowerCase())) return { source: 'ci', variable: 'CI' };
  for (const name of CI_VARIABLES) if (typeof env[name] === 'string' && env[name] !== '') return { source: 'ci', variable: name };
  return null;
}

export function telemetryPaths(env = process.env) {
  const { directory } = machineStatePaths({ env });
  const folder = join(directory, TELEMETRY_DIRECTORY);
  return { directory, state: join(directory, TELEMETRY_STATE_BASENAME), folder,
    counts: join(folder, COUNTS), batch: join(folder, BATCH), lock: join(folder, LOCK), sent: join(folder, SENT) };
}

const isDate = value => typeof value === 'string' && DATE.test(value);
const isTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validState(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.v === 1
    && ['on', 'off'].includes(value.state) && ['default', 'command'].includes(value.set_by)
    && (value.noticed_at === null || isTime(value.noticed_at))
    && (value.install === null || typeof value.install === 'string' && UUID_V4.test(value.install))
    && (value.last_sent === null || isDate(value.last_sent))
    && (value.attempt_day === null || isDate(value.attempt_day))
    && Number.isSafeInteger(value.attempts) && value.attempts >= 0;
}

/** { kind: 'untold' } | { kind: 'state', state } | { kind: 'broken', problem } */
export function readState(paths) {
  let bytes;
  try {
    if (!lstatSync(paths.directory).isDirectory())
      return { kind: 'broken', problem: { code: 'TELEMETRY_STATE_DIRECTORY_INVALID', message: 'The machine state directory is not a directory.' } };
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'untold' };
    return { kind: 'broken', problem: { code: 'TELEMETRY_STATE_UNREADABLE', message: 'The machine state directory cannot be read.' } };
  }
  try {
    safeOutputPath(paths.state);
    bytes = readFileSync(paths.state, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'untold' };
    return { kind: 'broken', problem: { code: 'TELEMETRY_STATE_UNREADABLE', message: 'The telemetry state file cannot be read safely.' } };
  }
  let value;
  try { value = JSON.parse(bytes); } catch { value = null; }
  if (!validState(value)) return { kind: 'broken', problem: { code: 'TELEMETRY_STATE_INVALID', message: 'The telemetry state file is damaged.' } };
  return { kind: 'state', state: value };
}

function privateDirectory(path) {
  safeOutputPath(path, { directory: true });
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeState(paths, state) {
  privateDirectory(paths.directory);
  writeOutputFileAtomic(paths.state, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

const freshState = (fields = {}) => ({ v: 1, state: 'on', set_by: 'default', noticed_at: null, install: null,
  last_sent: null, attempt_day: null, attempts: 0, ...fields });
const utcDay = now => new Date(now).toISOString().slice(0, 10);

// --- the notice ----------------------------------------------------------------

/** The notice, one paragraph. Its wording is the product's promise; keep it
 *  plain and keep every element docs/telemetry.md lists. */
export function noticeText() {
  const host = new URL(USAGE_URL).host;
  return `${PROSE_PRODUCT_TITLE} telemetry: ${PROSE_PRODUCT_TITLE} sends anonymous usage counts to ${host} once a day: `
    + `a random install ID, the ${PROSE_PRODUCT_TITLE} version, the operating system (with processor type and Node.js major version), `
    + `how many times each ${PROSE_PRODUCT_TITLE} command ran, and how many API calls went through it. `
    + `Nothing about your repositories, APIs or requests is sent. It is on unless you turn it off: run \`${CLI_NAME} telemetry off\`, `
    + `or tell your agent "opt out". \`${CLI_NAME} telemetry show\` prints exactly what is sent. `
    + `Nothing has been sent yet; the first send is no earlier than 24 hours from now.`;
}

// Record that the notice was emitted. Returns true only when the record was
// written: a machine that cannot keep the record is never shown the notice,
// never counted and never sends.
function recordNotice(paths, now) {
  const current = readState(paths);
  if (current.kind !== 'untold') return false;
  try { writeState(paths, freshState({ noticed_at: new Date(now).toISOString() })); return true; }
  catch { return false; }
}

// --- counting --------------------------------------------------------------------

function active(paths, env) {
  if (environmentSwitch(env)) return null;
  const current = readState(paths);
  return current.kind === 'state' && current.state.state === 'on' && current.state.noticed_at ? current.state : null;
}

function appendCount(paths, line) {
  privateDirectory(paths.folder);
  writeOutputFile(paths.counts, `${line}\n`, { append: true, mode: 0o600 });
}

/** Count one run of a fixed feature name. Never throws. */
export function recordFeature(name, { env = process.env } = {}) {
  try {
    if (!FEATURE_NAME.test(name ?? '')) return;
    const paths = telemetryPaths(env);
    if (active(paths, env)) appendCount(paths, JSON.stringify({ f: name }));
  } catch { /* counting never affects a command */ }
}

/** Count one executed API request. Called where the client appends its usage
 *  row, but kept apart from that log, which a person may redirect. Never throws. */
export function recordApiCall({ env = process.env } = {}) {
  try {
    const paths = telemetryPaths(env);
    if (active(paths, env)) appendCount(paths, '{"a":1}');
  } catch { /* counting never affects a request */ }
}

const emptyCounts = () => ({ features: {}, api_calls: 0 });
function addCounts(into, line) {
  let row;
  try { row = JSON.parse(line); } catch { return; }
  if (!row || typeof row !== 'object') return;
  if (typeof row.f === 'string' && FEATURE_NAME.test(row.f))
    into.features[row.f] = Math.min(L.featureMax, (Object.hasOwn(into.features, row.f) ? into.features[row.f] : 0) + 1);
  if (row.a === 1) into.api_calls = Math.min(L.apiCallsMax, into.api_calls + 1);
}
function readBatch(paths) {
  try {
    safeOutputPath(paths.batch);
    const value = JSON.parse(readFileSync(paths.batch, 'utf8'));
    const out = emptyCounts();
    if (Number.isSafeInteger(value?.api_calls) && value.api_calls > 0) out.api_calls = Math.min(L.apiCallsMax, value.api_calls);
    for (const [name, count] of Object.entries(value?.features ?? {}))
      if (FEATURE_NAME.test(name) && Number.isSafeInteger(count) && count > 0) out.features[name] = Math.min(L.featureMax, count);
    return out;
  } catch { return emptyCounts(); }
}
function journalFiles(paths) {
  let names = [];
  try { safeOutputPath(paths.folder, { directory: true }); names = readdirSync(paths.folder); } catch { return []; }
  return names.filter(name => name === COUNTS || /^counts\.fold-[0-9a-f-]+\.jsonl$/.test(name)).sort().map(name => join(paths.folder, name));
}
function sumJournal(into, file) {
  try {
    safeOutputPath(file);
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line) addCounts(into, line);
  } catch { /* an unreadable journal contributes nothing */ }
}

/** Unsent counts as they stand, without changing anything. */
function peekCounts(paths) {
  const counts = readBatch(paths);
  for (const file of journalFiles(paths)) sumJournal(counts, file);
  return counts;
}

/** Move every journal into the batch. Runs only under the send lock. */
function foldCounts(paths) {
  const counts = readBatch(paths);
  const folding = [];
  for (const file of journalFiles(paths)) {
    if (file === paths.counts) {
      const target = join(paths.folder, `counts.fold-${process.pid}-${randomBytes(4).toString('hex')}.jsonl`);
      try { renameSync(file, target); folding.push(target); } catch { /* appended concurrently or gone */ }
    } else folding.push(file);
  }
  for (const file of folding) sumJournal(counts, file);
  writeOutputFileAtomic(paths.batch, `${JSON.stringify(counts)}\n`, { mode: 0o600 });
  for (const file of folding) rmSync(file, { force: true });
  return counts;
}

// --- the document ------------------------------------------------------------------

const osFamily = () => ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'other';
const archFamily = () => ['arm64', 'x64'].includes(process.arch) ? process.arch : 'other';
const nodeMajor = () => Number(process.versions.node.split('.')[0]);

/** The document for these counts. Features beyond 64 or the 2,048-byte bound
 *  stay unsent (largest counts go first) and wait for the next document. */
export function buildDocument({ install, since, counts }) {
  const version = packageVersion();
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  const node = nodeMajor();
  if (!(node >= 18 && node <= 99)) return null;
  const ordered = Object.entries(counts.features).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const chosen = {};
  const render = features => JSON.stringify({ v: 1, install, version, os: osFamily(), arch: archFamily(), node, since,
    features: Object.fromEntries(Object.entries(features).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    api_calls: Math.min(L.apiCallsMax, counts.api_calls) });
  for (const [name, count] of ordered) {
    if (Object.keys(chosen).length >= L.featuresMax) break;
    const next = { ...chosen, [name]: Math.min(L.featureMax, count) };
    if (Buffer.byteLength(render(next)) > L.bytesMax) continue;
    chosen[name] = next[name];
  }
  const body = render(chosen);
  return { body, document: JSON.parse(body) };
}

function dueReason(state, now) {
  if (state.state !== 'on') return 'off';
  if (!state.noticed_at) return 'notice_pending';
  if (Date.parse(state.noticed_at) + L.noticeWaitMs > now) return 'notice_too_recent';
  const today = utcDay(now);
  if (state.last_sent === today) return 'sent_today';
  if (state.attempt_day === today && state.attempts >= L.attemptsPerDay) return 'attempts_exhausted';
  return null;
}

// --- the send lock ---------------------------------------------------------------

function acquireLock(paths, now) {
  privateDirectory(paths.folder);
  safeOutputPath(paths.lock, { directory: true });
  try { mkdirSync(paths.lock, { mode: 0o700 }); return true; }
  catch (error) {
    if (error.code !== 'EEXIST') return false;
    try {
      const observed = lstatSync(paths.lock);
      if (!observed.isDirectory() || now - observed.mtimeMs < L.lockStaleMs) return false;
      // A sender that crashed leaves its lock; reclaim it only if it is still
      // the same directory this check examined.
      const current = lstatSync(paths.lock);
      if (current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs) return false;
      rmSync(paths.lock, { recursive: true, force: true });
      mkdirSync(paths.lock, { mode: 0o700 });
      return true;
    } catch { return false; }
  }
}
export function releaseLock(paths) {
  try { rmSync(paths.lock, { recursive: true, force: true }); } catch { /* a stale lock expires */ }
}

function pruneReceipts(paths) {
  try {
    const names = readdirSync(paths.sent).filter(name => name.endsWith('.json')).sort();
    for (const name of names.slice(0, Math.max(0, names.length - L.receiptsKept))) rmSync(join(paths.sent, name), { force: true });
  } catch { /* pruning is best effort */ }
}

function senderEnvironment(env) {
  // The destination is fixed: no proxy variable may redirect it.
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(https?|all|no)_proxy$/i.test(key) || key === 'NODE_USE_ENV_PROXY') continue;
    out[key] = key === 'NODE_OPTIONS' ? value.split(/\s+/).filter(token => token !== '--use-env-proxy').join(' ') : value;
  }
  return out;
}

/** When a document is due, prepare it (counts folded, receipt written, the
 *  attempt recorded) and hand it to a detached sender. Never waits, never throws. */
export function maybeSend({ env = process.env, now = Date.now() } = {}) {
  let paths, locked = false;
  try {
    paths = telemetryPaths(env);
    const state = active(paths, env);
    if (!state || dueReason(state, now)) return false;
    if (!acquireLock(paths, now)) return false;
    locked = true;
    // Recheck under the lock: another process may have sent meanwhile.
    const current = active(paths, env);
    if (!current || dueReason(current, now)) return false;
    const today = utcDay(now);
    const next = { ...current, install: current.install ?? randomUUID(),
      attempt_day: today, attempts: current.attempt_day === today ? current.attempts + 1 : 1 };
    const counts = foldCounts(paths);
    const built = buildDocument({ install: next.install, since: next.last_sent, counts });
    if (!built) return false;
    writeState(paths, next);
    privateDirectory(paths.sent);
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const receipt = join(paths.sent, `${stamp}-${randomBytes(4).toString('hex')}.json`);
    writeOutputFileAtomic(receipt, built.body, { mode: 0o600 });
    pruneReceipts(paths);
    const child = spawn(process.execPath, [SENDER, receipt], { detached: true, stdio: 'ignore', windowsHide: true, env: senderEnvironment(env) });
    child.on('error', () => releaseLock(paths));
    child.unref();
    locked = false; // the sender owns the lock now
    return true;
  } catch { return false; }
  finally { if (locked) releaseLock(paths); }
}

/** The detached sender's work: POST the receipt's exact bytes once. Counts are
 *  cleared only on a 2xx answer. */
export async function deliver(receipt, { env = process.env } = {}) {
  const paths = telemetryPaths(env);
  try {
    const state = active(paths, env);
    if (!state || !state.install) return;
    safeOutputPath(receipt);
    const bytes = readFileSync(receipt);
    const sentDocument = JSON.parse(bytes.toString('utf8'));
    if (sentDocument.install !== state.install) return;
    let ok = false;
    // A referenced timer: an unanswered request must end by the deadline even
    // when nothing else keeps this process alive.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), L.timeoutMs);
    try {
      const response = await fetch(USAGE_URL, { method: 'POST', body: bytes, redirect: 'manual', credentials: 'omit',
        headers: { 'content-type': 'application/json', 'user-agent': `${PRODUCT}/${packageVersion()}` },
        signal: controller.signal });
      ok = response.status >= 200 && response.status < 300;
      try { await response.body?.cancel(); } catch { /* nothing to read */ }
    } catch { ok = false; }
    finally { clearTimeout(timer); }
    if (!ok) return;
    // A person may have turned it off or reset it while the request was out.
    const after = active(paths, env);
    if (!after || after.install !== sentDocument.install) return;
    const batch = readBatch(paths);
    for (const name of Object.keys(sentDocument.features ?? {})) delete batch.features[name];
    batch.api_calls = 0;
    writeOutputFileAtomic(paths.batch, `${JSON.stringify(batch)}\n`, { mode: 0o600 });
    writeState(paths, { ...after, last_sent: utcDay(Date.now()) });
  } catch { /* the sender has no one to report to */ }
  finally { releaseLock(paths); }
}

// --- the entry points --------------------------------------------------------------

function writeNotice(text) {
  try { writeSync(2, `${text}\n`); } catch { /* stderr may be closed */ }
}

/** Called once at the start of every CLI invocation, before anything prints.
 *  Synchronous and bounded; never throws. `connect` emits its notice in its
 *  own output instead (takeConnectNotice). */
export function cliStart(argv, { env = process.env, now = Date.now() } = {}) {
  try {
    if (argv[0] === 'telemetry' || environmentSwitch(env)) return;
    const paths = telemetryPaths(env);
    const feature = cliFeature(argv);
    const current = readState(paths);
    if (current.kind === 'untold') {
      if (argv[0] === 'connect') return;
      if (!recordNotice(paths, now)) return;
      writeNotice(noticeText());
    } else if (current.kind !== 'state' || current.state.state !== 'on') return;
    // A due document carries the counts up to now; this run joins the next one,
    // so `telemetry show` immediately before a command shows what it sends.
    maybeSend({ env, now });
    if (feature) recordFeature(feature, { env });
  } catch { /* telemetry never affects a command */ }
}

/** For connect: the notice text when this is the moment it is first emitted on
 *  this machine (it is then recorded), otherwise null. Never throws. */
export function takeConnectNotice({ env = process.env, now = Date.now() } = {}) {
  try {
    if (environmentSwitch(env)) return null;
    const paths = telemetryPaths(env);
    if (!recordNotice(paths, now)) return null;
    recordFeature('connect', { env });
    return noticeText();
  } catch { return null; }
}

let mcpNoticeSettled = false;
/** Count one MCP tool call and start a due send in the background. */
export function mcpToolCall(tool, declared, { env = process.env, now = Date.now() } = {}) {
  try {
    if (environmentSwitch(env)) return;
    maybeSend({ env, now });
    recordFeature(mcpFeature(tool, declared), { env });
  } catch { /* never affects a tool call */ }
}
/** The notice for the first tool result on this machine, recorded as emitted
 *  when returned; null otherwise. Never throws. */
export function takeMcpNotice({ env = process.env, now = Date.now() } = {}) {
  if (mcpNoticeSettled) return null;
  try {
    if (environmentSwitch(env)) { mcpNoticeSettled = true; return null; }
    const paths = telemetryPaths(env);
    const current = readState(paths);
    if (current.kind !== 'untold') { if (current.kind === 'state') mcpNoticeSettled = true; return null; }
    if (!recordNotice(paths, now)) return null;
    mcpNoticeSettled = true;
    return noticeText();
  } catch { return null; }
}

// --- the telemetry command -------------------------------------------------------------

function stateProblem(paths) {
  try {
    const stat = statSync(paths.directory);
    if (!stat.isDirectory()) return { code: 'TELEMETRY_STATE_DIRECTORY_INVALID', message: 'The machine state directory is not a directory.' };
    accessSync(paths.directory, constants.W_OK);
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      for (let parent = dirname(paths.directory); ; parent = dirname(parent)) {
        try { accessSync(parent, constants.W_OK); return null; }
        catch (inner) {
          if (inner.code !== 'ENOENT') return { code: 'TELEMETRY_STATE_UNWRITABLE', message: 'The machine state directory cannot be created.' };
        }
        if (dirname(parent) === parent) return null;
      }
    }
    if (error.code === 'ENOTDIR') return { code: 'TELEMETRY_STATE_DIRECTORY_INVALID', message: 'The machine state directory is not a directory.' };
    return { code: 'TELEMETRY_STATE_UNWRITABLE', message: 'The machine state directory is not writable.' };
  }
}

function lastReceipt(paths) {
  try {
    safeOutputPath(paths.sent, { directory: true });
    const names = readdirSync(paths.sent).filter(name => name.endsWith('.json')).sort();
    if (!names.length) return null;
    const path = join(paths.sent, names.at(-1));
    safeOutputPath(path);
    return { path, body: readFileSync(path, 'utf8') };
  } catch { return null; }
}

export function telemetryStatus({ env = process.env, now = Date.now() } = {}) {
  const paths = telemetryPaths(env);
  const current = readState(paths);
  const switched = environmentSwitch(env);
  const problem = current.kind === 'broken' ? current.problem : stateProblem(paths);
  const state = current.kind === 'state' ? current.state : null;
  let status, reason;
  if (switched) { status = 'off'; reason = switched; }
  else if (current.kind === 'broken') { status = 'unavailable'; reason = { source: 'state_problem' }; }
  else if (current.kind === 'untold') { status = problem ? 'unavailable' : 'not_told'; reason = { source: problem ? 'state_problem' : 'default' }; }
  else { status = state.state; reason = { source: state.set_by }; }
  const due = state && !switched ? dueReason(state, now) : null;
  const nextAfter = state?.noticed_at && status === 'on'
    ? new Date(Math.max(Date.parse(state.noticed_at) + L.noticeWaitMs,
      state.last_sent === utcDay(now) || due === 'attempts_exhausted' ? Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY_MS : now)).toISOString()
    : null;
  return {
    state: status, reason, sending: status === 'on' && Boolean(state?.noticed_at),
    machine_state: current.kind === 'state' ? state.state : current.kind === 'untold' ? 'not_told' : 'unreadable',
    notice_emitted_at: state?.noticed_at ?? null, next_send_after: nextAfter, last_sent: state?.last_sent ?? null,
    attempts_today: state?.attempt_day === utcDay(now) ? state.attempts : 0,
    install: state?.install ? 'present' : 'absent',
    destination: USAGE_URL, state_file: paths.state, state_directory: paths.folder,
    problem: problem ?? null,
  };
}

export function telemetryShow({ env = process.env, now = Date.now() } = {}) {
  const paths = telemetryPaths(env);
  const status = telemetryStatus({ env, now });
  const current = readState(paths);
  const state = current.kind === 'state' ? current.state : null;
  const counts = status.state === 'off' || !state ? emptyCounts() : peekCounts(paths);
  const install = state?.install ?? null;
  const built = buildDocument({ install: install ?? '<made at the first send>', since: state?.last_sent ?? null, counts });
  return {
    destination: { method: 'POST', url: USAGE_URL },
    state: status.state, reason: status.reason,
    would_send: status.state === 'on' && state && !environmentSwitch(env) && !dueReason(state, now) ? 'next command' : 'not now',
    install: install ? 'present' : 'made at the first send',
    body: built?.body ?? null,
    last_receipt: lastReceipt(paths),
  };
}

export function telemetryOff({ env = process.env } = {}) {
  const paths = telemetryPaths(env);
  const current = readState(paths);
  const kept = current.kind === 'state' ? current.state : null;
  // Nothing is sent when a person opts out: this writes and deletes, only.
  writeState(paths, freshState({ state: 'off', set_by: 'command', noticed_at: kept?.noticed_at ?? null }));
  const removed = [];
  for (const [label, path] of [['unsent counts', paths.counts], ['unsent counts', paths.batch], ['receipts', paths.sent]]) {
    try { lstatSync(path); rmSync(path, { recursive: true, force: true }); if (!removed.includes(label)) removed.push(label); }
    catch { /* already absent */ }
  }
  for (const file of journalFiles(paths)) rmSync(file, { force: true });
  if (kept?.install) removed.unshift('install identifier');
  return { ok: true, state: 'off', removed, sent: false, state_file: paths.state };
}

export function telemetryOn({ env = process.env, now = Date.now() } = {}) {
  const paths = telemetryPaths(env);
  const current = readState(paths);
  const kept = current.kind === 'state' ? current.state : null;
  const noticed = kept?.noticed_at ?? null;
  writeState(paths, freshState({ set_by: 'command', noticed_at: noticed ?? new Date(now).toISOString() }));
  return { ok: true, state: 'on', notice: noticed ? null : noticeText(), state_file: paths.state,
    ...(environmentSwitch(env) ? { overridden_by: environmentSwitch(env) } : {}) };
}

export function telemetryReset({ env = process.env } = {}) {
  const paths = telemetryPaths(env);
  const current = readState(paths);
  if (current.kind === 'broken') throw Object.assign(new Error(`${current.problem.message} Run ${CLI_NAME} telemetry on or off to replace it.`), { code: current.problem.code });
  if (current.kind === 'state') writeState(paths, { ...current.state, install: null, last_sent: null });
  return { ok: true, install: 'made at the next send', state_file: paths.state };
}

const REASONS = { default: 'on unless turned off', command: 'set by the telemetry command', state_problem: 'the state file cannot be used' };
export function renderStatus(s) {
  const why = s.reason.variable ? `${s.reason.variable} is set${s.reason.source === 'ci' ? ' (a CI environment)' : ''}` : REASONS[s.reason.source];
  const lines = [`Telemetry: ${s.state.replace('_', ' ')} (${why})`];
  if (s.state === 'not_told') lines.push('The notice has not been shown on this machine; nothing is counted or sent until it is.');
  if (s.notice_emitted_at) lines.push(`Notice shown: ${s.notice_emitted_at}`);
  if (s.next_send_after) lines.push(`Next document: not before ${s.next_send_after}`);
  lines.push(`Last document sent: ${s.last_sent ?? 'none'}`);
  if (s.problem) lines.push(`Problem: ${s.problem.message} Nothing is counted or sent. (${s.problem.code})`);
  lines.push(`Destination: ${s.destination}`, `State file: ${s.state_file}`, `Counts and receipts: ${s.state_directory}`,
    `Turn off: ${CLI_NAME} telemetry off  ·  See what is sent: ${CLI_NAME} telemetry show`);
  return lines.join('\n');
}
export function renderShow(s) {
  const lines = [`Destination: ${s.destination.method} ${s.destination.url}`, `Telemetry: ${s.state.replace('_', ' ')}; would send: ${s.would_send}`];
  if (s.install !== 'present') lines.push('No install identifier exists yet; one is made at the first send, so a placeholder stands in below.');
  lines.push('Document (the exact bytes):', s.body ?? '(none: this version cannot build a valid document)');
  lines.push(s.last_receipt ? `Last receipt: ${s.last_receipt.path}\n${s.last_receipt.body}` : 'Last receipt: none');
  return lines.join('\n');
}
