// Knowledge is already saved when guidance refresh runs. Keep each existing
// instruction file intact on a failed write, and refuse a concurrent edit.
import { accessSync, constants, existsSync, lstatSync, readFileSync, writeFileSync, statSync, openSync, closeSync, fchmodSync, unlinkSync } from 'node:fs';
import { atomicRenameSync as renameSync } from './atomic-rename.mjs';
import { dirname, basename, join, resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeOutputPath } from './output-path.mjs';

const conflict = () => Object.assign(new Error('The managed instruction file changed during refresh.'), { code: 'POINTER_WRITE_CONFLICT' });

// A later session, or a teammate who never saw the install, learns here what
// "opt out" means (docs/telemetry.md).
function telemetryPointerLine(portable) {
  return `${PROSE_PRODUCT_TITLE} sends usage counts once a day unless turned off; if a person says "opt out", run ` +
    (portable ? `\`${portable} telemetry off\`` : "its `telemetry off` command") + " and show them the output.";
}

export function replaceNotePointer(file, text, { expectedText, beforeCommit } = {}) {
  safeOutputPath(file, { code: 'POINTER_UNSAFE_PATH' });
  if (typeof expectedText !== 'string' || readFileSync(file, 'utf8') !== expectedText) throw conflict();
  const mode = statSync(file).mode & 0o777;
  const temporary = join(dirname(file), `.${basename(file)}.refresh-${randomUUID()}`);
  let written = false;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    written = true;
    writeFileSync(descriptor, text);
    fchmodSync(descriptor, mode);
    closeSync(descriptor);
    descriptor = undefined;
    beforeCommit?.();
    safeOutputPath(file, { code: 'POINTER_UNSAFE_PATH' });
    if (readFileSync(file, 'utf8') !== expectedText) throw conflict();
    renameSync(temporary, file);
    written = false;
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* preserve the original write failure */ }
    if (written) try { unlinkSync(temporary); } catch { /* preserve the original write failure */ }
  }
}

import { fileURLToPath } from 'node:url';
import { PRODUCT, PROSE_PRODUCT_TITLE, MCP_SERVER_KEY, LEGACY_MCP_SERVER_KEYS, POINTER_CLI_NAME, POINTER_POWERSHELL_CLI_NAME, POINTER_BEGIN as BEGIN, POINTER_END as END } from './brand.mjs';
import { LAYOUT } from './layout.mjs';
import { CONTEXT_FILE, loadContextSnapshot, indexOf } from './context.mjs';
import { contextFileFor } from './stack-scope.mjs';
import { POINTER_FILES } from './capabilities.mjs';
import { resolveConfig } from './config.mjs';
import { advertisementPlan } from './advertisement.mjs';
import { discoverMcpRegistrations } from './mcp-registrations.mjs';
import { currentSetupBinding, validSetupBinding } from './setup-binding.mjs';
import { setupGuidance } from './onboarding.mjs';
import { installPointerSentence } from './install-voice.mjs';
import { registeredContextTools, renderStackContext, renderNoteIndex, renderRetrieval, safeIdentifier, MAX_TOTAL_INDEXED_OPERATIONS } from './pointer-context.mjs';
import { renderInlineMcp } from './mcp-delivery.mjs';
import { stackEvidenceClasses, formatEvidenceClassCounts, projectKnownNotes } from './evidence-confidence.mjs';
import { planSetupContract } from './setup-contract.mjs';
import { loadHttpContract } from './http-operation-context.mjs';
import { importedTestClaimCounts } from './imported-test-claims.mjs';
import { assertManagedBody } from './block-text.mjs';
import { loadNoteReadContext } from './note-read-model.mjs';
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CLAUDE_BRIDGE = "@AGENTS.md\n";
const isClaudeBridge = (text) => /^@AGENTS\.md(?:\r?\n)?$/.test(text);

// A CLAUDE.md that imports AGENTS.md (a line that is exactly `@AGENTS.md`,
// outside a fenced code block and outside our own managed block) already loads
// the block from AGENTS.md, so it is written once. Inline code cannot hold the
// exact line, and an indented line is not exact.
export function importsAgents(text) {
  if (typeof text !== "string") return false;
  const start = text.indexOf(BEGIN), finish = text.indexOf(END);
  let outside = start >= 0 && finish > start ? text.slice(0, start) + text.slice(finish + END.length) : text;
  // Conservative: a line inside front matter or an HTML comment is not an
  // import. A duplicate block is the safe failure; a missing one is not.
  const lines = outside.replace(/^\uFEFF/u, "").split("\n").map(raw => raw.replace(/\r$/u, ""));
  let from = 0;
  if (lines[0] === "---") {
    const close = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
    from = close < 0 ? lines.length : close + 1;
  }
  let fence = null, comment = false;
  // After a comment closes, the rest of that line is scanned too: a comment
  // can reopen on the line that closed the previous one.
  const reopens = rest => {
    for (;;) {
      const open = rest.indexOf("<!--");
      if (open < 0) return false;
      const close = rest.indexOf("-->", open + 4);
      if (close < 0) return true;
      rest = rest.slice(close + 3);
    }
  };
  for (const line of lines.slice(from)) {
    if (comment) {
      const close = line.indexOf("-->");
      if (close >= 0) comment = reopens(line.slice(close + 3));
      continue;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && /^ {0,3}(`{3,}|~{3,})\s*$/u.test(line)) fence = null;
      continue;
    }
    if (opener) { fence = opener[1]; continue; }
    if (reopens(line)) { comment = true; continue; }
    if (line === "@AGENTS.md") return true;
  }
  return false;
}

export function pointerPathProblem(root, target) {
  const base = resolve(root), dest = resolve(target);
  if (dest !== base && !dest.startsWith(`${base}${sep}`)) return "pointer path escapes the project";
  let current = base;
  for (const part of relative(base, dest).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      return "pointer path cannot be inspected safely";
    }
    if (stat.isSymbolicLink()) return "pointer path traverses a symbolic link";
    if (current !== dest && !stat.isDirectory()) return "pointer parent is not a directory";
    if (current === dest && (!stat.isFile() || stat.nlink !== 1))
      return "pointer target is not a single-link regular file";
  }
  return null;
}

export function inspectPointerFiles(root) {
  return POINTER_FILES.map((file) => {
    const path = join(root, file);
    const unsafe = pointerPathProblem(root, path);
    if (unsafe) return { file, path, managed: false, problem: unsafe };
    if (!existsSync(path)) return { file, path, managed: false, problem: null };
    const text = readFileSync(path, "utf8");
    const begins = text.split(BEGIN).length - 1, ends = text.split(END).length - 1;
    if (!begins && !ends) return { file, path, managed: false,
      bridge: file === "CLAUDE.md" && (isClaudeBridge(text) || importsAgents(text)), problem: null };
    if (begins !== 1 || ends !== 1 || text.indexOf(END) < text.indexOf(BEGIN))
      return { file, path, managed: true, problem: "managed pointer delimiters are malformed" };
    return { file, path, managed: true, problem: null };
  });
}

// A plan is not complete while a later write can already be proven impossible.
// Check both the final file (when present) and the directory entry needed to
// create/replace it. Mode bits make this deterministic even under a privileged
// test runner; accessSync also catches ACL-based refusal for the current user.
export function writableDestinationProblem(target) {
  try {
    const link = lstatSync(target);
    if (link.isSymbolicLink() || !link.isFile() || link.nlink !== 1)
      return "target is not a single-link regular writable file";
    if ((link.mode & 0o222) === 0) return "target is not writable";
    try { accessSync(target, constants.W_OK); }
    catch { return "target is not writable"; }
  } catch (error) {
    if (error?.code !== "ENOENT") return "target cannot be inspected for writability";
  }

  let parent = dirname(target);
  for (;;) {
    try {
      const directory = statSync(parent);
      if (!directory.isDirectory()) return "nearest existing parent is not a directory";
      // Windows directory modes do not encode traversal permission. W_OK
      // still checks the current user's ACL; POSIX also requires execute bits.
      if ((directory.mode & 0o222) === 0 || (process.platform !== 'win32' && (directory.mode & 0o111) === 0))
        return "nearest existing parent is not writable";
      try { accessSync(parent, constants.W_OK | constants.X_OK); }
      catch { return "nearest existing parent is not writable"; }
      return null;
    } catch (error) {
      if (error?.code !== "ENOENT") return "nearest existing parent cannot be inspected for writability";
      const next = dirname(parent);
      if (next === parent) return "no writable parent exists";
      parent = next;
    }
  }
}

function decodedPathPunctuation(value) {
  let decoded = value;
  const encodedPathPunctuation = /%(?:25|2e|2f|3a|5c)/gi;
  const punctuation = { "25": "%", "2e": ".", "2f": "/", "3a": ":", "5c": "\\" };
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(encodedPathPunctuation,
      (token) => punctuation[token.slice(1).toLowerCase()]);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function quoteWrapperBefore(value, start) {
  // A whitespace run can immediately precede only one URL start, so walking
  // these disjoint runs keeps the complete URL scan linear without a cap.
  let quoteAt = start - 1;
  while (quoteAt >= 0 && /\s/.test(value[quoteAt])) quoteAt -= 1;
  const quote = value[quoteAt];
  if (!/["'`]/.test(quote ?? "")) return undefined;
  let precedingCodePoint = value[quoteAt - 1] ?? "";
  const lastUnit = value.charCodeAt(quoteAt - 1);
  const priorUnit = value.charCodeAt(quoteAt - 2);
  if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff
      && priorUnit >= 0xd800 && priorUnit <= 0xdbff)
    precedingCodePoint = value.slice(quoteAt - 2, quoteAt);
  if (quoteAt === 0 || !/^[\p{L}\p{N}\p{M}_]$/u.test(precedingCodePoint)) return quote;
  return undefined;
}

function withoutHttpUrlSpans(value) {
  const scheme = /\bhttps?:\/\//gi;
  const chunks = [];
  let cursor = 0, match;
  while ((match = scheme.exec(value))) {
    const start = match.index;
    if (start < cursor) continue;
    const wrapper = quoteWrapperBefore(value, start);
    let end = scheme.lastIndex;
    let parentheses = 0, squareBrackets = 0, curlyBraces = 0;
    while (end < value.length) {
      const character = value[end];
      const code = character.charCodeAt(0);
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)
          || /\s/.test(character) || character === "<" || character === ">"
          || character === '"' || character === "`" || character === "\\"
          || character === "|" || (character === "'" && wrapper === "'")) break;
      if (character === "(") parentheses += 1;
      else if (character === ")") {
        if (parentheses === 0) break; // Markdown link delimiter, not URL text.
        parentheses -= 1;
      } else if (character === "[") squareBrackets += 1;
      else if (character === "]") {
        if (squareBrackets === 0) break; // Wrapper delimiter, not URL text.
        squareBrackets -= 1;
      } else if (character === "{") curlyBraces += 1;
      else if (character === "}") {
        if (curlyBraces === 0) break; // Wrapper delimiter, not URL text.
        curlyBraces -= 1;
      }
      end += 1;
    }
    chunks.push(value.slice(cursor, start), " ");
    cursor = end;
    scheme.lastIndex = Math.max(end, scheme.lastIndex);
  }
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

/** Whether a stored operation key may be printed by show --stack and the two
 * topic lookups: no line break, no control or format character (zero-width
 * and direction overrides included) and no credential shape. A key it refuses
 * is withheld and counted there. The machine-path test is no part of this
 * rule: routes under /Users, /home or /tmp are ordinary API routes (SCIM's
 * /Users among them). The instruction block's index keeps its own, stricter
 * rule (safeIdentifier with containsMachineLocalPath). */
export const printableOperationKey = value => safeIdentifier(value, () => false);

export function containsMachineLocalPath(value) {
  if (typeof value !== "string") return false;
  // Decode for detection only, then mask complete URL spans. The source note
  // remains byte-for-byte untouched in the context file and `show` output.
  const prose = withoutHttpUrlSpans(decodedPathPunctuation(value));
  const boundary = String.raw`(?:^|[^A-Za-z0-9_./-])`;
  const posix = new RegExp(boundary +
    String.raw`\/+(?:\.\/)*(?:Users|home|private(?:\/tmp)?|tmp|Volumes|var\/folders)(?=$|[\/\s"'\x60<>()\[\]{}*_,;:!?.])`);
  const drive = new RegExp(boundary + String.raw`[A-Za-z]:[\\/]`, "i");
  const backslashHost = new RegExp(boundary +
    String.raw`\\{2,}[^\\/\s]+(?=$|[\\/\s"'\x60<>()\[\]{}*_,;:!?.])`);
  const uncShare = new RegExp(boundary +
    String.raw`[\\/]{2,}[^\\/\s]+[\\/][^\\/\s]+`);
  const fileUri = /\bfile:(?:[\\/]+|[A-Za-z]:[\\/]|%)/i;
  return fileUri.test(prose) || posix.test(prose) || drive.test(prose)
    || backslashHost.test(prose) || uncShare.test(prose);
}

function renderBlock(ctx, root, commandResolution = advertisementPlan(root), mcpRegistrations = discoverMcpRegistrations(root), { registeredKey: keptKey } = {}) {
  const portable = commandResolution.portable.available
    ? commandResolution.portable.command : null;
  const bindingId = commandResolution.mcp.bindingId ?? currentSetupBinding(root, mcpRegistrations);
  const contextTools = registeredContextTools(root, mcpRegistrations, join(PACKAGE_ROOT, "server.mjs"));
  const registeredKey = [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS].find(key =>
    mcpRegistrations.some(row => row.key === key && !row.code)) ?? keptKey;
  // Host-independent: every teammate's checkout gets the same sentence, and a
  // PowerShell reader (Codex on Windows) learns the form that needs no policy change.
  const powershell = portable === POINTER_CLI_NAME
    ? ["", `In PowerShell, run \`${POINTER_POWERSHELL_CLI_NAME}\` in place of \`${POINTER_CLI_NAME}\`.`] : [];
  const stackLines = renderStackContext(root, ctx, { portable, containsMachineLocalPath,
    renderMcp: stackContext => renderInlineMcp(stackContext, mcpRegistrations, { containsMachineLocalPath }) });
  if (!ctx && !stackLines) return [BEGIN, "", installPointerSentence(), "", setupGuidance(bindingId, portable, registeredKey, { stacks: Boolean(stackLines) }), ...powershell, "", `Project API files: see \`${LAYOUT.readme}\`.`, telemetryPointerLine(portable), "", "## API context", "",
    `No OpenAPI contract was selected for context during setup, so there is no \`${contextFileFor(root, CONTEXT_FILE)}\` yet. The MCP client and installed skills remain available.`,
    portable ? `If a real contract is available, run \`${portable} start --contract <path>\` to enable API notes. Do not invent a contract to complete setup.`
      : "Install the repo-local CLI before adding a real contract and running setup again.",
    "", END].join("\n");
  const rows = ctx ? indexOf(ctx, root) : [];
  const pointerConfig = resolveConfig(root);
  const pointerBinding = planSetupContract(root, pointerConfig, { contextContract: ctx?.api?.contract });
  const grades = stackEvidenceClasses(root, ctx ?? {}, { config: pointerConfig,
    contract: pointerBinding.contract ? loadHttpContract(pointerBinding.contract, { pathPrefix: pointerConfig.contractPathPrefix }) : null,
    commits: false });
  const verified = grades.counts.verified;
  // Committed instructions carry the decision, not the private inbox status.
  const noteRead = loadNoteReadContext(root, ctx, { runRequests: false });
  const gotchas = Object.entries(ctx?.operations ?? {}).flatMap(([op, entry]) =>
    projectKnownNotes(entry, noteRead.forOperation(op)).records.map(record => ({ op, note: record.text, record })));
  const count = `${grades.operations.size} operation${grades.operations.size === 1 ? "" : "s"}; ` +
    formatEvidenceClassCounts(grades.counts);
  const testCounts = ctx ? importedTestClaimCounts(ctx) : { total: 0 };
  const lifecycle = portable
    ? (rows.length && verified === 0 && gotchas.length === 0
      ? `This is a contract-derived inventory and is currently unverified; \`${portable} learn\` records execution-verified knowledge.`
      : `This is the current committed knowledge; \`${portable} learn\` refreshes its execution evidence.`)
    : (rows.length && verified === 0 && gotchas.length === 0
      ? "This is a contract-derived inventory and is currently unverified."
      : "This is the current committed knowledge and retains its execution evidence.");

  const workflow = `For API calls, use the repository-bound \`${commandResolution.mcp.tool}\` tool when registered.`;
  const verbOwner = `is it up / health / verify → \`${commandResolution.mcp.tool}\` tool (when registered), with the relevant endpoint and assertions; never raw-curl this repo's own API.`;
  const lines = [BEGIN, "", installPointerSentence(), "", setupGuidance(bindingId, portable, registeredKey, { stacks: Boolean(stackLines) }), ...powershell, "", `Project API files: see \`${LAYOUT.readme}\`.`, telemetryPointerLine(portable), "", "## API workflow", "",
    workflow,
    verbOwner,
    contextTools.read
      ? "Before discovery, use api_context for the relevant operation/environment and inspect referenced evidence as needed. Saved lessons are scoped claims, not proof of current behavior."
      : "Before discovery, read the relevant saved entries and contract. Saved lessons are scoped claims, not proof of current behavior.",
    "While completing and verifying the requested task, promptly record reusable behavior missing from the contract, or a correction. " +
      (contextTools.record ? "Use api_context_record and prefer the existing observation_id; " : "") +
      `See ${PRODUCT}-write for other evidence and the CLI fallback. Do not duplicate captured response shapes or make extra calls to repair bookkeeping.`,
    ...(contextTools.record ? ["Check the recording receipt: confirm the lesson was saved and, when context.snapshot is configured, snapshot.state is written. Report failed or limited handoffs; use the team's existing Git/CI workflow to deliver the artifact and referenced evidence."] : []),
    ...(portable ? [`Use \`${portable} map .\` when a visual map is needed; use \`${portable} doctor\` for a demonstrated setup or wiring problem. These are not prerequisites for an API task.`] : []),
    "",
    "## API context", "",
    ...(stackLines ?? ["API knowledge for this service is in `" + contextFileFor(root, CONTEXT_FILE) + "` — " + count +
    ". It records learned response shapes, field values allowed by the contract, and how " +
    "recently every execution-derived claim was checked. " +
    (contextTools.read ? "Prefer scoped api_context retrieval. " : "Read the relevant saved entries directly. ") + lifecycle,
    ...(testCounts.total ? [`${testCounts.total} claims from imported tests are stored separately in \`imported_test_claims\`; they are not included in the verified-operation count. Read their source, conditions and individual execution evidence before relying on them.`] : []), ""])];

  if (!stackLines) {
    const noteCounts = new Map(gotchas.reduce((counts, { op }) => counts.set(op, (counts.get(op) ?? 0) + 1), new Map()));
    lines.push(...renderNoteIndex(ctx, { noteCounts, containsMachineLocalPath, budget: { remaining: MAX_TOTAL_INDEXED_OPERATIONS },
      listFile: contextFileFor(root, CONTEXT_FILE) }));
    lines.push(...renderInlineMcp(ctx, mcpRegistrations, { containsMachineLocalPath }));
  }
  lines.push(...renderRetrieval(root, { portable, stacks: Boolean(stackLines), containsMachineLocalPath, contextRead: contextTools.read }));
  // The BINARY the user installed, never `npx <name>`: this block is committed
  // into their repo and read by agents, and sannr is not published to npm yet —
  // so `npx sannr …` in a file we wrote would have an agent fetch and run
  // whatever sits at that name on the registry, on our instruction.
  if (portable)
    lines.push("Regenerate with `" + portable + " learn`. Remove with `" + portable + " unwire`.");
  else
    lines.push("Portable CLI instructions are omitted until the repo-local executable shim is installed.");
  lines.push("", END);
  // Every foreign string above went through blockText/blockCode; this guard
  // refuses the write by name should any path ever bypass them.
  const rendered = lines.join("\n");
  assertManagedBody(rendered.slice(rendered.indexOf(BEGIN) + BEGIN.length, rendered.lastIndexOf(END)), BEGIN, END);
  return rendered;
}

// Idempotent: replaces an existing block rather than appending a second one. We
// hold ourselves to the standard we would want from a tool writing into files we
// curate — delimited, replaceable, removable in one command.
function plannedBlock(path, block) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const begins = existing.split(BEGIN).length - 1;
  const ends = existing.split(END).length - 1;
  if (begins || ends) {
    if (begins !== 1 || ends !== 1 || existing.indexOf(END) < existing.indexOf(BEGIN))
      return { action: "conflict", reason: "managed pointer delimiters are malformed; edited bytes were left untouched" };
    const start = existing.indexOf(BEGIN);
    const finish = existing.indexOf(END, start) + END.length;
    const current = existing.slice(start, finish);
    if (current === block) return { action: "unchanged", text: existing };
    return { action: "updated", text: existing.slice(0, start) + block + existing.slice(finish) };
  }
  const name = path.split("/").pop().replace(".md", "");
  const header = existing ? "" : "# " + name + "\n\n";
  return { action: "created",
    text: header + existing + (existing ? existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n" : "") + block + "\n" };
}

// The import already loads AGENTS.md: remove a managed block an earlier
// version wrote here, and leave every other byte as it is.
function withoutBlock(text) {
  const begins = text.split(BEGIN).length - 1, ends = text.split(END).length - 1;
  if (!begins && !ends) return { action: "unchanged", text };
  if (begins !== 1 || ends !== 1 || text.indexOf(END) < text.indexOf(BEGIN))
    return { action: "conflict", reason: "managed pointer delimiters are malformed; edited bytes were left untouched" };
  const start = text.indexOf(BEGIN), finish = text.indexOf(END, start) + END.length;
  const before = text.slice(0, start), after = text.slice(finish);
  // When the block was the file's end (as an older build appends it), drop
  // the separator with it, so a file an older build keeps re-appending to and
  // this build keeps cleaning is stable rather than one newline longer per cycle.
  // The file's own line ending is kept (CRLF stays CRLF).
  if (/^\s*$/u.test(after)) return { action: "updated", text: before.replace(/(?:\r?\n)+$/u, match => match.startsWith("\r\n") ? "\r\n" : "\n") };
  return { action: "updated", text: before + after };
}

// `existingOnly`: the caller writes only files that already hold a block (a
// refresh). CLAUDE.md counts as importing AGENTS.md only when this same plan
// writes or keeps a block in AGENTS.md; otherwise its own block is refreshed
// as before, so a refresh can never leave the repository with no block.
export function planPointers(root, ctx, commandResolution, mcpRegistrations, setup, { existingOnly = false } = {}) {
  const block = renderBlock(ctx, root, commandResolution, mcpRegistrations, setup);
  const agentsPath = join(root, "AGENTS.md");
  const agentsPlan = pointerPathProblem(root, agentsPath) ? { action: "conflict" } : plannedBlock(agentsPath, block);
  const agentsHasBlock = existsSync(agentsPath) && !pointerPathProblem(root, agentsPath) && readFileSync(agentsPath, "utf8").includes(BEGIN);
  const agentsHoldsBlock = agentsPlan.action !== "conflict" && (!existingOnly || agentsHasBlock);
  return POINTER_FILES.map((file) => {
    const path = join(root, file);
    const unsafe = pointerPathProblem(root, path);
    if (!unsafe && file === "CLAUDE.md") {
      if (!existsSync(path)) return { file, path, target: "agents_bridge",
        action: "created", text: CLAUDE_BRIDGE };
      const text = readFileSync(path, "utf8");
      if (isClaudeBridge(text)) return { file, path, target: "agents_bridge",
        action: "unchanged", text };
      if (agentsHoldsBlock && importsAgents(text)) return { file, path, target: "agents_bridge", ...withoutBlock(text) };
    }
    return { file, path, ...(unsafe
      ? { action: "conflict", reason: unsafe }
      : plannedBlock(path, block)) };
  });
}

// A knowledge write refreshes knowledge in an already-managed block; setup
// (connect/start) owns its setup section. When this machine cannot produce a
// setup identifier or the repo-local shim (a fresh clone, an isolated HOME),
// keep the committed marker, registered server and portable command spelling
// rather than rewriting them from this machine's absence. Only values the
// generator itself would emit are kept, and only when every managed block
// agrees; the block is still rendered and guarded by renderBlock.
function keptSetup(root, texts, commandResolution, mcpRegistrations) {
  const sections = texts.map(text => {
    const block = text.slice(text.indexOf(BEGIN), text.indexOf(END));
    const workflow = block.indexOf("\nProject API files:");
    return { setup: workflow < 0 ? "" : block.slice(0, workflow), block };
  });
  const agreed = values => values.length > 0 && values.every(value => value && value === values[0]) ? values[0] : null;
  let resolution = commandResolution, registeredKey;
  if (!(commandResolution.mcp.bindingId ?? currentSetupBinding(root, mcpRegistrations))) {
    const binding = agreed(sections.map(({ setup }) => setup.match(/^Expected tool description marker: Setup binding: (\S+)$/mu)?.[1]));
    if (validSetupBinding(binding)) resolution = { ...resolution, mcp: { ...resolution.mcp, bindingId: binding } };
  }
  const keys = [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS];
  if (!keys.some(key => mcpRegistrations.some(row => row.key === key && !row.code))) {
    const key = agreed(sections.map(({ setup }) => setup.match(/ Registered server: `([^`\n]+)`\.$/mu)?.[1]));
    if (keys.includes(key)) registeredKey = key;
  }
  // The committed spelling is the project's portable word, never a fallback
  // npx invocation or an omission derived from this checkout's missing shim.
  const local = commandResolution.portable.available && commandResolution.portable.command === POINTER_CLI_NAME;
  if (!local && sections.length > 0 && sections.every(({ block }) => block.includes(`\nRegenerate with \`${POINTER_CLI_NAME} learn\`. Remove with \`${POINTER_CLI_NAME} unwire\`.\n`)))
    resolution = { ...resolution, portable: { command: POINTER_CLI_NAME, path: join(root, "node_modules", ".bin", PRODUCT), available: true } };
  return { resolution, setup: registeredKey ? { registeredKey } : {} };
}

// `saved` names what the caller already saved, for the failure reason: a note
// path saved "the context"; a stack command saved its stack change. Each
// failure names its file when one is known, so a refresh that wrote one file
// and failed on the other can be reported file by file.
// `onlyWithBlock` (the stack commands): when no pointer file holds a managed
// block there is nothing that could be stale, so a file the refresh cannot
// inspect (a symbolic or hard link) is not a failure. A linked file is read
// for a block only when it is a regular file; a symbolic link is never
// followed. The note path keeps refusing such a file, as it always has.
function holdsBlock(row) {
  if (row.managed) return true;
  try {
    if (!lstatSync(row.path).isFile()) return false;
    const text = readFileSync(row.path, "utf8");
    return text.includes(BEGIN) || text.includes(END);
  } catch { return false; }
}
export function refreshNotePointers(root, retry = "Repeat the same note command; it is idempotent and retries pointer refresh.", { saved = "The context was saved", onlyWithBlock = false } = {}) {
  // A note refreshes only already-managed instruction blocks. Setup remains
  // the owner of creating instruction files and the Claude import bridge.
  const states = inspectPointerFiles(root);
  const managed = states.filter(row => row.managed || row.problem);
  if (!managed.length || (onlyWithBlock && !states.some(holdsBlock))) return { state: "unchanged", files: [] };
  const touched = [];
  let current = null, order = managed.map(row => row.file);
  try {
    const snapshot = loadContextSnapshot(root);
    if (!snapshot) throw Object.assign(new Error("The saved context is unavailable."), { code: "CONTEXT_UNAVAILABLE" });
    const files = new Set(managed.map(row => row.file));
    const originals = new Map(managed.filter(row => !row.problem).map(row => [row.file, readFileSync(row.path, "utf8")]));
    const registrations = discoverMcpRegistrations(root);
    const kept = keptSetup(root, [...originals.values()].filter(text => text.includes(BEGIN) && text.includes(END)), advertisementPlan(root), registrations);
    const plans = planPointers(root, snapshot.ctx, kept.resolution, registrations, kept.setup, { existingOnly: true }).filter(plan => files.has(plan.file));
    order = plans.map(plan => plan.file);
    const failures = plans.filter(plan => plan.action === "conflict").map(plan => ({ file: plan.file, code: "POINTER_CONFLICT", reason: plan.reason }));
    // A conflict in any file cancels the whole refresh; the other managed
    // files are named as not attempted rather than left unmentioned.
    const skipped = plans.filter(plan => plan.action !== "conflict").map(plan => plan.file);
    if (failures.length) return { state: "failed", files: [], failures, ...(skipped.length ? { not_attempted: skipped } : {}), retry };
    for (const plan of plans) {
      current = plan.file;
      if (plan.action !== "unchanged") {
        if (loadContextSnapshot(root)?.digest !== snapshot.digest) throw Object.assign(new Error("Knowledge changed during pointer refresh."), { code: "CONTEXT_WRITE_CONFLICT" });
        const problem = writableDestinationProblem(plan.path);
        if (problem) throw Object.assign(new Error(`${plan.file}: ${problem}`), { code: "POINTER_WRITE_FAILED" });
        replaceNotePointer(plan.path, plan.text, { expectedText: originals.get(plan.file), beforeCommit: () => {
          if (loadContextSnapshot(root)?.digest !== snapshot.digest) throw Object.assign(new Error("Knowledge changed during pointer refresh."), { code: "CONTEXT_WRITE_CONFLICT" });
        } });
      }
      touched.push({ file: plan.file, action: plan.action });
    }
    if (loadContextSnapshot(root)?.digest !== snapshot.digest) return { state: "failed", files: touched, failures: [{ code: "CONTEXT_WRITE_CONFLICT", reason: "Knowledge changed during pointer refresh." }], retry };
    return { state: touched.some(row => row.action !== "unchanged") ? "written" : "unchanged", files: touched };
  } catch (error) {
    // The refresh stops at the first failure. Name the cause for this
    // module's own errors, and every managed file after it as not attempted.
    const detail = error.code === "POINTER_WRITE_FAILED" && current && error.message.startsWith(`${current}: `) ? error.message.slice(current.length + 2)
      : ["POINTER_WRITE_CONFLICT", "POINTER_UNSAFE_PATH", "CONTEXT_WRITE_CONFLICT", "CONTEXT_UNAVAILABLE"].includes(error.code)
        ? error.message.replace(/\.$/u, "").replace(/^\w/u, letter => letter.toLowerCase()) : null;
    const done = new Set(touched.map(row => row.file));
    const notAttempted = order.filter(file => file !== current && !done.has(file));
    return { state: "failed", files: touched, failures: [{ ...(current ? { file: current } : {}), code: error.code ?? "POINTER_WRITE_FAILED",
      reason: `${saved}, but ${current ?? "the managed instruction blocks"} could not be refreshed${detail ? `: ${detail}` : ""}.` }],
      ...(notAttempted.length ? { not_attempted: notAttempted } : {}), retry };
  }
}

// What a stack-changing command (stack add, stack move, stack import, init)
// prints after a refresh: the files written, each failure with its reason
// and what to do, and the files not attempted because of it. The stack
// change is already saved, so every piece of advice ends at connect, after
// the named file is fixed; a malformed block is repaired by hand first,
// since connect refuses it the same way.
export function stackRefreshAdvice(failure, cli) {
  const file = failure.file;
  if (failure.code === "POINTER_CONFLICT" && /delimiters are malformed/u.test(failure.reason ?? ""))
    return `Repair the block's markers in ${file}: it needs exactly one ${BEGIN} followed by one ${END}. Then run ${cli} connect; the stack change is saved.`;
  if (failure.code === "POINTER_WRITE_FAILED" && file) return `Make ${file} writable, then run ${cli} connect; the stack change is saved.`;
  if (failure.code === "POINTER_WRITE_CONFLICT" && file) return `${file} changed while it was being refreshed; run ${cli} connect to refresh it. The stack change is saved.`;
  if (file) return `Fix ${file} as the reason above says, then run ${cli} connect; the stack change is saved.`;
  return `Run ${cli} connect to refresh the managed instructions; the stack change is saved.`;
}
export function stackRefreshLines(pointers, cli) {
  const names = rows => rows.map(row => row.file).join(", ");
  if (pointers.state !== "failed") return pointers.files.length ? [`Managed instructions: ${pointers.state} (${names(pointers.files)}).`] : [];
  const written = pointers.files.filter(row => row.action !== "unchanged");
  const lines = written.length ? [`Managed instructions refreshed: ${names(written)}.`] : [];
  for (const failure of pointers.failures) {
    lines.push(failure.file ? `Managed instructions not refreshed in ${failure.file} (${failure.code}): ${failure.reason}`
      : `Managed instructions not refreshed (${failure.code}): ${failure.reason}`);
    lines.push(`  ${failure.next ?? stackRefreshAdvice(failure, cli)}`);
  }
  if (pointers.not_attempted?.length) lines.push(`Managed instructions not attempted because of that failure: ${pointers.not_attempted.join(", ")}.`);
  return lines;
}
