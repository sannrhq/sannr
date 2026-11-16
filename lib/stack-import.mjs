// Import a stack from another repository: a local path or a Git URL fetched
// with the user's own git. The source is untrusted data. It is validated under
// the rules a local stack must pass, nothing in it is executed or followed,
// and no API request is sent. Planning writes nothing; applying a plan writes
// through the stack and note store functions `stack add` and `note` use.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT, planLayout } from './layout.mjs';
import { CONTEXT_BASENAME, POINTER_CLI_NAME } from './brand.mjs';
import { STACK_CONFIG_BASENAME, assertSafeStackPath, assertWritableStack, isBuiltinStack, readStackFile, readStackJson,
  stackCatalog, stackScope, validStackName, validateStackDocument } from './stacks.mjs';
import { CONTEXT_VERSION, MAX_CONTEXT_BYTES, applyContextNote, emptyContext, loadContextSnapshot, mapSourceFiles,
  operationsFrom, readContract, saveContext, sourceFileFor } from './context.mjs';
import { baselineNoteHistory, inspectNoteHistory, protectContextNoteHistory, validAuthoredNoteStamp, validNoteImport } from './note-history.mjs';
import { RETIRE_REASONS } from './note-reviews.mjs';
import { withStackScope } from './stack-scope.mjs';
import { stacksMigrationRequired } from './stack-migration-state.mjs';
import { secretIn } from './verdicts.mjs';
import { BLOCK_TEXT_MAX, hasCommentMarkup } from './block-text.mjs';
import { writeOutputFileAtomic } from './output-path.mjs';

export const IMPORT_RECORD_KEY = 'imported_from';
const MAX_CONTRACT_BYTES = 16 * 1024 * 1024;
const MAX_FOLDER_ENTRIES = 4096;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,255}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const portable = value => value.split(sep).join('/');
const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const today = () => new Date().toISOString().slice(0, 10);
const within = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };

/** What the user typed, classified. Nothing is contacted or read here. */
export function parseImportSource(source, { ref } = {}) {
  if (typeof source !== 'string' || !source.trim() || source.startsWith('-'))
    fail('STACK_IMPORT_SOURCE_INVALID', 'Name the source: a local path or a Git URL (https or ssh).');
  if (ref !== undefined && (!GIT_REF.test(ref) || ref.includes('..')))
    fail('STACK_IMPORT_REF_INVALID', 'A Git ref is a branch, tag or commit name of letters, digits and . _ / @ -.');
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+\.[A-Za-z0-9.-]+):(?!\/\/)([^\s:][^\s]*)$/.exec(source);
  if (scp && !/^[A-Za-z]:[\\/]/.test(source))
    return { kind: 'git', url: source, ref, location: `ssh://${scp[1]}/${scp[2].replace(/^\/+/, '')}` };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(source)?.[1].toLowerCase();
  if (scheme) {
    if (!['https', 'ssh', 'file'].includes(scheme))
      fail('STACK_IMPORT_SOURCE_INVALID', `A Git source uses https or ssh; '${scheme}' is not fetched.`);
    let url;
    try { url = new URL(source); } catch { fail('STACK_IMPORT_SOURCE_INVALID', 'The Git URL could not be parsed.'); }
    if (url.password || url.search || url.hash || scheme === 'https' && url.username)
      fail('STACK_IMPORT_SOURCE_INVALID', 'A Git URL must not carry credentials, a query or a fragment; let git supply credentials.');
    if (scheme === 'file') return { kind: 'git', url: source, ref, file: fileURLToPath(url) };
    // The recorded source drops the ssh login name: it is not part of where
    // the stack came from, and it reads as an address in committed files.
    url.username = '';
    return { kind: 'git', url: source, ref, location: url.href.replace(/\/+$/, '') };
  }
  if (ref !== undefined) fail('STACK_IMPORT_REF_INVALID', '--ref applies to a Git URL; a local path is read as it is on disk.');
  return { kind: 'path', path: source };
}

// A path recorded in committed files is relative to this repository, never
// machine-absolute. Across drives there is no relative form; keep the name.
// A source more than two directories above this repository would spell most
// of its absolute path, so it is recorded by its directory name alone.
function recordedPath(root, target) {
  const part = portable(relative(root, target));
  return isAbsolute(part) || part.startsWith('../../../') || part === '../../..' ? basename(target) : part || '.';
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, ...options });
  } catch (error) {
    if (error.code === 'ENOENT') fail('STACK_IMPORT_GIT_UNAVAILABLE', 'git was not found on PATH; a Git source is fetched with your own git.');
    const detail = String(error.stderr ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 300);
    fail('STACK_IMPORT_GIT_FAILED', `git could not fetch the source${detail ? `: ${detail}` : '.'}`);
  }
}

// The commit of a local source is read from its files; git is not run inside a
// directory this command did not create.
function small(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('unreadable');
  return readFileSync(path, 'utf8');
}
function localCommit(directory) {
  try {
    for (let current = directory;; current = dirname(current)) {
      const dot = join(current, '.git'), stat = lstatSync(dot, { throwIfNoEntry: false });
      if (stat) {
        let gitDir = dot;
        if (stat.isFile()) {
          const pointer = /^gitdir: (.+)$/m.exec(small(dot))?.[1].trim();
          if (!pointer) return null;
          gitDir = resolve(current, pointer);
        } else if (!stat.isDirectory()) return null;
        const head = small(join(gitDir, 'HEAD')).trim();
        if (COMMIT.test(head)) return head;
        const ref = /^ref: (refs\/[A-Za-z0-9._/@-]+)$/.exec(head)?.[1];
        if (!ref || ref.includes('..')) return null;
        const common = existsSync(join(gitDir, 'commondir')) ? resolve(gitDir, small(join(gitDir, 'commondir')).trim()) : gitDir;
        for (const base of new Set([gitDir, common])) {
          if (!existsSync(join(base, ref))) continue;
          const value = small(join(base, ref)).trim();
          return COMMIT.test(value) ? value : null;
        }
        if (existsSync(join(common, 'packed-refs')))
          for (const line of small(join(common, 'packed-refs')).split('\n')) {
            const [value, name] = line.split(' ');
            if (name === ref && COMMIT.test(value)) return value;
          }
        return null;
      }
      if (dirname(current) === current) return null;
    }
  } catch { return null; }
}

/** Make the source readable on disk. A Git source is fetched into a temporary
 *  directory; `release` removes it. `announce` receives the git command line
 *  before it runs, because it is this command's only network use. */
export function openImportSource(root, parsed, { announce = () => {} } = {}) {
  if (parsed.kind === 'path') {
    let directory;
    try { directory = realpathSync(resolve(parsed.path)); } catch { fail('STACK_IMPORT_SOURCE_NOT_FOUND', 'The source path does not exist.'); }
    if (!statSync(directory).isDirectory()) fail('STACK_IMPORT_SOURCE_INVALID', 'The source path must be a directory: a repository, its stacks directory or one stack folder.');
    const located = locateStacks(directory);
    return { kind: 'path', directory, ...located, location: recordedPath(root, located.owner), commit: localCommit(located.owner), release() {} };
  }
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'stack-import-')));
  const release = () => rmSync(temporary, { recursive: true, force: true });
  try {
    const target = parsed.ref ?? 'HEAD';
    announce(`git fetch --depth 1 --no-tags -- ${parsed.url} ${target}`);
    git(['init', '--quiet', temporary]);
    git(['-C', temporary, 'fetch', '--quiet', '--depth', '1', '--no-tags', '--', parsed.url, target]);
    git(['-C', temporary, '-c', `core.hooksPath=${devNull}`, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    const commit = git(['-C', temporary, 'rev-parse', 'HEAD']).trim();
    return { kind: 'git', directory: temporary, ...locateStacks(temporary),
      location: parsed.location ?? recordedPath(root, realpathSync(parsed.file)),
      ...(parsed.ref ? { ref: parsed.ref } : {}), commit: COMMIT.test(commit) ? commit : null, release };
  } catch (error) { release(); throw error; }
}

// A repository root, its stacks directory, or one stack folder. `owner` is the
// directory the recorded source names, so the three spellings of one source
// are one source.
function locateStacks(directory) {
  const entryAt = path => lstatSync(path, { throwIfNoEntry: false });
  const collection = join(directory, LAYOUT.collection);
  const ownerOf = path => portable(path).endsWith(`/${LAYOUT.collection}`) ? resolve(path, ...LAYOUT.collection.split('/').map(() => '..')) : path;
  if (entryAt(join(directory, STACK_CONFIG_BASENAME)) && !entryAt(collection))
    return { owner: ownerOf(dirname(directory)) === dirname(directory) ? directory : ownerOf(dirname(directory)),
      stacks: [{ name: basename(directory), folder: directory }] };
  const base = entryAt(collection) ? collection : directory;
  const baseEntry = entryAt(base);
  if (baseEntry.isSymbolicLink() || !baseEntry.isDirectory()) fail('STACK_UNSAFE_PATH', 'The source stacks directory must be a real directory, not a link.');
  const stacks = [];
  for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (isBuiltinStack(entry.name) || !validStackName(entry.name)) continue;
    const folder = join(base, entry.name);
    if (entry.isSymbolicLink() || entry.isDirectory() && entryAt(join(folder, STACK_CONFIG_BASENAME))) stacks.push({ name: entry.name, folder });
  }
  if (!stacks.length) fail('STACK_IMPORT_SOURCE_EMPTY', `The source holds no stack: expected ${LAYOUT.collection}/<name>/${STACK_CONFIG_BASENAME}, a stacks directory or one stack folder.`);
  return { owner: base === collection ? directory : ownerOf(base), stacks };
}

function assertNoLinks(folder, name) {
  let seen = 0;
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++seen > MAX_FOLDER_ENTRIES) fail('STACK_IMPORT_LIMIT', `Stack '${name}' in the source has more than ${MAX_FOLDER_ENTRIES} files.`);
      if (entry.isSymbolicLink()) fail('STACK_UNSAFE_PATH', `Stack '${name}' in the source contains a symbolic link ('${entry.name}'); links are not followed.`, { source_stack: name });
      if (entry.isDirectory()) walk(join(directory, entry.name));
    }
  };
  walk(folder);
}

/** Read one source stack folder as untrusted data. */
function readSourceStack({ name, folder }) {
  const at = lstatSync(folder);
  if (at.isSymbolicLink() || !at.isDirectory()) fail('STACK_UNSAFE_PATH', `Stack '${name}' in the source is a symbolic link; links are not followed.`, { source_stack: name });
  assertSafeStackPath(folder, true);
  assertNoLinks(folder, name);
  const document = readStackJson(join(folder, STACK_CONFIG_BASENAME), `stack '${name}' in the source`);
  // Containment is the stack folder itself: a contract anywhere else in the
  // source repository does not come along and is refused.
  try { validateStackDocument(folder, folder, name, document); }
  catch (error) {
    if (error.code === 'STACK_CONTRACT_OUTSIDE_PROJECT')
      fail(error.code, `Stack '${name}' in the source names a contract outside its stack folder; it was not imported.`, { source_stack: name });
    throw Object.assign(error, { source_stack: name });
  }
  const contracts = new Map();
  for (const path of [document.contract, ...Object.values(document.environments).map(environment => environment.contract)]) {
    if (!path) continue;
    const local = portable(relative(folder, resolve(folder, path)));
    if ([STACK_CONFIG_BASENAME, CONTEXT_BASENAME].includes(local))
      fail('STACK_CONTRACT_INVALID', `Stack '${name}' in the source names a metadata file as its contract.`, { source_stack: name });
    if (contracts.has(local)) continue;
    if (!existsSync(join(folder, local))) fail('STACK_CONTRACT_INVALID', `Stack '${name}' in the source names a contract that is not in its folder.`, { source_stack: name });
    contracts.set(local, readStackFile(join(folder, local), MAX_CONTRACT_BYTES, 'STACK_CONTRACT_LIMIT', `The contract of stack '${name}'`));
  }
  let knowledge = null;
  const file = join(folder, CONTEXT_BASENAME);
  if (lstatSync(file, { throwIfNoEntry: false })) {
    try { knowledge = JSON.parse(readStackFile(file, MAX_CONTEXT_BYTES, 'CONTEXT_CAPACITY_REACHED', `The knowledge file of stack '${name}'`).toString('utf8')); }
    catch (error) { if (error.code) throw error; knowledge = undefined; }
    if (!object(knowledge) || !object(knowledge.operations))
      fail('STACK_IMPORT_KNOWLEDGE_INVALID', `The knowledge file of stack '${name}' in the source is not a usable knowledge document.`, { source_stack: name });
    if (knowledge.v !== CONTEXT_VERSION)
      fail('CONTEXT_VERSION_UNSUPPORTED', `The knowledge file of stack '${name}' in the source has an unsupported version.`, { source_stack: name });
  }
  return { name, folder, document, contracts, knowledge };
}

// What the local stack.json keeps: credential references by variable name,
// never the author's envFile path; reserved keys are dropped.
function localDocument(document, name) {
  const { cli, mcp, ...kept } = structuredClone(document);
  const removed = [];
  for (const [environment, value] of Object.entries(kept.environments)) {
    if (Object.hasOwn(value, 'envFile')) { delete value.envFile; removed.push(environment); }
  }
  return { document: { ...kept, name }, envFileRemoved: removed };
}

function inventory(root, stack, name, document) {
  const selected = document.environments[document.default_environment]?.contract ?? document.contract;
  if (!selected) return emptyContext({ name: document.title ?? name, contractPath: null, contractDigest: null });
  const local = portable(relative(stack.folder, resolve(stack.folder, selected)));
  let contract;
  try { contract = readContract(join(stack.folder, local)); }
  catch { fail('PARSE_ERROR', `The contract of stack '${stack.name}' in the source could not be parsed.`, { source_stack: stack.name }); }
  const operations = operationsFrom(contract.doc);
  if (!operations.length) fail('NO_OPERATIONS', `The contract of stack '${stack.name}' in the source declares no supported operations.`, { source_stack: stack.name });
  const ctx = emptyContext({ name: typeof contract.doc.info?.title === 'string' ? contract.doc.info.title : document.title ?? name,
    contractPath: posix.join(LAYOUT.collection, name, local), contractDigest: contract.digest });
  const sources = mapSourceFiles(root);
  for (const { op, path } of operations) ctx.operations[op] ??= baselineNoteHistory({ source_file: sourceFileFor(path, sources),
    verified_at: null, contract_digest: null, shape_hash: null, status_codes: [],
    effect: op.startsWith('GET ') || op.startsWith('HEAD ') ? 'read' : 'write', fields: {} });
  return ctx;
}

const noteRefusal = (code, label, stack) => fail(code, {
  SECRET_IN_NOTE: `A note on ${label} in source stack '${stack}' appears to contain a credential; nothing was imported.`,
  MARKUP_IN_NOTE: `A note on ${label} in source stack '${stack}' contains comment markup; nothing was imported.`,
  NOTE_TOO_LONG: `A note on ${label} in source stack '${stack}' is longer than ${BLOCK_TEXT_MAX} characters; nothing was imported.`,
  NOTE_INPUT_INVALID: `A note on ${label} in source stack '${stack}' has provenance this version cannot keep; nothing was imported.`,
  NOTE_KEY_INVALID: `Source stack '${stack}' has an operation key this version cannot keep; nothing was imported.`,
  NOTE_HISTORY_INVALID: `The note history of ${label} in source stack '${stack}' is malformed; nothing was imported.`,
  NOTE_HISTORY_CHANGED: `The note history of ${label} in source stack '${stack}' differs from its recorded baseline; nothing was imported.`,
}[code], { source_stack: stack, operation: label });

// Evidence stays in the author's private storage. The reference is kept as
// what it is here: a run that is not on this machine.
const unavailableEvidence = evidence => evidence.map(reference => object(reference)
  ? { run_id: reference.run_id, state: 'unavailable', digest: null, provenance: reference.provenance, scope: reference.scope } : reference);

function importedStamp(record, origin) {
  const stamp = {};
  for (const key of ['by', 'at', 'recorded_at', 'actor', 'basis', 'source', 'operations'])
    if (record.provenance[key] !== undefined) stamp[key] = record.provenance[key];
  if (Array.isArray(record.provenance.evidence) && record.provenance.evidence.length) stamp.evidence = unavailableEvidence(record.provenance.evidence);
  else if (record.provenance.evidence !== undefined && !Array.isArray(record.provenance.evidence)) stamp.evidence = record.provenance.evidence;
  stamp.imported = { source: origin.location, ...(origin.commit ? { commit: origin.commit } : {}), at: origin.at, note: record.id };
  return stamp;
}

// One note target (an operation or the stack's shared facts): bring the
// source's active notes into `ctx` and count what happened.
function mergeNotes(ctx, key, label, sourceEntry, origin, report) {
  const history = inspectNoteHistory(sourceEntry, label);
  if (history.state === 'invalid') noteRefusal('NOTE_HISTORY_INVALID', label, origin.stack);
  if (history.state === 'changed') noteRefusal('NOTE_HISTORY_CHANGED', label, origin.stack);
  if (key.kind === 'operation' && (key.op.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(key.op) || secretIn(key.op) || hasCommentMarkup(key.op)))
    noteRefusal(secretIn(key.op) ? 'SECRET_IN_NOTE' : 'NOTE_KEY_INVALID', 'an operation', origin.stack);
  const links = Array.isArray(sourceEntry.note_replacements) ? sourceEntry.note_replacements : [];
  const previous = new Map(links.map(link => [link.replacement, link.supersedes]));
  const retirements = new Map((Array.isArray(sourceEntry.note_retirements) ? sourceEntry.note_retirements : []).map(row => [row.replacement, row.reason]));
  const entry = key.kind === 'stack' ? ctx.stack_facts : Object.hasOwn(ctx.operations, key.op) ? ctx.operations[key.op] : undefined;
  const local = () => new Map(inspectNoteHistory(entry ?? {}, label).records
    .filter(record => record.provenance?.imported?.source === origin.location)
    .map(record => [record.provenance.imported.note, record]));
  let have = local();
  for (const record of history.active) {
    if (record.kind !== 'authored') {
      report.skipped.push({ target: label, reason: record.kind === 'machine' ? 'MACHINE_NOTE' : 'NOTE_ATTRIBUTION_UNKNOWN' });
      continue;
    }
    if (have.has(record.id)) { report.notes.unchanged += 1; continue; }
    if (secretIn(record.text, { allowAuthReferences: true })) noteRefusal('SECRET_IN_NOTE', label, origin.stack);
    if (hasCommentMarkup(record.text)) noteRefusal('MARKUP_IN_NOTE', label, origin.stack);
    if (typeof record.text !== 'string' || record.text.length > BLOCK_TEXT_MAX) noteRefusal('NOTE_TOO_LONG', label, origin.stack);
    const stamp = importedStamp(record, origin);
    if (!validAuthoredNoteStamp(stamp)) noteRefusal('NOTE_INPUT_INVALID', label, origin.stack);
    if (stamp.evidence) report.evidence_unavailable += stamp.evidence.length;
    let ancestor = null;
    for (let cursor = previous.get(record.id), steps = 0; cursor && steps < 1024; cursor = previous.get(cursor), steps++)
      if (have.has(cursor)) { ancestor = have.get(cursor); break; }
    const reason = retirements.get(record.id);
    const explanation = /^Retired sha256:[a-f0-9]{64} \([a-z-]+\): ([\s\S]+)$/.exec(record.text)?.[1];
    const target = ancestor && !ancestor.superseded ? ancestor : null;
    if (reason !== undefined && !target) {
      // A retirement of a note that never arrived here retires nothing.
      report.skipped.push({ target: label, reason: 'RETIREMENT_TARGET_NOT_HERE' });
      continue;
    }
    const attempts = [];
    if (target && key.kind === 'operation' && RETIRE_REASONS.includes(reason) && explanation && ['person', 'agent'].includes(stamp.actor))
      attempts.push({ change: { note: explanation, retirement: { note_id: target.id, reason } }, counts: 'retired' });
    if (target) attempts.push({ change: { note: record.text, relation: { supersedes: target.id } }, counts: reason === undefined ? 'updated' : 'retired' });
    attempts.push({ change: { note: record.text }, counts: 'added' }, { change: { note: record.text, relation: { alongside: true } }, counts: 'added' });
    let result, counted;
    for (const [index, attempt] of attempts.entries()) {
      try { result = applyContextNote(ctx, { key, stamp: structuredClone(stamp), ...attempt.change }); counted = attempt.counts; break; }
      catch (error) {
        // A locally trusted note is not overturned by an upstream change: the
        // upstream note arrives beside it and the receipt says so.
        const next = index < attempts.length - 1 && (error.code === 'NOTE_RELATION_REQUIRED'
          || attempt.change.retirement || attempt.change.relation?.supersedes && /^NOTE_(?:REVIEW|RETIRE|ALREADY|SELF)_/.test(error.code ?? ''));
        if (!next) throw Object.assign(error, { source_stack: origin.stack, operation: label });
        if (error.code === 'NOTE_REVIEW_EVIDENCE_REQUIRED' && !report.held.some(row => row.note_id === target.id))
          report.held.push({ target: label, note_id: target.id, reason: 'LOCALLY_TRUSTED' });
      }
    }
    if (result.unchanged) report.notes.unchanged += 1; else report.notes[counted] += 1;
    have = new Map(inspectNoteHistory(key.kind === 'stack' ? ctx.stack_facts : ctx.operations[key.op], label).records
      .filter(item => item.provenance?.imported?.source === origin.location).map(item => [item.provenance.imported.note, item]));
  }
  // An imported note that is active here but no longer active in the source,
  // with no upstream replacement to follow, is left alone and named.
  const active = new Set(history.active.map(record => record.id));
  for (const [id, record] of have) if (!record.superseded && !active.has(id)) report.no_longer_upstream.push({ target: label, note_id: record.id });
}

function planStackImport(root, source, stack, localName, at) {
  const read = readSourceStack(stack);
  if (!validStackName(localName)) fail('STACK_NAME_INVALID', 'Stack names use 1–63 lowercase letters, digits or hyphens, beginning with a letter or digit; suites is reserved.');
  assertWritableStack(localName);
  const relativeFolder = posix.join(LAYOUT.collection, localName), folder = join(root, relativeFolder);
  const origin = { location: source.location, commit: source.commit, at, stack: stack.name };
  const exists = existsSync(join(folder, STACK_CONFIG_BASENAME));
  const record = { v: 1, source: source.location, stack: stack.name, ...(source.ref ? { ref: source.ref } : {}),
    ...(source.commit ? { commit: source.commit } : {}), first_imported_at: at, imported_at: at };
  const report = { stack: localName, from: stack.name, action: exists ? 'update' : 'import', folder: relativeFolder, files: [],
    environments: Object.keys(read.document.environments), env_file_removed: [], operations: 0,
    notes: { added: 0, updated: 0, retired: 0, unchanged: 0 }, evidence_unavailable: 0, skipped: [], held: [], no_longer_upstream: [], not_imported: [] };
  let base, snapshot = null, document = null;
  const scope = exists ? stackScope(root, { stack: localName }) : null;
  if (exists) {
    snapshot = withStackScope(scope, () => loadContextSnapshot(root));
    const prior = snapshot?.ctx?.[IMPORT_RECORD_KEY];
    if (!object(prior) || prior.source !== source.location || prior.stack !== stack.name)
      fail('STACK_EXISTS', `Stack '${localName}' already exists here and was not imported from this source; nothing was written.`,
        { local_stack: localName, next: `Import it under another name: ${POINTER_CLI_NAME} stack import <source> --stack ${stack.name} --as <name>` });
    base = snapshot.ctx;
    Object.assign(record, { first_imported_at: prior.first_imported_at ?? at });
    if (read.contracts.size && [...read.contracts].some(([path, bytes]) => {
      try { return !readFileSync(join(folder, path)).equals(bytes); } catch { return true; }
    })) report.not_imported.push('contract (changed in the source; the local contract is kept)');
  } else {
    if (existsSync(folder) && readdirSync(folder).length)
      fail('STACK_EXISTS', `${relativeFolder} already holds files that are not a stack; nothing was written.`, { local_stack: localName, next: 'Choose another name with --as <name>.' });
    const local = localDocument(read.document, localName);
    document = local.document; report.env_file_removed = local.envFileRemoved;
    validateStackDocument(root, folder, localName, document);
    assertSafeStackPath(folder, true);
    base = inventory(root, stack, localName, document);
    report.files = [...[...read.contracts.keys()].map(path => posix.join(relativeFolder, path)),
      posix.join(relativeFolder, STACK_CONFIG_BASENAME), posix.join(relativeFolder, CONTEXT_BASENAME)];
  }
  const next = structuredClone(base);
  const knowledge = read.knowledge ?? { operations: {} };
  if (Object.hasOwn(knowledge, 'stack_facts')) mergeNotes(next, { kind: 'stack' }, 'the stack facts', knowledge.stack_facts, origin, report);
  for (const [op, entry] of Object.entries(knowledge.operations)) {
    if (!object(entry)) noteRefusal('NOTE_HISTORY_INVALID', 'an operation', stack.name);
    if (Array.isArray(entry.notes) && entry.notes.length || entry.note_replacements?.length) mergeNotes(next, { kind: 'operation', op }, op, entry, origin, report);
    if (entry.verified_at || object(entry.fields) && Object.keys(entry.fields).length) report.learned = (report.learned ?? 0) + 1;
    if (entry.note_reviews?.length) report.reviews = (report.reviews ?? 0) + entry.note_reviews.length;
  }
  for (const key of Object.keys(knowledge)) if (!['v', 'api', 'generated_at', 'operations', 'stack_facts', IMPORT_RECORD_KEY].includes(key)) report.not_imported.push(key);
  if (report.env_file_removed.length) report.not_imported.push(`envFile (${report.env_file_removed.join(', ')})`);
  if (report.learned) report.not_imported.push(`learned shapes and verification state (${report.learned} operations)`);
  if (report.reviews) report.not_imported.push(`review decisions (${report.reviews})`);
  delete report.learned; delete report.reviews;
  const changed = report.notes.added + report.notes.updated + report.notes.retired > 0;
  if (!exists || changed || base[IMPORT_RECORD_KEY]?.commit !== record.commit || base[IMPORT_RECORD_KEY]?.ref !== record.ref) next[IMPORT_RECORD_KEY] = record;
  // Seal and check the planned histories now, so a refusal comes before any write.
  protectContextNoteHistory(structuredClone(base), next);
  if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`) > MAX_CONTEXT_BYTES)
    fail('CONTEXT_CAPACITY_REACHED', `Stack '${stack.name}' would exceed the 16 MiB knowledge limit; nothing was written.`, { local_stack: localName });
  report.operations = Object.keys(next.operations).length;
  const write = !exists || JSON.stringify(next) !== JSON.stringify(base);
  if (exists && write) report.files = [posix.join(relativeFolder, CONTEXT_BASENAME)];
  return { report, exists, write, folder, relativeFolder, localName, document, contracts: read.contracts, next, digest: snapshot?.digest };
}

/** Validate everything and decide every write. Writes nothing. */
export function planImport(root, source, { stacks = [], all = false, as } = {}) {
  root = resolve(root);
  const refusal = stacksMigrationRequired(root);
  if (refusal) fail(refusal.code, refusal.message, { next: refusal.command });
  const catalog = stackCatalog(root);
  if (catalog.problems.length) { const first = catalog.problems[0]; fail(first.code, first.message, { next: first.next }); }
  if (!validNoteImport({ source: source.location, at: today(), note: `sha256:${'0'.repeat(64)}` }))
    fail('STACK_IMPORT_SOURCE_INVALID', 'The source location cannot be recorded in committed files; use a plain URL or a path near this repository.');
  const names = source.stacks.map(stack => stack.name);
  for (const name of stacks) if (!names.includes(name))
    fail('STACK_NOT_FOUND', `The source has no stack named '${name}'. It holds: ${names.join(', ')}.`, { available: names });
  if (all && stacks.length) fail('STACK_ARGUMENT_INVALID', 'Choose --all or --stack, not both.');
  const selected = all ? source.stacks : stacks.length ? source.stacks.filter(stack => stacks.includes(stack.name))
    : source.stacks.length === 1 ? source.stacks : null;
  if (!selected) fail('STACK_SELECTION_REQUIRED', `The source holds ${names.length} stacks: ${names.join(', ')}. Nothing was written.`,
    { available: names, next: `Choose with --stack <name> (repeatable) or --all.` });
  if (as !== undefined && selected.length !== 1) fail('STACK_ARGUMENT_INVALID', '--as renames one imported stack; select exactly one.');
  const at = today();
  const plans = selected.map(stack => planStackImport(root, source, stack, as ?? stack.name, at));
  // The first knowledge write in a repository also creates the managed
  // directory's own files, as `stack add` does. Name them in the receipt.
  const layout = plans.some(item => item.write) ? planLayout(root).files
    .filter(({ path, content }) => !existsSync(join(root, path)) || readFileSync(join(root, path), 'utf8') !== content).map(({ path }) => path) : [];
  return { root, plans, layout, source: { kind: source.kind, location: source.location, ...(source.ref ? { ref: source.ref } : {}), commit: source.commit ?? null } };
}

/** Write a plan. Each stack's knowledge is one locked, atomic save. */
export function applyImport(plan) {
  const { root } = plan;
  let scope = null;
  for (const item of plan.plans) {
    if (!item.exists) {
      mkdirSync(item.folder, { recursive: true });
      for (const [path, bytes] of item.contracts) {
        mkdirSync(dirname(join(item.folder, path)), { recursive: true });
        writeOutputFileAtomic(join(item.folder, path), bytes, { code: 'STACK_UNSAFE_PATH' });
      }
      writeOutputFileAtomic(join(item.folder, STACK_CONFIG_BASENAME), `${JSON.stringify(item.document, null, 2)}\n`, { code: 'STACK_UNSAFE_PATH' });
    }
    scope = stackScope(root, { stack: item.localName });
    if (item.write) withStackScope(scope, () => saveContext(root, item.next, item.exists ? { expectedDigest: item.digest } : {}));
  }
  return { scope };
}

export function importReceipt(plan, { dryRun = false } = {}) {
  return { dry_run: dryRun, requests_executed: 0, source: plan.source, stacks: plan.plans.map(item => item.report), layout_files: plan.layout };
}

/** The import record of a local stack's knowledge document, or null. */
export function importRecord(ctx) {
  const record = ctx?.[IMPORT_RECORD_KEY];
  return object(record) && typeof record.source === 'string' ? record : null;
}
