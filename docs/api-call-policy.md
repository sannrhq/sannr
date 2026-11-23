# API calls during coding

Use Sannr for agent-issued calls to APIs the repository owns or consumes,
including integrations being added. The boundary is repository relevance:
familiarity, response size and HTTP method do not establish that nothing has
changed. A health check or simple GET belongs on this path too.

| Work | Route through Sannr? |
| --- | --- |
| Explore or test this repo's API | Yes |
| Debug an existing integration | Yes |
| Evaluate an integration explicitly being added | Yes; configure its target |
| Check the configured API's health | Yes |
| Research documentation or download packages | Outside this convention |
| Administer GitHub or CI | Outside, unless that API is the integration being built |
| Application or test-runner runtime traffic | Not intercepted by this convention |

The installed `sannr-request` skill carries this convention to coding agents.
Run `sannr connect` after upgrading to refresh exact generated skills. Locally
edited skills are preserved and reported as different; review the new packaged
skill before choosing `--force-skills`. Host tool lists may need a refresh.
This is an agent convention, not a network interception layer. The optional
Claude hook covers its documented command patterns and configured own bases;
it does not enforce every integration call or every coding host.

## What a call leaves behind

The MCP `api_request` tool and CLI share the client. For HTTP, an explicitly
configured primary base or named integration enables bounded structural context
capture when the request matches its origin/base path and a unique route in
that provider's own bound contract. Configure an integration with
`hosts.<name>.baseUrl` and `hosts.<name>.contract` in `.sannr/config/api-environments.json`;
the contract file resolves relative to that configuration file. Optional
`contractPathPrefix` declares a deployment mount when the contract paths omit it.
See the [binding example](protocols.md#http-context-capture).

For the primary API, `sannr start` / `connect` saves a uniquely discovered local
contract into the selected environment's `contract` field when that environment
has an explicit base URL in a project-local config. CLI suites and MCP then use
the same binding. Multiple candidates require an explicit selection;
`sannr start --contract <path>` saves that choice. Existing bindings and unrelated
environments are preserved. Ambient `API_CONTRACT` / `API_BASE_URL` overrides
remain invocation-local, and a URL override needs its own explicit contract.

Use `upstream: "<name>"` to choose a named integration and `path` for the operation.
Unsupported routing keys such as `host`, `baseUrl` and `url` are refused before
execution, including when a later step in a batch contains one.

Unbound, unmatched and ambiguous routes return a named limited capture receipt
without committing literal URL path values; private execution evidence remains.
The implicit localhost fallback is not an integration declaration. An upstream
never borrows the primary contract or legacy notes. A selected environment's
host entry replaces the top-level entry for that name, so redeclare its contract
when changing the provider. Non-HTTP adapters also capture bounded observations.

`capture_context: false` disables a request's shared context recording, and
`API_CONTEXT_OFF=1` disables context globally. Neither option disables private
execution evidence or the request's other effects. `capture_context: true`
requests HTTP recording but cannot bypass the safe route identity requirement. A `context_capture` receipt
reports the recording result. Disk, capacity or other capture failures remain
visible separately from the API response.

Before writing private response evidence, the client runs the authored-note
secret scanner, also recognizing credential fields such as `client_secret`,
`signing_secret` and `token`. A matching string is replaced with a withheld
marker and a salted SHA-256 hash. `response.body_secrets` records whether
replacement occurred and its count. Each record gets a fresh private salt,
which is not saved; hashes cannot be compared across runs. Opaque credentials
identified by their field are also withheld from echoes and protocol assertion
details in that record. Large sets of credentials cause the whole body to be
withheld so alias scanning stays bounded.

This covers JSON, text, pagination pages and protocol evidence, including
JSON-wrapped strings and canonical UTF-8 base64. Automatic binary evidence is
scanned too: clean bytes stay unchanged; bytes containing a recognized secret
are replaced by a marker, with replacement metadata on the binary receipt.
An explicit `save_to` download keeps the requested bytes unchanged. If those
bytes contain a recognized secret, its receipt says `saved_unredacted: true`
and withholds the unsalted file digest; the automatic run record stays scrubbed.
Assertions still inspect the original response in memory. This is a credential
guard, not general personal-data removal: other response values remain local
private evidence and should not be committed.

Contract warnings on stderr are emitted once per distinct diagnostic during a
client process. Each request retains its own contract diagnostic state, and
`doctor` still reports the contract checks. Closing a warning consumer does not
cancel the request or prevent its evidence from being saved.

When a complete successful client response changes a matched field's observed
type, `context_capture.change_notice` can point to the prior/current observations,
their evidence, and up to eight JSON-pointer paths. Comparisons require the same
provider, environment, operation, endpoint, contract digest and request shape;
HTTP also requires the same response status. Old HTTP observations can supply
status through their exact generated status note, labeled `legacy_note`.
Missing fields, null samples and array members are not compared. This is a cue
to inspect and reconcile context, not a schema verdict or a new lesson: record a
scoped correction with `api_context_record` when the evidence warrants it.
Small response budgets shorten the notice and name omitted details; a requested
budget below the remaining response minimum is reported with `budget_min`.

HTTP failures before a response is received are reported through the existing
error path; this capture bridge does not create a shared observation for them.
The read-only librarian binding admits GET/HEAD only and disables shared
recording, including batches. `sannr verify` disables shared recording for every
executed suite step in both full and `--read-only` mode. Private execution
evidence remains available.

Saved context retains structural samples, outcomes, assertion summaries and
evidence references. It excludes scalar request/response payload values from
shared structural samples. A received response is an observation; only the
assertions actually run support a verification claim. An undocumented required
field, state precondition or rejected integration still needs an explicit,
scoped author note. Automatic capture does not invent that explanation.

On the request path, an assertion whose `matches` pattern is refused by the
regex safety guard reports `ASSERTION_PATTERN_REFUSED`, the guard's `reason`,
and `refused_ops: ["matches"]`. This is an unevaluated assertion, not a mismatch.
The response status and execution evidence remain available. In a clause with
several operators, `op` still names the first failure and `ops` lists every
operator; the refusal stays visible even when an earlier operator mismatched.
Safe patterns retain ordinary match/mismatch results. The pattern and input
limits, and the existing import and suite admission refusals, are unchanged.

For a repository graph, retrieve the relevant operation using `api_context`,
then use `api_context_record` to save a reusable lesson with its provider,
environment and evidence. Use the legacy `sannr note` convention where
appropriate. Shared Git snapshots or CI artifacts carry selected context across
checkouts; routing a call does not automatically publish it to other teams.
See [agent context across repositories](dependency-graph.md).

## Exceptions and limits

Keep existing authorization, credential routing and production write rules.
Choosing the client does not authorize extra API calls. Repository-specific safe
check requirements still apply when their tools are available.

For intended writes to an environment marked `production: true`, set
`API_ALLOW_PRODUCTION_WRITES=1` in the MCP server's launch environment (edit the
host's server configuration, then restart the server in the host), or in your
shell for CLI runs.

### Saved notes arrive before a write

A write that an agent issues by hand (a POST, PUT, PATCH or DELETE through
`api_request`, the `request` command, a saved request run through
`api_saved_requests` or `saved run`, and any protocol call through
`api_request` or `protocol` whose effect is not a read) to an operation
with saved knowledge is refused before anything is sent. The rule follows
delivery: a write is held exactly when the `known` its response would carry
holds a note or a stack fact. That includes a route the contract does not
resolve (a path it does not list, another letter case, a parameter suffix),
which still receives the facts that apply to every operation; its digest is
keyed by the request's own method and path. What holds a write is the
operation's active notes and its stack's applicable facts, and nothing else,
for HTTP and protocol calls alike. An authored lesson (a `context capture`
claim or an `api_context_record` lesson, delivered in `known.scoped` with the
operation's most recent observations) holds nothing and is not part of the
digest; save it as a note with `note` when a write should wait for it.
The hold recognises the same write methods as the production guard (POST,
PUT, PATCH, DELETE). The
refusal is `kind: "policy"`, `code: "WRITE_HELD_FOR_NOTES"`, with the same
`known` block a response would have carried (same caps, labels and omission
counts; note text is untrusted data) and `error.details.notes_digest`. Read
the notes, then resend the same request with `notes_digest` set to that value
(`--notes-digest <digest>` on the `request` and `saved run` commands). Reading first avoids the
refused attempt: `api_note_context` for one operation and `show "<METHOD
/path>"` return the same `notes_digest`. When `show` finds an operation only
by a looser match (another letter case or part of a saved key) it names the
operation it found and gives no digest.

- The digest is computed from the saved note and fact identities only. It
  changes when an applicable note or fact is added, superseded, retired or
  given a new review decision, not when a note is confirmed or a response is
  recorded, and it is the same at every token budget and on every machine for
  the same store.
  Account facts and facts from granted providers appear in `known` but are
  neither part of the digest nor a reason to hold a write.
- `NOTES_DIGEST_STALE`: the notes changed since the digest was issued; the
  refusal carries the current notes and digest. `NOTES_DIGEST_INVALID`: not a
  notes digest. `NOTES_DIGEST_OTHER_OPERATION`: the digest belongs to another
  operation.
- An operation with no notes, in a stack with no applicable facts, is never
  held. Reads are never held. A protocol call is held wherever the production
  write boundary would treat it as a write: every effect that is not `read`,
  including `unknown`. A GraphQL query is a read by its operation type; gRPC
  and WebSocket calls (and GraphQL subscriptions) are reads only when
  `grpc.effect` or `websocket.effect` says `read`; a JSON-RPC call cannot
  declare a read, so in a noted stack it always names the digest.
- A batch (`requests` and `finally`) is checked whole before anything is sent,
  protocol steps included (their effect and operation come from their own
  input). Nothing is sent before a hold the client can know before the batch
  runs; it predicts nothing a captured value decides. One refusal, `WRITE_HELD_FOR_NOTES` with `attempted: 0`, lists
  every held step in `error.details.held_steps` (index, phase, id, code,
  operation and `notes_digest`), with one capped `known` per distinct
  operation in `error.details.known` keyed by digest; the whole refusal stays
  within the token budget. A refusal gives a step's `notes_digest` only with
  that step's notes: a held step whose notes do not fit is still listed with
  its code and operation, but its digest appears nowhere in the refusal, and
  its `notes` (`omitted: true`) says how to read them: `api_note_context` or
  `show` for an HTTP operation, which return the notes and the digest
  together, or the step sent on its own for a protocol call. Resend the batch
  with each step carrying its own `notes_digest`.
  - A protocol step the run refuses from its own input and plan is refused
    by the pre-check with the same code, from the same function:
    `PROTOCOL_INPUT_CONFLICT` (`websocket` options on a GraphQL call that is
    not a subscription), `PROTOCOL_HEADER_ASSERTION_UNSUPPORTED` (a header
    `expect` on gRPC, WebSocket or a GraphQL subscription), and an operation
    name that cannot be a saved-context identity (a control or format
    character, a credential shape, more than 512 characters;
    `CONTEXT_INPUT_INVALID` for a zero-width or control character). When the
    hold could apply to the step, the batch is refused up front under that
    code with the step in `refused_steps` and no digest for it; nothing is
    sent.
  - `method`, `path`, `stack`, `environment`, `upstream`, `protocol` and
    `notes_digest` must be strings in every step and in a single request; a
    value of another type refuses the whole call with
    `REQUEST_FIELD_INVALID`, naming the step and the field, and nothing is
    sent.
  - The run fills placeholders only in `path`, `params`, `headers`, `body`,
    the protocol payloads (`graphql.variables`, `rpc.params`, `grpc.body`,
    `grpc.messages`, `websocket.send`) and `expect`. A write step whose path
    depends on a value captured in the batch is not resolved before the batch
    runs. When the hold is on and a
    stack it could reach has a stack fact or a note on an operation of that
    method, it is refused up front with
    `NOTES_TARGET_UNRESOLVED` and no digest unless it carries a
    `notes_digest`: read the notes for the operation it will reach and put
    that digest on the step, or send the step on its own. Environment
    variables are filled in before the check.
  - The run refuses some steps before sending them, in this order: an
    unsupported per-step `auth`, a protocol input without `protocol`, a
    placeholder nothing fills (no earlier capture and no environment
    variable; a placeholder in a field the run never fills, such as `method`,
    counts), `auth` on a protocol step, `wait_for` on a protocol step,
    `wait_for` on a write, and a non-numeric `wait_for` timing; then, at the
    step's target, an unresolvable target, a literal credential, an invalid
    or non-GET `paginate`, a configuration problem, an imported auth binding
    or required absence, and the production guard; for a protocol step, its
    input (an unsupported protocol, a payload that is not bounded JSON, a
    conflicting input object, an HTTP-only option such as `method`, a
    non-array `expect`, an invalid `timeout_ms`) and its target. The
    pre-check calls the same functions on the arguments the step is sent
    with. Such a step is never held for
    notes. When the batch also has a held step, it is refused on the first
    attempt under the first refused step's code, listing the held steps with
    their digests in `held_steps` and the refused steps with the run's codes
    in `refused_steps`; nothing is sent. A batch with no held step runs as
    before and the run refuses that step at its turn.
  - A write step that the pre-check cannot check at all is refused up front
    with `NOTES_TARGET_UNRESOLVED` when a stack it could reach has knowledge
    that could hold it; a digest does not change that. Send it on its own, or
    correct it.
  - If a step that carries a digest is still held when it runs (a wrong or
    stale digest, or a digest for another operation than the one a captured
    value reached), its refusal names the steps already sent in
    `error.details.sent_steps`; resend only the remaining steps, never the
    whole batch.
- The digest also covers each note's current review decision: a trust or
  dispute decision gives a new digest, so a caller holding an older one reads
  the notes again. A confirmation does not change it. `api_note_context` and
  `show` resolve the operation the way the request does (a concrete path, a
  template under any parameter name, a lowercase method, a query string), so
  the digest they return is always the one the write needs. A note saved on a
  route the stack's contract does not declare is kept and can be read, but it
  is not delivered with responses, so it holds no write and has no digest. A protocol call's refusal puts the
  digest in its own input (the protocol JSON or the `api_request` arguments);
  there is no read-first route for protocol operations.
- When a stack's facts were changed outside the tool, they are withheld from
  `known` until reviewed and the write is still held; the refusal's `next`
  names the review receipt and the `review --scope stack --accept-notes`
  command instead of telling you to read notes that are not there.
- Every other refusal still applies and is checked first: a correct digest
  never makes a production write, a configuration problem or a host rule
  sendable. The hold is checked before authentication, so a held attempt sends
  nothing, not even an OAuth token request, and records no observation.
- A redirect that would carry the write to another operation with saved notes
  is not followed (`NOTES_HOLD_REDIRECT_REFUSED`) unless the digest is that
  operation's. Inside a batch the refusal counts its own step in
  `sent_steps` (its request reached the server); send the write to the
  destination with the digest the refusal gives.
- Saved suites (`suite run`), `verify`, `learn`, `doctor`, map probes, imports
  and captures are not held: they run saved material with nobody reading in
  between. The Workbench's Request view is not held (a person sends it). One
  saved request run by an agent is held like `api_request`.
- Where saved context is not delivered at all, nothing is held: with
  `API_CONTEXT_OFF=1`, and in the legacy single-store layout when
  `API_BASE_URL` overrides a configured environment without `API_CONTRACT`.
  In those cases `show` and `api_note_context` offer no digest either.
- To turn the hold off for a repository, commit `"holdWritesForNotes": false`
  in `.sannr/defaults.json` (or in the `defaults` block of a legacy
  `.sannr/config/api-environments.json`, read only at those fixed paths). The
  setting has no environment variable, and no other file can turn it off: not
  a parent directory's defaults and not a file named by `API_CONFIG`, inside
  the repository or not. Turning it off always shows up in the repository's
  diff. Commit it only when every client
  that reads the repository is this version or later: 0.1.0-beta.1 refuses an
  unknown key in `.sannr/defaults.json` (`STACK_KEY_UNKNOWN`).

If MCP is unavailable, use the Sannr CLI. If a transport is unsupported or a
raw-client comparison is necessary to debug Sannr, disclose the limitation and
use a narrow fallback. An external observation can be captured with explicit
source attribution; it remains an external claim. See
[protocol support and external capture](protocols.md).

This release does not intercept arbitrary process traffic, discover all callers,
continuously detect every API change or establish that saved context reduces
cost. It makes relevant observations and authored lessons retrievable so those
benefits can be evaluated. Missing evidence, unknown callers, stale scope and
unasserted behavior must remain visible to the next agent.
