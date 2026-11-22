// One lookup by topic, for a question asked without a call. It takes text and
// no operation, searches every kind of saved note the repository holds and the
// registered reference files, and returns bounded, labelled matches. It reads
// local files only: it sends no request and changes no file.
import { POINTER_CLI_NAME } from './brand.mjs';
import { loadContext } from './context.mjs';
import { inspectNoteHistory } from './note-history.mjs';
import { noteDates } from './note-confirmations.mjs';
import { rankNoteRecords, projectKnownNotes } from './evidence-confidence.mjs';
import { loadNoteReadContext } from './note-read-model.mjs';
import { NOTE_DATA_MEANING, noteDataText } from './note-projection.mjs';
import { stackFactsProjection } from './stack-facts.mjs';
import { stackCatalog, stackScope } from './stacks.mjs';
import { withStackScope } from './stack-scope.mjs';
import { secretIn } from './verdicts.mjs';
import { searchReferences, matchesTerms, matchedWordCount, REFERENCE_MEANING } from './references.mjs';

// Words a question carries that say nothing about its topic.
const FUNCTION_WORDS = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'what', 'which', 'who', 'whom', 'whose', 'how', 'why', 'when', 'where',
  'does', 'did', 'doing', 'have', 'has', 'had', 'know', 'about', 'with', 'that', 'this', 'these', 'those', 'from', 'into', 'our', 'ours', 'your',
  'their', 'there', 'then', 'than', 'can', 'could', 'would', 'should', 'will', 'shall', 'any', 'all', 'not', 'but', 'you', 'they', 'them', 'its',
  'been', 'being', 'some', 'tell', 'please', 'saved', 'notes', 'note', 'there', 'here', 'just', 'also', 'like', 'get', 'use', 'used', 'using']);
import { loadRegistry, providersFor } from './registry.mjs';
import { LAYOUT } from './layout.mjs';
import { printableOperationKey } from './note-pointers.mjs';
import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

// What the lookup does not read, so an empty answer is not taken for
// "nothing is saved anywhere": granted providers' stores and private account
// facts (reading those can write credential confirmation state).
function notSearched(root, stacks) {
  const out = {};
  try {
    const { registry } = loadRegistry();
    const base = realpathSync(root);
    const consumer = Object.entries(registry.repos ?? {}).find(([, repo]) => { try { return realpathSync(repo.root) === base; } catch { return false; } });
    const granted = consumer ? providersFor(registry, consumer[0]).length : 0;
    if (granted) out.granted_providers = granted;
  } catch { /* no readable machine registry: no grants to name */ }
  const withPrivate = stacks.filter(stack => {
    try { return readdirSync(join(root, ...LAYOUT.evidence.split('/'), stack, 'account-facts')).some(name => name.endsWith('.json') && !name.endsWith('.confirmation.json')); }
    catch { return false; }
  });
  if (withPrivate.length) out.private_account_facts = withPrivate;
  return Object.keys(out).length ? { ...out, meaning: 'These were not searched. Granted providers are read by requests; private account facts by show --stack <name> --env <name> --scope account.' } : null;
}

export const DEFAULT_TOPIC_RESULTS = 10;
export const MAX_TOPIC_RESULTS = 100;
const MAX_SEARCH = 200;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shellWord = value => /^[A-Za-z0-9_./:-]+$/u.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`;

export function topicError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function validTopicSearch(search) {
  return typeof search === 'string' && search.trim().length > 0 && search.length <= MAX_SEARCH && !CONTROL.test(search);
}

// When the note was written, last confirmed and how many times, from the
// saved history record, under the names the operation lookup uses.
function datesOf(entry, history, record) {
  const saved = history?.records?.find(row => row.id === record.id) ?? record;
  return noteDates(entry, saved);
}
function noteMatch(record, extra, dates) {
  // A retirement names the identity it retires, never the retired claim's text.
  const retires = (record.retirement ?? []).map(item => item.note_id);
  return { ...extra, note_id: record.id, text: record.text, review: record.review?.label ?? 'unreviewed',
    evidence_class: record.evidence_class?.class ?? 'written', ...dates,
    label: noteDataText({ ...record, retirement: undefined }) + (retires.length ? `; retires ${retires.join(', ')}` : '') };
}

// Every saved note in one store, flattened to candidates with the fields the
// lookup returns. Histories that need review are skipped and counted, as the
// request path skips them.
// A stored operation key the instruction block withholds (printableOperationKey)
// is withheld here too: its matches are not returned, and the distinct keys
// are counted in withheld_operations.
function storeCandidates(root, ctx, stack) {
  const rows = [], issues = [];
  if (!ctx) return { rows, issues };
  const unprintable = new Set();
  const issue = (row) => {
    if (row.operation === undefined || printableOperationKey(row.operation)) return issues.push(row);
    unprintable.add(row.operation);
    const { operation: _withheld, ...rest } = row;
    return issues.push({ ...rest, operation_withheld: true });
  };
  const noteRead = loadNoteReadContext(root, ctx, { runRequests: false });
  for (const [operation, entry] of Object.entries(object(ctx.operations) ? ctx.operations : {})) {
    let projected;
    try { projected = projectKnownNotes(entry, noteRead.forOperation(operation)); }
    catch { issue({ stack, operation, code: 'NOTE_HISTORY_INVALID' }); continue; }
    if (['invalid', 'changed'].includes(projected.history.state)) issue({ stack, operation, code: 'NOTE_HISTORY_INVALID' });
    const withheld = printableOperationKey(operation) ? null : operation;
    for (const record of projected.records)
      rows.push({ haystack: `${operation}\n${record.text}`, withheld, match: noteMatch(record, { kind: 'operation-note', stack, operation }, datesOf(entry, projected.history, record)) });
  }
  const facts = stackFactsProjection(ctx, { stack: stack ?? undefined, maxFacts: Infinity });
  if (['invalid', 'changed'].includes(facts.history.state)) issues.push({ stack, code: 'NOTE_HISTORY_INVALID', scope: 'stack' });
  for (const record of rankNoteRecords(facts.records, { history: facts.history, entry: ctx.stack_facts })) {
    const operations = record.provenance?.operations;
    const named = Array.isArray(operations) ? operations.filter(op => printableOperationKey(op)) : operations;
    const hidden = Array.isArray(operations) ? operations.filter(op => !printableOperationKey(op)) : [];
    rows.push({ haystack: record.text, hidden, match: noteMatch(record, { kind: 'stack-fact', stack,
      applies_to: operations?.length ? named : 'every operation in this stack',
      ...(hidden.length ? { applies_to_withheld: hidden.length } : {}) }, datesOf(ctx.stack_facts, facts.history, record)) });
  }
  // Only account facts saved into the shared store are searched. Private
  // account facts stay with their credential confirmation and `show --scope account`.
  for (const entry of Object.values(object(ctx.account_facts) ? ctx.account_facts : {})) {
    if (!object(entry)) continue;
    const history = inspectNoteHistory(entry, 'account');
    if (['invalid', 'changed'].includes(history.state)) { issues.push({ stack, code: 'NOTE_HISTORY_INVALID', scope: 'account' }); continue; }
    for (const record of rankNoteRecords(history.active, { history, entry }))
      rows.push({ haystack: record.text, match: noteMatch(record, { kind: 'account-fact', stack,
        environment: typeof entry.environment === 'string' ? entry.environment : null,
        credential_reference: typeof entry.credential_reference === 'string' ? entry.credential_reference : null }, datesOf(entry, history, record)) });
  }
  for (const entry of Object.values(object(ctx.api_context?.operations) ? ctx.api_context.operations : {})) {
    if (!object(entry?.identity) || !Array.isArray(entry.observations)) continue;
    const { operation, provider, protocol, environment } = entry.identity;
    if ([operation, provider, protocol, environment].some(value => typeof value !== 'string')) continue;
    for (const observation of entry.observations) {
      if (observation?.basis !== 'authored' || !Array.isArray(observation.notes)) continue;
      for (const note of observation.notes) {
        if (typeof note !== 'string') continue;
        rows.push({ haystack: `${operation}\n${note}`, withheld: printableOperationKey(operation) ? null : operation, match: { kind: 'observation-lesson', stack, operation, provider, protocol, environment,
          text: note, review: 'unreviewed', evidence_class: 'written', label: 'Scoped authored lesson; unverified.' } });
      }
    }
  }
  return { rows, issues, unprintable };
}

/**
 * search: text (every whitespace-separated word must appear, case-insensitive).
 * stack: optional; limits notes and stack-bound references to that stack.
 */
export function lookupTopic(root, { search, stack, limit = DEFAULT_TOPIC_RESULTS, cli = POINTER_CLI_NAME } = {}) {
  if (!validTopicSearch(search)) throw topicError('TOPIC_SEARCH_INVALID', `Give search text of 1 to ${MAX_SEARCH} characters on one line.`);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TOPIC_RESULTS)
    throw topicError('TOPIC_LIMIT_INVALID', `The result limit must be a whole number from 1 to ${MAX_TOPIC_RESULTS}.`);
  if (stack !== undefined && (typeof stack !== 'string' || !STACK_NAME.test(stack))) throw topicError('STACK_NOT_FOUND', 'The named stack does not exist.');
  const words = search.toLowerCase().split(/\s+/u).filter(Boolean);
  const catalog = stackCatalog(root);
  if (catalog.problems.length) throw Object.assign(new Error(catalog.problems[0].message), { code: catalog.problems[0].code ?? 'STACK_CATALOG_INVALID' });
  const names = catalog.stacks.map(row => row.name).sort();
  if (stack !== undefined && !names.includes(stack)) throw topicError('STACK_NOT_FOUND', 'The named stack does not exist.');
  const stores = names.length ? (stack !== undefined ? [stack] : names).map(name => {
    const scope = stackScope(root, { stack: name });
    return withStackScope(scope, () => ({ stack: name, ...storeCandidates(root, loadContext(root), name) }));
  }) : [{ stack: null, ...storeCandidates(root, loadContext(root), null) }];
  const issues = stores.flatMap(store => store.issues);
  const notes = stores.flatMap(store => store.rows);
  let withheldNotes = 0;
  // Distinct unprintable keys, per store, among matches and issues.
  let withheldKeys = new Set(stores.flatMap(store => [...store.unprintable].map(op => `${store.stack}\u0000${op}`)));
  const issueKeys = withheldKeys;
  const collect = keep => {
    const out = [];
    withheldKeys = new Set(issueKeys);
    for (const row of notes) {
      const extra = keep(row.haystack);
      if (!extra) continue;
      for (const op of row.hidden ?? []) withheldKeys.add(`${row.match.stack}\u0000${op}`);
      if (row.withheld !== undefined && row.withheld !== null) { withheldKeys.add(`${row.match.stack}\u0000${row.withheld}`); continue; }
      if (secretIn(JSON.stringify(row.match), { allowAuthReferences: true })) { withheldNotes++; continue; }
      out.push(extra === true ? row.match : { ...row.match, ...extra });
    }
    return out;
  };
  let noteMatches = collect(haystack => matchesTerms(haystack, words));
  let references = searchReferences(root, search, { stack });
  let all = [...noteMatches, ...references.matches];
  // A question in ordinary words rarely has every word in one note. When no
  // entry holds every word, fall back to entries holding some of the content
  // words, ranked by how many distinct ones they hold, and say so.
  let mode = 'all-words';
  const content = [...new Set(words.map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')))]
    .filter(word => word.length >= 3 && !FUNCTION_WORDS.has(word));
  if (!all.length && content.length) {
    withheldNotes = 0;
    noteMatches = collect(haystack => { const count = matchedWordCount(haystack, content); return count ? { matched_words: count } : false; });
    const fallbackReferences = searchReferences(root, search, { stack, someWords: content });
    references = { ...fallbackReferences, registry_problems: references.registry_problems };
    all = [...noteMatches, ...references.matches]
      .map((match, index) => ({ match, index })).sort((a, b) => b.match.matched_words - a.match.matched_words || a.index - b.index).map(row => row.match);
    if (all.length) mode = 'some-words';
  }
  const shown = all.slice(0, limit);
  const omitted = all.length - shown.length;
  const rest = `${cli} context search ${shellWord(search)}${stack ? ` --stack ${stack}` : ''} --limit ${Math.min(MAX_TOPIC_RESULTS, all.length)}`;
  const skipped = notSearched(root, stores.map(store => store.stack).filter(Boolean));
  return {
    v: 1, search, stack: stack ?? null,
    match_mode: mode,
    ...(mode === 'some-words' ? { match_mode_meaning: `No saved entry contained every word; these contain some of: ${content.join(', ')}. Ranked by how many distinct words each contains (matched_words).` } : {}),
    meaning: NOTE_DATA_MEANING,
    reference_meaning: REFERENCE_MEANING,
    searched: { notes: notes.length, references: references.searched, stacks: stores.map(store => store.stack).filter(Boolean) },
    total: all.length, shown: shown.length, omitted,
    ...(omitted ? { rest_command: rest } : {}),
    ...(all.length > MAX_TOPIC_RESULTS ? { beyond_limit: all.length - MAX_TOPIC_RESULTS,
      beyond_limit_meaning: `More matches exist than the largest --limit (${MAX_TOPIC_RESULTS}) returns; narrow the search text${stack ? '' : ' or add --stack <name>'} to reach them.` } : {}),
    matches: shown,
    ...(withheldNotes ? { withheld_notes: withheldNotes } : {}),
    ...(withheldKeys.size ? { withheld_operations: withheldKeys.size,
      withheld_operations_meaning: 'Saved operations whose stored key is unsafe to repeat (a line break, a control or zero-width character, a credential or a machine path) are not listed; find them in the knowledge file.' } : {}),
    ...(references.missing.length ? { missing_references: references.missing } : {}),
    ...(references.unavailable.length ? { unavailable_references: references.unavailable } : {}),
    ...(references.registry_problems.length ? { reference_registry_problems: references.registry_problems } : {}),
    ...(skipped ? { not_searched: skipped } : {}),
    ...(issues.length ? { issues } : {}),
    one_operation: names.length ? `${cli} show --stack <name> "<METHOD /path>"` : `${cli} show "<METHOD /path>"`,
    requests_executed: 0,
  };
}

