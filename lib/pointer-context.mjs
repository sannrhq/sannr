// The managed block is another view of the same authored records. It carries
// bounded, scoped claims, never upgrades them to execution evidence, and never
// assumes that a manifest alone registered an optional MCP capability.
import { accessSync, constants, realpathSync, existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';

import { blockCode } from './block-text.mjs';
import { graphRecordTool } from './graph-record.mjs';
import { scanMetadataSecrets } from './verdicts.mjs';
import { installedMcpLaunch, pinnedMcpPackage } from './advertisement.mjs';
import { POINTER_CLI_NAME } from './brand.mjs';
import { inspectNoteHistory, loadContext } from './context.mjs';
import { stackEvidenceClasses, formatEvidenceClasses, rankNoteRecords } from './evidence-confidence.mjs';
import { projectKnownNotes } from './evidence-confidence.mjs';
import { loadNoteReadContext } from './note-read-model.mjs';
import { NOTE_DATA_MEANING } from './note-projection.mjs';
import { stackFactsProjection } from './stack-facts.mjs';
import { currentStackScope, withStackScope } from './stack-scope.mjs';
import { stackCatalog, stackScope } from './stacks.mjs';
import { importedTestClaimCounts } from './imported-test-claims.mjs';
import { loadReferences, REFERENCES_FILE } from './references.mjs';
import { SETUP_BINDING_ENV, setupBindingId, validSetupBinding } from './setup-binding.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function executableIdentity(command, cwd, env) {
  if (typeof command !== 'string' || !command) return null;
  const candidates = isAbsolute(command) || /[\\/]/u.test(command) ? [resolve(cwd, command)]
    : (env.PATH ?? '').split(delimiter).map(directory => resolve(cwd, directory || '.', command));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); }
    catch { continue; }
    // The first executable is what the host launches. A later Node entry in
    // PATH must not excuse an earlier executable with the same command name.
    try { return realpathSync(candidate); }
    catch { return null; }
  }
  return null;
}

export function registeredContextTools(root, registrations, serverPath) {
  const available = { read: false, record: false };
  let canonicalRoot, canonicalServer, nodePath;
  try { canonicalRoot = realpathSync(root); canonicalServer = realpathSync(serverPath); nodePath = realpathSync(process.execPath); }
  catch { return available; }
  const pinnedLaunch = installedMcpLaunch(dirname(canonicalServer));
  const packageSpec = pinnedMcpPackage(pinnedLaunch);
  const npxPath = packageSpec ? executableIdentity(pinnedLaunch.command, root,
    { ...process.env, ...pinnedLaunch.env }) : null;
  for (const registration of registrations) {
    if (registration.code || typeof registration.command !== 'string'
      || !Array.isArray(registration.args)) continue;
    const env = { ...process.env, ...registration.env };
    if (env.API_CONTEXT_OFF === '1') continue;
    try {
      const cwd = resolve(root, registration.cwd ?? '.');
      if (realpathSync(resolve(cwd, env.API_CONTEXT_DIR ?? '.')) !== canonicalRoot) continue;
      const registeredPackage = pinnedMcpPackage(registration);
      if (registeredPackage) {
        if (!packageSpec || registeredPackage !== packageSpec || !npxPath ||
            executableIdentity(registration.command, cwd, env) !== npxPath ||
            !validSetupBinding(registration.env?.[SETUP_BINDING_ENV]) ||
            setupBindingId(root, { command: registration.command, args: registration.args, env: registration.env }) !== registration.env[SETUP_BINDING_ENV]) continue;
      } else if (registration.args.length !== 1 || typeof registration.args[0] !== 'string' ||
          executableIdentity(registration.command, cwd, env) !== nodePath ||
          realpathSync(resolve(cwd, registration.args[0])) !== canonicalServer) continue;
      // This is the exact write-tool configuration check, with no process,
      // request, catalog delivery, or metrics side effect. A broken manifest
      // never earns workflow instructions merely because its filename exists.
      if (!graphRecordTool(root, { env })) continue;
      available.read = true;
      if (env.API_REQUEST_READ_ONLY !== '1') available.record = true;
    } catch { /* Missing or unsafe local configuration advertises no tools. */ }
  }
  return available;
}

// The managed block says what saved knowledge exists and how to fetch it; it
// carries none of the knowledge. Saved notes, stack facts and inherited
// lessons reach an agent with the call that needs them (`known`) or through
// one lookup by topic. Only operation identifiers and counts are listed here.
export const MAX_INDEXED_OPERATIONS = 20;
export const MAX_TOTAL_INDEXED_OPERATIONS = 60;

// Authored lessons on scoped observations, counted per operation identifier.
// The text is never read into the block.
export function inheritedLessonCounts(ctx) {
  const counts = new Map();
  if (!object(ctx?.api_context?.operations)) return counts;
  for (const entry of Object.values(ctx.api_context.operations)) {
    if (!object(entry?.identity) || typeof entry.identity.operation !== 'string' || !Array.isArray(entry.observations)) continue;
    for (const observation of entry.observations) {
      if (observation?.basis !== 'authored' || !Array.isArray(observation.notes)) continue;
      const count = observation.notes.filter(note => typeof note === 'string').length;
      if (count) counts.set(entry.identity.operation, (counts.get(entry.identity.operation) ?? 0) + count);
    }
  }
  return counts;
}

// Operation identifiers are structured contract identity, but they come from
// files the product does not control: the same guards as any inline text.
function safeIdentifier(value, containsMachineLocalPath) {
  // Control and format characters (bidirectional overrides included) can make
  // an identifier read as something else; it is withheld and counted.
  if (typeof value !== 'string' || !value || /[\p{Cc}\p{Cf}]/u.test(value) || containsMachineLocalPath(value)) return false;
  try { scanMetadataSecrets(value, 'POINTER_INDEX_UNSAFE'); return true; }
  catch { return false; }
}

/** Counts and a bounded index of the operations that hold saved notes or
 * lessons, for one store. Returns rendered lines; no note text. */
export function renderNoteIndex(ctx, { noteCounts, containsMachineLocalPath, listCommand, listFile, budget, heading = '**Operations with saved notes or lessons**' }) {
  const lessons = inheritedLessonCounts(ctx);
  const perOperation = new Map();
  for (const [op, count] of noteCounts) if (count) perOperation.set(op, { notes: count, lessons: 0 });
  for (const [op, count] of lessons) perOperation.set(op, { notes: perOperation.get(op)?.notes ?? 0, lessons: count });
  const rows = [...perOperation.entries()].sort(([a], [b]) => a.localeCompare(b));
  const safe = rows.filter(([op]) => safeIdentifier(op, containsMachineLocalPath));
  const withheld = rows.length - safe.length;
  const noteTotal = rows.reduce((sum, [, row]) => sum + row.notes, 0);
  const lessonTotal = rows.reduce((sum, [, row]) => sum + row.lessons, 0);
  if (!rows.length) return [];
  const list = listCommand ? `\`${listCommand}\`` : listFile ? `\`context search\` for a topic, or read their operation keys in \`${listFile}\`` : 'the repo-local `show` command, once installed';
  const limit = Math.max(0, Math.min(MAX_INDEXED_OPERATIONS, budget?.remaining ?? MAX_INDEXED_OPERATIONS));
  const shown = safe.slice(0, limit);
  const lines = [`Saved operation notes: ${noteTotal}; scoped observation lessons: ${lessonTotal}; on ${rows.length} operation${rows.length === 1 ? '' : 's'}.`, '',
    `${heading} (count each; text not shown here):`, ''];
  for (const [op, row] of shown) lines.push(`- \`${blockCode(op)}\` (${row.notes + row.lessons})`);
  const omitted = safe.length - shown.length;
  if (omitted) lines.push(`- ${omitted} more operation${omitted === 1 ? '' : 's'} with notes omitted (index cap ${MAX_INDEXED_OPERATIONS}${limit < MAX_INDEXED_OPERATIONS ? `; total cap ${MAX_TOTAL_INDEXED_OPERATIONS}` : ''}); ${listFile && !listCommand ? 'find them with' : 'list them with'} ${list}.`);
  if (withheld) lines.push(`- ${withheld} operation${withheld === 1 ? '' : 's'} with notes not listed because the identifier is unsafe to repeat here; ${listFile && !listCommand ? 'find them with' : 'list them with'} ${list}.`);
  if (budget) budget.remaining -= shown.length;
  return [...lines, ''];
}

// Stacks provide isolation around the index; its bounds count operations, not
// output bytes.
export function renderStackContext(root, plannedContext, { portable, containsMachineLocalPath, renderMcp = () => [] } = {}) {
  const catalog = stackCatalog(root);
  if (!catalog.stacks.length) return null;
  if (catalog.problems.length) {
    const error = catalog.problems[0];
    throw Object.assign(new Error(error.message), error);
  }
  const selected = currentStackScope()?.stack;
  const ordered = [...catalog.stacks].sort((a, b) =>
    a.name === catalog.defaults.default_stack ? -1 : b.name === catalog.defaults.default_stack ? 1 : a.name.localeCompare(b.name));
  const budget = { remaining: MAX_TOTAL_INDEXED_OPERATIONS };
  const lines = portable ? [] : ['Install the repo-local CLI before using the scoped commands below.', ''];
  for (const row of ordered) {
    const scope = stackScope(root, { stack: row.name, environment: row.document.default_environment });
    withStackScope(scope, () => {
      // connect/learn plan their pointer and knowledge writes together. Read
      // siblings from disk but use the selected stack's planned bytes here.
      const ctx = row.name === selected && plannedContext ? plannedContext : loadContext(root);
      const command = `${portable ?? POINTER_CLI_NAME} show --stack ${row.name}`;
      const environments = [...row.environmentNames].sort();
      const contract = scope.config.contract;
      const contractState = contract ? existsSync(contract) ? 'bound' : 'missing' : 'not_bound';
      const contractStates = environments.map(environment => {
        const path = stackScope(root, { stack: row.name, environment }).config.contract;
        return { environment, state: path ? existsSync(path) ? 'bound' : 'missing' : 'not_bound' };
      });
      const confidence = stackEvidenceClasses(root, ctx ?? {}, { commits: true });
      const operationCount = confidence.operations.size;
      // Committed instructions carry the decision, not the private inbox status.
      const noteRead = loadNoteReadContext(root, ctx, { runRequests: false });
      const noteCounts = new Map(Object.entries(ctx?.operations ?? {}).map(([op, entry]) => [op, projectKnownNotes(entry, noteRead.forOperation(op)).records.length]));
      const stackFacts = stackFactsProjection(ctx, { stack: row.name, maxFacts: Infinity });
      const contradictions = [...confidence.operations.values()].flatMap(operation => {
        const scopedFacts = stackFacts.records.filter(record => !record.provenance?.operations
          || record.provenance.operations.includes(operation.operation));
        const history = inspectNoteHistory(operation.entry, operation.operation);
        const basis = { summary: operation.summary, freshness: operation.freshness };
        return [...rankNoteRecords(scopedFacts, basis),
          ...rankNoteRecords(history.active, { ...basis, history })].filter(record => record.contradictions.length).map(record => ({ operation: operation.operation,
          kinds: record.contradictions }));
      });
      const factCount = stackFacts.history.active.length;
      const lifecycle = operationCount && confidence.counts.observed + confidence.counts.asserted + confidence.counts.verified === 0
        ? 'No current response, passing assertion or learn verification is counted.'
        : 'This is the current committed knowledge and retains its execution evidence.';
      lines.push(`### Stack \`${row.name}\``, '',
        `Environments: ${environments.length ? environments.map(name => `\`${blockCode(name)}\``).join(', ') : 'none'}. Contract: ${contractState}${row.document.default_environment ? ` (default environment \`${blockCode(row.document.default_environment)}\`)` : ''}.`,
        ...(contractStates.some(state => state.state !== contractState) ? [
          `Contract by environment: ${contractStates.map(({ environment, state }) => `\`${blockCode(environment)}\`: ${state}`).join('; ')}.`,
        ] : []), '',
        `API knowledge for this service is in \`${scope.contextFile}\` — ${operationCount} operation${operationCount === 1 ? '' : 's'}; ${formatEvidenceClasses(confidence.counts)}. ` +
        'It records learned response shapes, field values allowed by the contract, and how recently every execution-derived claim was checked. ' + lifecycle, '');
      if (!ctx) lines.push(`No saved knowledge yet. Read \`${command}\` for this stack's current state.`, '');
      if (row.name === 'unsorted') lines.push(`${operationCount} operation${operationCount === 1 ? '' : 's'} awaiting a destination stack. Re-file with \`${portable ?? POINTER_CLI_NAME} stack move --to <stack> "<METHOD /path>"\`.`, '');
      const testCounts = ctx ? importedTestClaimCounts(ctx) : { total: 0 };
      if (testCounts.total) lines.push(`${testCounts.total} claims from imported tests are stored separately in \`imported_test_claims\`; they are not included in the verified-operation count. Read their source, conditions and individual execution evidence before relying on them.`, '');
      for (const item of contradictions.slice(0, 5)) lines.push(`Contradicted authored note for \`${blockCode(item.operation)}\`: ${item.kinds.join(', ')} differs from the latest response. The claim is retained; inspect \`${command}\`.`, '');
      if (contradictions.length > 5) lines.push(`${contradictions.length - 5} more contradiction flags omitted; inspect \`${command}\`.`, '');
      if (factCount) lines.push(`Stack facts: ${factCount} (stack-wide or for listed operations; delivered first with each request they apply to).`, '');
      lines.push(...renderNoteIndex(ctx, { noteCounts, containsMachineLocalPath, listCommand: command, budget }));
      lines.push(...renderMcp(ctx));
    });
  }
  return lines;
}


// How to fetch what the index names, then the registered references by title
// and path. The guidance sentence is the one place the block asks for
// retrieval before advice.
export function renderRetrieval(root, { portable, stacks, containsMachineLocalPath, contextRead = false }) {
  const cli = portable ?? (stacks ? POINTER_CLI_NAME : null);
  const stackFlag = stacks ? ' --stack <name>' : '';
  const lines = ['### Saved notes and references', '',
    'Saved notes are not copied into this file. Before answering a question about an existing integration, and before any write, look up the operation\'s saved context: a write is held when it has notes or its stack has a fact for it (a stack-wide fact covers every operation in the stack).', '',
    `- One operation: MCP \`api_note_context\` with \`operation\`${stacks ? ' and `stack`' : ''}${contextRead ? ', or `api_context`' : ''}; CLI ${cli ? `\`${cli} show${stackFlag} "<METHOD /path>"\`` : 'the repo-local `show` command, once installed'}.`,
    `- A topic, with no operation: MCP \`api_note_context\` with \`search\`${stacks ? ' (optional `stack`)' : ''}; CLI ${cli ? `\`${cli} context search "<text>"${stacks ? ' [--stack <name>]' : ''}\`` : 'the repo-local `context search` command, once installed'}. It searches notes, stack facts, lessons and registered references, and sends no request.`,
    '- A request through the client returns the notes for its operation in `known`.', '',
    NOTE_DATA_MEANING, ''];
  // Only how many references exist and how to list them: a path, like a
  // title, is text a person wrote, and stays out of the file every session loads.
  const registry = loadReferences(root, { tolerant: true });
  if (registry.problems.length) lines.push(`The reference registry \`${REFERENCES_FILE}\` has ${registry.problems.length} problem${registry.problems.length === 1 ? '' : 's'} this version cannot read; the lookup names them.`, '');
  if (!registry.references.length) return lines;
  const count = registry.references.length;
  lines.push(`Registered references: ${count} local file${count === 1 ? '' : 's'} the topic lookup also searches (their paths, titles and text are not shown here; list them with ${cli ? `\`${cli} reference list\`` : 'the repo-local `reference list` command'}).`);
  return [...lines, ''];
}
