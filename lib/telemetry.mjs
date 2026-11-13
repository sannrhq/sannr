// Usage counts: one small document a day, on unless turned off, never before
// a notice has been printed on this machine. docs/telemetry.md is the human
// page; lib/usage.schema.json is the whole contract with the receiving
// endpoint, and lib/usage-features.json is the only list of names it counts.
//
// What this module is allowed to know: fixed feature names from that file, a
// count per name, a count of executed API requests, the package version, the
// platform family, the Node major version and a random install identifier. It
// never receives a path, an argument, a host, a header or any text a person
// typed, so it cannot leak one.
//
// Rules that shape the code:
//  1. Nothing here may break, slow or change a command. Every entry point is
//     synchronous, bounded local file work wrapped in try/catch; the network
//     send happens in a detached child process (lib/telemetry-send.mjs) that
//     the command never waits for.
//  2. The off switches win before any file is touched: an environment switch,
//     a CI environment or a source checkout means no state is read or written.
//  3. Off cannot be undone by a send in progress: `telemetry off` takes the
//     send lock, and every other writer writes only while the state on disk
//     still says on.
//  4. A state file that cannot be read or written means nothing is counted,
//     nothing is sent and no notice is shown; `telemetry status` says why.
import { accessSync, constants, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_NAME, HOME_ENV_NAME, PRODUCT, PROSE_PRODUCT_TITLE, TELEMETRY_CHECKOUT_ENV_NAME, TELEMETRY_ENV_NAME, USAGE_URL } from './brand.mjs';
import { machineStatePaths } from './machine-state.mjs';
import { safeOutputPath, writeOutputFile, writeOutputFileAtomic } from './output-path.mjs';
import FEATURE_LIST from './usage-features.json' with { type: 'json' };

export const TELEMETRY_STATE_BASENAME = 'telemetry.json';
export const TELEMETRY_DIRECTORY = 'telemetry';
const COUNTS = 'counts.jsonl', BATCH = 'batch.json', LOCK = '.send.lock', SENT = 'sent', OWNER = 'owner.json';
const DAY_MS = 86_400_000;
export const TELEMETRY_LIMITS = Object.freeze({
  noticeWaitMs: DAY_MS, attemptsPerDay: 3, receiptsKept: 30, timeoutMs: 5_000, lockStaleMs: 60_000, offWaitMs: 8_000,
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
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The only names ever counted. */
export const FEATURES = new Set(FEATURE_LIST);

let packageVersionCache;
function packageVersion() {
  if (packageVersionCache !== undefined) return packageVersionCache;
  try { packageVersionCache = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version; }
  catch { packageVersionCache = null; }
  return packageVersionCache;
}
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// --- the fixed feature names -------------------------------------------------

// The command shapes the CLI recognizes. A subcommand listed here is folded
// into the name (suite_run, saved_run); any other counts as its command; a
// command not listed is not counted. Every name is then checked against
// lib/usage-features.json, so nothing outside that file is ever counted, and
// a test proves these tables produce exactly that file.
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
const known = name => (FEATURES.has(name) ? name : null);

/** Every name the CLI tables can produce (for the test that pins the file). */
export function cliFeatureNames() {
  return [...new Set([...Object.values(CLI_ALIASES), ...Object.entries(CLI_COMMANDS)
    .flatMap(([command, subs]) => [command, ...subs.map(sub => `${command}_${sub}`)])])].sort();
}

/** The fixed feature name for one CLI invocation, or null when it has none.
 *  The telemetry command itself is never counted. */
export function cliFeature(argv) {
  const first = argv[0];
  if (first === undefined) return known('help');
  if (first === 'telemetry') return null;
  if (Object.hasOwn(CLI_ALIASES, first)) return known(CLI_ALIASES[first]);
  if (!Object.hasOwn(CLI_COMMANDS, first)) return null;
  if (argv.includes('--help') || argv.includes('-h')) return known('help');
  const subs = CLI_COMMANDS[first];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (VALUE_FLAGS.has(token)) { i++; continue; }
    if (token.startsWith('-')) continue;
    return known(subs.includes(token) ? `${first}_${token}` : first);
  }
  return known(first);
}

/** The fixed feature name for one MCP tool call, or null for a name the
 *  server does not declare or the file does not list. */
export function mcpFeature(tool, declared) {
  if (typeof tool !== 'string' || !declared.includes(tool)) return null;
  return known(`mcp_${tool.replaceAll('-', '_')}`);
}

// --- switches, paths and state -------------------------------------------------

// A source checkout (a `.git` directory, or the `.git` file of a worktree,
// at the package root) never counts or sends: contributors' and agents' test
// runs must not be in the numbers. A published package has neither. Only a
// test that names this checkout's own real path switches it on.
let checkoutCache;
function inCheckout(env) {
  if (checkoutCache === undefined) {
    try { lstatSync(join(PACKAGE_ROOT, '.git')); checkoutCache = true; }
    catch (error) { checkoutCache = error.code !== 'ENOENT'; }
  }
  if (!checkoutCache) return false;
  const named = env[TELEMETRY_CHECKOUT_ENV_NAME];
  if (typeof named !== 'string' || !named) return true;
  try { return realpathSync(named) !== realpathSync(PACKAGE_ROOT); } catch { return true; }
}

/** What turns telemetry off for this process before any state is read, or null. */
export function environmentSwitch(env = process.env) {
  const own = env[TELEMETRY_ENV_NAME];
  if (typeof own === 'string' && OFF_VALUES.has(own.trim().toLowerCase())) return { source: 'environment', variable: TELEMETRY_ENV_NAME };
  if (env.DO_NOT_TRACK === '1') return { source: 'environment', variable: 'DO_NOT_TRACK' };
  if (typeof env.CI === 'string' && env.CI !== '' && !['0', 'false'].includes(env.CI.trim().toLowerCase())) return { source: 'ci', variable: 'CI' };
  for (const name of CI_VARIABLES) if (typeof env[name] === 'string' && env[name] !== '') return { source: 'ci', variable: name };
  if (inCheckout(env)) return { source: 'checkout' };
  return null;
}

function pathsFor(directory) {
  const folder = join(directory, TELEMETRY_DIRECTORY);
  return { directory, state: join(directory, TELEMETRY_STATE_BASENAME), folder,
    counts: join(folder, COUNTS), batch: join(folder, BATCH), lock: join(folder, LOCK), sent: join(folder, SENT) };
}
export function telemetryPaths(env = process.env) {
  return pathsFor(machineStatePaths({ env }).directory);
}
/** The user's default state directory (~/.sannr), whatever SANNR_HOME says.
 *  Off recorded there holds for every process of this operating-system user. */
function defaultPaths(env) {
  const { [HOME_ENV_NAME]: _ignored, ...rest } = env;
  return pathsFor(machineStatePaths({ env: rest }).directory);
}
function offByDefaultHome(paths, env) {
  const user = defaultPaths(env);
  if (user.directory === paths.directory) return false;
  const current = readState(user);
  return current.kind === 'state' && current.state.state === 'off';
}

const isDate = value => typeof value === 'string' && DATE.test(value);
const isTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validState(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.v === 1
    && ['on', 'off'].includes(value.state) && ['default', 'command'].includes(value.set_by)
    && (value.noticed_at === null || isTime(value.noticed_at))
    && (value.install === null || typeof value.install === 'string' && UUID_V4.test(value.install))
    && (value.since === null || isDate(value.since))
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
const stateBytes = state => `${JSON.stringify(state)}\n`;

// The explicit commands (off, on, reset) replace the record whatever it says.
function writeState(paths, state) {
  privateDirectory(paths.directory);
  writeOutputFileAtomic(paths.state, stateBytes(state), { mode: 0o600 });
}
// The notice creates the record only where none exists: a hard link of a
// complete private file either appears whole or fails because a record (for
// example a concurrent off) is already there.
function createState(paths, state) {
  privateDirectory(paths.directory);
  safeOutputPath(paths.state);
  const temp = join(paths.directory, `telemetry.new-${process.pid}-${randomBytes(4).toString('hex')}.json`);
  writeOutputFile(temp, stateBytes(state), { mode: 0o600 });
  try { linkSync(temp, paths.state); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { try { unlinkSync(temp); } catch { /* already gone */ } }
}
// Automatic writers (the send and its outcome) change the record only while it
// still says on for the same install; anything else on disk wins.
function updateStateIfOn(paths, expectedInstall, change) {
  const current = readState(paths);
  if (current.kind !== 'state' || current.state.state !== 'on' || current.state.install !== expectedInstall) return false;
  writeOutputFileAtomic(paths.state, stateBytes({ ...current.state, ...change(current.state) }), { mode: 0o600 });
  return true;
}

const freshState = (fields = {}) => ({ v: 1, state: 'on', set_by: 'default', noticed_at: null, install: null,
  since: null, last_sent: null, attempt_day: null, attempts: 0, ...fields });
const utcDay = now => new Date(now).toISOString().slice(0, 10);

// --- the notice ----------------------------------------------------------------

/** The notice, one paragraph. Its wording is the product's promise; keep it
 *  plain and keep every element docs/telemetry.md lists. */
export function noticeText() {
  const host = new URL(USAGE_URL).host;
  return `${PROSE_PRODUCT_TITLE} telemetry: once a day ${PROSE_PRODUCT_TITLE} sends usage counts to ${host}: `
    + `a random install ID (derived from nothing on this machine; the same every day, so one day's counts can be linked to the next), `
    + `the ${PROSE_PRODUCT_TITLE} version, the operating system (with processor type and Node.js major version), `
    + `how many times each ${PROSE_PRODUCT_TITLE} command and MCP tool ran, and how many API calls went through it. `
    + `Nothing about your repositories, APIs or requests is sent. It is on unless you turn it off: run \`${CLI_NAME} telemetry off\`, `
    + `or tell your agent "opt out". \`${CLI_NAME} telemetry show\` prints exactly what is sent. `
    + `Nothing has been sent yet; the first send is no earlier than 24 hours from now.`;
}

// Record that the notice was emitted. Returns true only when this call
// created the record: a machine that cannot keep the record, or already has
// one, is not shown the notice again.
function recordNotice(paths, now) {
  if (readState(paths).kind !== 'untold') return false;
  try { return createState(paths, freshState({ noticed_at: new Date(now).toISOString() })); }
  catch { return false; }
}

// --- counting --------------------------------------------------------------------

function active(paths, env) {
  if (environmentSwitch(env)) return null;
  const current = readState(paths);
  if (!(current.kind === 'state' && current.state.state === 'on' && current.state.noticed_at)) return null;
  return offByDefaultHome(paths, env) ? null : current.state;
}

function appendCount(paths, line) {
  privateDirectory(paths.folder);
  writeOutputFile(paths.counts, `${line}\n`, { append: true, mode: 0o600 });
}

/** Count one run of a fixed feature name. Never throws. */
export function recordFeature(name, { env = process.env } = {}) {
  try {
    if (!FEATURES.has(name)) return;
    const paths = telemetryPaths(env);
    if (active(paths, env)) appendCount(paths, JSON.stringify({ f: name }));
  } catch { /* counting never affects a command */ }
}

/** Count one request executed against the person's APIs (not doctor's probe,
 *  not a feedback send). Kept apart from the usage log, which a person may
 *  redirect. Never throws. */
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
  if (typeof row.f === 'string' && FEATURES.has(row.f))
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
      if (FEATURES.has(name) && Number.isSafeInteger(count) && count > 0) out.features[name] = Math.min(L.featureMax, count);
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

// One document per UTC day per machine state, whatever the identifier: reset
// keeps the day's record.
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
//
// A directory that appears with its owner record already inside it (a renamed
// private directory), so a lock is never seen without its owner. Its age is
// the time written inside it, never a file time: processes on one machine
// share a clock, file systems need not.

function readOwner(paths) {
  try {
    const stat = lstatSync(paths.lock);
    if (!stat.isDirectory()) return { broken: true };
    const owner = JSON.parse(readFileSync(join(paths.lock, OWNER), 'utf8'));
    if (typeof owner?.nonce !== 'string' || !Number.isFinite(owner.created_at)) return { broken: true };
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT' && !existsLock(paths)) return null;
    return { broken: true };
  }
}
function existsLock(paths) { try { lstatSync(paths.lock); return true; } catch { return false; } }
function lockStale(owner, now) {
  return owner.broken || Math.abs(now - owner.created_at) > L.lockStaleMs;
}
function discardLock(paths, judged) {
  try {
    const stat = lstatSync(paths.lock);
    if (!stat.isDirectory()) { rmSync(paths.lock, { force: true }); return; }
    const trash = join(paths.folder, `.send.lock.stale-${randomBytes(4).toString('hex')}`);
    renameSync(paths.lock, trash);
    // Put back a lock that changed hands since it was judged stale.
    let moved = null;
    try { moved = JSON.parse(readFileSync(join(trash, OWNER), 'utf8')); } catch { /* broken */ }
    if (judged && !judged.broken && moved?.nonce !== judged.nonce) { try { renameSync(trash, paths.lock); return; } catch { /* taken */ } }
    rmSync(trash, { recursive: true, force: true });
  } catch { /* someone else discarded it */ }
}

/** The lock's nonce when acquired, otherwise null. */
function acquireLock(paths, now) {
  privateDirectory(paths.folder);
  const nonce = randomBytes(8).toString('hex');
  const temp = join(paths.folder, `.send.lock.new-${nonce}`);
  mkdirSync(temp, { mode: 0o700 });
  try {
    writeFileSync(join(temp, OWNER), JSON.stringify({ nonce, created_at: now, pid: process.pid }), { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // A rename onto an existing lock fails (or, for an empty broken
        // directory, replaces it), so exactly one contender holds the name.
        if (existsLock(paths) && attempt === 0) throw Object.assign(new Error('held'), { code: 'EEXIST' });
        renameSync(temp, paths.lock);
        return nonce;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'ENOTDIR', 'EISDIR', 'EBUSY'].includes(error.code)) throw error;
        const owner = readOwner(paths);
        if (owner && !lockStale(owner, now)) return null;
        discardLock(paths, owner);
      }
    }
    return null;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
export function releaseLock(paths, nonce) {
  try {
    const owner = readOwner(paths);
    if (owner && !owner.broken && owner.nonce === nonce) rmSync(paths.lock, { recursive: true, force: true });
  } catch { /* a stale lock is replaced later */ }
}

// Receipts: <stamp>-<id>.json while prepared, renamed with the outcome.
const RECEIPT = /^(\d{8}T\d{6}Z-[0-9a-f]{8})(?:\.(delivered|not-delivered))?\.json$/;
function pruneReceipts(paths) {
  try {
    const names = readdirSync(paths.sent).filter(name => RECEIPT.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - L.receiptsKept))) rmSync(join(paths.sent, name), { force: true });
  } catch { /* pruning is best effort */ }
}

function senderEnvironment(env) {
  // No proxy variable may redirect the send.
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
  let paths, nonce = null;
  try {
    paths = telemetryPaths(env);
    const state = active(paths, env);
    if (!state || dueReason(state, now)) return false;
    nonce = acquireLock(paths, now);
    if (!nonce) return false;
    // Recheck under the lock: another process may have sent, or a person
    // turned it off, meanwhile.
    const current = active(paths, env);
    if (!current || dueReason(current, now)) return false;
    const today = utcDay(now), install = current.install ?? randomUUID();
    const counts = foldCounts(paths);
    const built = buildDocument({ install, since: current.since, counts });
    if (!built) return false;
    if (!updateStateIfOn(paths, current.install, () => ({ install,
      attempt_day: today, attempts: current.attempt_day === today ? current.attempts + 1 : 1 }))) return false;
    privateDirectory(paths.sent);
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const receipt = join(paths.sent, `${stamp}-${randomBytes(4).toString('hex')}.json`);
    writeOutputFileAtomic(receipt, built.body, { mode: 0o600 });
    pruneReceipts(paths);
    // The sender holds the state directory, never the project, as its cwd.
    const child = spawn(process.execPath, [SENDER, receipt, nonce], { detached: true, stdio: 'ignore', windowsHide: true,
      cwd: paths.folder, env: senderEnvironment(env) });
    const held = nonce;
    child.on('error', () => releaseLock(paths, held));
    child.unref();
    nonce = null; // the sender owns the lock now
    return true;
  } catch { return false; }
  finally { if (nonce) releaseLock(paths, nonce); }
}

function markReceipt(receipt, outcome) {
  try { renameSync(receipt, receipt.replace(/\.json$/, `.${outcome}.json`)); } catch { /* the bytes stay as prepared */ }
}

/** The detached sender's work: POST the receipt's exact bytes once. Counts are
 *  cleared only on a 2xx answer. */
export async function deliver(receipt, nonce, { env = process.env } = {}) {
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
    markReceipt(receipt, ok ? 'delivered' : 'not-delivered');
    if (!ok) return;
    // Recorded only while the state still says on for this install: an off or
    // reset made while the request was out wins.
    const day = state.attempt_day;
    if (!updateStateIfOn(paths, sentDocument.install, () => ({ last_sent: day, since: day }))) return;
    const batch = readBatch(paths);
    for (const name of Object.keys(sentDocument.features ?? {})) delete batch.features[name];
    batch.api_calls = 0;
    writeOutputFileAtomic(paths.batch, `${JSON.stringify(batch)}\n`, { mode: 0o600 });
  } catch { /* the sender has no one to report to */ }
  finally { releaseLock(paths, nonce); }
}

// --- the entry points --------------------------------------------------------------

function writeNotice(text) {
  try { writeSync(2, `${text}\n`); } catch { /* stderr may be closed */ }
}

/** Called once at the start of every CLI invocation, before anything prints.
 *  Synchronous and bounded; never throws. A dry run writes nothing, records no
 *  notice and starts no send. `connect` emits its notice in its own output
 *  instead (takeConnectNotice). */
export function cliStart(argv, { env = process.env, now = Date.now() } = {}) {
  try {
    if (argv[0] === 'telemetry' || argv.includes('--dry-run') || environmentSwitch(env)) return;
    const paths = telemetryPaths(env);
    const feature = cliFeature(argv);
    const current = readState(paths);
    if (current.kind === 'untold') {
      if (argv[0] === 'connect' || offByDefaultHome(paths, env)) return;
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
    if (offByDefaultHome(paths, env) || !recordNotice(paths, now)) return null;
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
    if (offByDefaultHome(paths, env)) { mcpNoticeSettled = true; return null; }
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

function receipts(paths) {
  const out = { last_attempt: null, last_delivered: null };
  try {
    safeOutputPath(paths.sent, { directory: true });
    const names = readdirSync(paths.sent).filter(name => RECEIPT.test(name)).sort();
    const read = name => { const path = join(paths.sent, name); safeOutputPath(path); return { path, body: readFileSync(path, 'utf8') }; };
    if (names.length) {
      const name = names.at(-1), outcome = RECEIPT.exec(name)[2] ?? 'prepared';
      out.last_attempt = { outcome, ...read(name) };
    }
    const delivered = names.filter(name => RECEIPT.exec(name)[2] === 'delivered').at(-1);
    if (delivered) out.last_delivered = read(delivered);
  } catch { /* none */ }
  return out;
}

function lockStatus(paths, now) {
  const owner = readOwner(paths);
  if (!owner) return null;
  return lockStale(owner, now) ? 'stale: replaced by the next send' : 'held by a send in progress';
}

export function telemetryStatus({ env = process.env, now = Date.now() } = {}) {
  const paths = telemetryPaths(env);
  const current = readState(paths);
  const switched = environmentSwitch(env);
  const userOff = !switched && offByDefaultHome(paths, env);
  const problem = current.kind === 'broken' ? current.problem : stateProblem(paths);
  const state = current.kind === 'state' ? current.state : null;
  let status, reason;
  if (switched) { status = 'off'; reason = switched; }
  else if (userOff) { status = 'off'; reason = { source: 'command', scope: defaultPaths(env).state }; }
  else if (current.kind === 'broken') { status = 'unavailable'; reason = { source: 'state_problem' }; }
  else if (current.kind === 'untold') { status = problem ? 'unavailable' : 'not_told'; reason = { source: problem ? 'state_problem' : 'default' }; }
  else { status = state.state; reason = { source: state.set_by }; }
  const due = state && status === 'on' ? dueReason(state, now) : null;
  const nextAfter = state?.noticed_at && status === 'on'
    ? new Date(Math.max(Date.parse(state.noticed_at) + L.noticeWaitMs,
      due === 'sent_today' || due === 'attempts_exhausted' ? Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY_MS : now)).toISOString()
    : null;
  return {
    state: status, reason, sending: status === 'on' && Boolean(state?.noticed_at),
    machine_state: current.kind === 'state' ? state.state : current.kind === 'untold' ? 'not_told' : 'unreadable',
    notice_emitted_at: state?.noticed_at ?? null,
    // A time, not a promise: the next command at or after it starts the send.
    next_send_after: nextAfter, last_sent: state?.last_sent ?? null,
    attempts_today: state?.attempt_day === utcDay(now) ? state.attempts : 0,
    install: state?.install ? 'present' : 'absent', send_lock: lockStatus(paths, now),
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
  const built = buildDocument({ install: install ?? '<made at the first send>', since: state?.since ?? null, counts });
  return {
    destination: { method: 'POST', url: USAGE_URL },
    state: status.state, reason: status.reason,
    would_send: status.state === 'on' && state && !dueReason(state, now) ? 'next command' : 'not now',
    install: install ? 'present' : 'made at the first send',
    body: built?.body ?? null,
    ...receipts(paths),
  };
}

// Turn off one state directory: under the send lock (waiting a bounded time
// for a send in progress), record off, then delete the identifier, unsent
// counts and receipts. Returns what was removed.
function turnOff(paths, now) {
  let nonce = null;
  const end = Date.now() + L.offWaitMs;
  try {
    privateDirectory(paths.folder);
    for (;;) {
      nonce = acquireLock(paths, now);
      if (nonce || Date.now() >= end) break;
      sleep(50);
    }
  } catch { /* off is recorded even without the lock */ }
  try {
    const current = readState(paths);
    const kept = current.kind === 'state' ? current.state : null;
    writeState(paths, freshState({ state: 'off', set_by: 'command', noticed_at: kept?.noticed_at ?? null }));
    const removed = kept?.install ? ['install identifier'] : [];
    for (const [label, path] of [['unsent counts', paths.counts], ['unsent counts', paths.batch], ['receipts', paths.sent]]) {
      try { lstatSync(path); rmSync(path, { recursive: true, force: true }); if (!removed.includes(label)) removed.push(label); }
      catch { /* already absent */ }
    }
    for (const file of journalFiles(paths)) rmSync(file, { force: true });
    return { removed, waited_for_send: !nonce };
  } finally { if (nonce) releaseLock(paths, nonce); }
}

/** Off for this state directory and for the user's default one, so off holds
 *  for every process of this operating-system user. Nothing is sent. */
export function telemetryOff({ env = process.env, now = Date.now() } = {}) {
  const paths = telemetryPaths(env), user = defaultPaths(env);
  const result = turnOff(paths, now);
  let userProblem = null;
  if (user.directory !== paths.directory) {
    try {
      const other = turnOff(user, now);
      for (const label of other.removed) if (!result.removed.includes(label)) result.removed.push(label);
    } catch { userProblem = { code: 'TELEMETRY_USER_STATE_UNWRITABLE', message: 'Off could not also be recorded in the default state directory.' }; }
  }
  return { ok: true, state: 'off', removed: result.removed, sent: false, state_file: paths.state,
    ...(user.directory !== paths.directory ? { user_state_file: user.state } : {}), ...(userProblem ? { problem: userProblem } : {}) };
}

export function telemetryOn({ env = process.env, now = Date.now() } = {}) {
  const paths = telemetryPaths(env), user = defaultPaths(env);
  const current = readState(paths);
  const kept = current.kind === 'state' ? current.state : null;
  const noticed = kept?.noticed_at ?? null;
  writeState(paths, freshState({ set_by: 'command', noticed_at: noticed ?? new Date(now).toISOString(),
    last_sent: kept?.last_sent ?? null, attempt_day: kept?.attempt_day ?? null, attempts: kept?.attempts ?? 0 }));
  // An off recorded for the whole user is lifted by the same person's on.
  if (user.directory !== paths.directory) {
    const userState = readState(user);
    if (userState.kind === 'state' && userState.state.state === 'off')
      writeState(user, { ...userState.state, state: 'on', set_by: 'command' });
  }
  const switched = environmentSwitch(env);
  return { ok: true, state: 'on', notice: noticed ? null : noticeText(), state_file: paths.state,
    ...(switched ? { overridden_by: switched } : {}) };
}

/** A new identifier at the next send. The day's record stays, so a reset
 *  never adds a document to the day. */
export function telemetryReset({ env = process.env } = {}) {
  const paths = telemetryPaths(env);
  const current = readState(paths);
  if (current.kind === 'broken') throw Object.assign(new Error(`${current.problem.message} Run ${CLI_NAME} telemetry on or off to replace it.`), { code: current.problem.code });
  if (current.kind === 'state') writeState(paths, { ...current.state, install: null, since: null });
  return { ok: true, install: 'made at the next send', state_file: paths.state };
}

const REASONS = { default: 'on unless turned off', command: 'set by the telemetry command',
  state_problem: 'the state file cannot be used', checkout: 'this is a source checkout; it never counts or sends' };
export function renderStatus(s) {
  const why = s.reason.variable ? `${s.reason.variable} is set${s.reason.source === 'ci' ? ' (a CI environment)' : ''}`
    : s.reason.scope ? `turned off for this user in ${s.reason.scope}` : REASONS[s.reason.source];
  const lines = [`Telemetry: ${s.state.replace('_', ' ')} (${why})`];
  if (s.state === 'not_told') lines.push('The notice has not been printed on this machine; nothing is counted or sent until it is.');
  if (s.notice_emitted_at) lines.push(`Notice printed: ${s.notice_emitted_at}`);
  if (s.next_send_after) lines.push(`Next document: the first command at or after ${s.next_send_after}`);
  lines.push(`Last document delivered: ${s.last_sent ?? 'none'}`);
  if (s.send_lock) lines.push(`Send lock: ${s.send_lock}`);
  if (s.problem) lines.push(`Problem: ${s.problem.message} Nothing is counted or sent. (${s.problem.code})`);
  lines.push(`Destination: ${s.destination}`, `State file: ${s.state_file}`, `Counts and receipts: ${s.state_directory}`,
    `Turn off: ${CLI_NAME} telemetry off  ·  See what is sent: ${CLI_NAME} telemetry show`);
  return lines.join('\n');
}
export function renderShow(s) {
  const lines = [`Destination: ${s.destination.method} ${s.destination.url}`, `Telemetry: ${s.state.replace('_', ' ')}; would send: ${s.would_send}`];
  if (s.install !== 'present') lines.push('No install identifier exists yet; one is made at the first send, so a placeholder stands in below.');
  lines.push('Next document (the exact bytes):', s.body ?? '(none: this version cannot build a valid document)');
  lines.push(s.last_delivered ? `Last document delivered: ${s.last_delivered.path}\n${s.last_delivered.body}` : 'Last document delivered: none');
  lines.push(s.last_attempt ? `Last attempt (${s.last_attempt.outcome}): ${s.last_attempt.path}` : 'Last attempt: none');
  return lines.join('\n');
}
