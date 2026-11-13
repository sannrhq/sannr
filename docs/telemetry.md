# Telemetry: the daily usage counts

Sannr sends one small document of usage counts a day to
`https://sannr.dev/api/v1/usage`. It is on unless you turn it off, and nothing
is counted or sent until Sannr has printed a notice about it on this machine.
The document carries a random install identifier, made on this machine and
derived from nothing; it stays the same from day to day, so one day's document
can be linked to the next. That is what lets daily and weekly active installs
be counted. There is no account behind it, and it is separate from
[feedback](feedback.md), which stays optional and asks first.

## What is sent

Exactly the document in
[`lib/usage.schema.json`](../lib/usage.schema.json), at most 2,048 bytes,
with these nine fields and nothing else:

| Field | What it is |
| --- | --- |
| `v` | The document version, `1`. |
| `install` | A random identifier made on this machine (a version-4 UUID from the platform's secure random source) the first time a document is sent. It is derived from nothing: not the machine, the user, a repository or a credential. It is the same in every document until `telemetry reset` or `telemetry off`, so documents from one install can be linked. |
| `version` | The Sannr version. |
| `os` | `darwin`, `linux`, `win32` or `other`. |
| `arch` | `arm64`, `x64` or `other`. |
| `node` | The Node.js major version. |
| `since` | The UTC date of the previous document from this install, or `null`. |
| `features` | How many times each Sannr command or MCP tool ran since the previous document. The names are fixed: every name that can ever be sent is in [`lib/usage-features.json`](../lib/usage-features.json), one per command (`connect`, `doctor`, `request`), the subcommand folded in where it is the feature (`suite_run`, `saved_run`, `stack_add`), and `mcp_<tool>` for each MCP tool call (`mcp_api_request`). A command or tool that has no name in that file is not counted. A count includes runs that failed and stops at 10,000. |
| `api_calls` | How many requests Sannr executed against your APIs since the previous document, stopping at 1,000,000. Every request counts once when an answer came back, protocol requests included (GraphQL, JSON-RPC, gRPC, WebSocket); a request that follows redirects, or a paginated call, counts once; a request refused before sending or that got no answer is not counted. `doctor`'s setup probe and a feedback send are not counted. A program that uses this package as a library counts its requests the same way. A number only. |

The features table is ordered by count: if a document would hold more than 64
names or 2,048 bytes, the largest counts go first and the rest wait for the
next document.

An example:

```json
{"v":1,"install":"1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b","version":"0.1.0-beta.2","os":"darwin","arch":"arm64","node":22,"since":"2026-11-11","features":{"doctor":1,"mcp_api_request":14,"request":3},"api_calls":17}
```

## What is never in the document

Nothing about your repositories, APIs or requests: no repository or folder
name, no path, no host, URL, method, header, body or status, no stack or
environment name, no credential or credential name, no note text, no
argument you typed, no error text, no user or host name.

## What a send reveals anyway, and what the endpoint keeps

The document travels over HTTPS to `sannr.dev`, which Cloudflare serves. Like
any request, each send reveals to the receiving side the address it came from
and the time it was sent, which is the time of the first Sannr command of that
day; it arrives beside the stable install identifier. What Cloudflare itself
records at its edge is outside Sannr's code.

From the endpoint's own description: "Sannr's server keeps no IP address. Its
rate limiter keeps a daily-salted, keyed hash of the address, deleted after
that day (within about 48 hours) and recoverable from Cloudflare's storage
history for up to 30 days." The endpoint's description adds that anyone
holding the limiter's secret could recover an IPv4 address from such a hash by
trying every address for that date. The stored counts carry no address and no
hash of one. On retention, in the endpoint's words: a row "lives at least 180
days and about two months longer (until its month is whole and 27 days more),
plus however many nights the delete budget needs"; that budget keeps up with
about 20,000 daily installs. Then the rows are folded into monthly totals and
deleted. A record of each install's first and last day seen is kept as long
as any of its rows.

## When

- **Not before the notice.** The first time Sannr runs on a machine, it
  prints a notice: `connect` shows it in its output (and as
  `telemetry_notice` in `connect --json`); any other command prints it once
  as one line on standard error; the MCP server adds it as a separate, last
  text block to its first tool result, for your agent to relay. Standard
  output and JSON output are otherwise unchanged. Until the notice has been
  printed, nothing is counted and no identifier exists. Sannr cannot know
  whether anyone read it.
- **A day later.** The first document is sent no earlier than 24 hours after
  the notice, measured by this machine's clock: a process whose clock was
  wrong when the notice was recorded (a container or virtual machine sharing
  the home directory, for example) can shorten that wait. If you turn it off
  within that day, nothing is ever sent.
- **At most one document per UTC day by this machine's clock, per state
  directory:** a machine whose processes use several state directories (for
  example a `SANNR_HOME` pinned in an MCP registration) can send one from each, whatever the identifier: `telemetry off`, `on` and `reset` keep
  the record of the day's document, so none of them adds a document to the
  day. When a document is due, the next command (or the MCP server, in the
  background) sends it from a separate process that the command does not wait
  for. A dry run (`--dry-run`) records no notice, counts nothing and starts no
  send; a command run with `--offline` (for example `doctor --offline`) starts
  no send either. A failed send keeps
  the counts for the next attempt, with at most three attempts in a UTC day.
  Counts are cleared only when the endpoint answers 2xx.
- **The request itself** is a `POST` with `content-type: application/json` and
  a user agent of the product name and version (Node adds its own standard
  headers, such as `accept` and `accept-encoding`); no cookie, no
  authorization, no redirect followed, a five-second timeout. Sannr offers no
  setting, configuration file or proxy variable that changes the destination;
  proxy variables are removed from the sending process. Code loaded into Node
  itself (for example through `NODE_OPTIONS=--import`) can still intercept it,
  as it could any request.

## See it

- `sannr telemetry` (or `sannr telemetry status`): on or off and why, when the
  notice was printed, the earliest time the next command may send, the last
  day a document was delivered, and where the state lives.
- `sannr telemetry show`: the exact bytes the next document would carry, the
  destination, the last document delivered and the last attempt with its
  outcome. Before the first send, a placeholder stands in for the identifier,
  which does not exist yet.
- Every document is written to `~/.sannr/telemetry/sent/` (or
  `$SANNR_HOME/telemetry/sent/`) before it is sent, and renamed with its
  outcome (`.delivered.json` or `.not-delivered.json`) when the attempt ends;
  a file without an outcome was prepared but no answer was recorded. The last
  30 are kept.

Each command accepts `--json`.

## Turn it off

- `sannr telemetry off`, or tell your agent **"opt out"** and it runs that
  command (the install prompt, the pointer block `connect` writes into
  `AGENTS.md` and `CLAUDE.md`, and the request skill all say so). Off is a small
  marker file, `telemetry.off`, written at once in the state directory the
  command uses, in the default one of its home directory (`~/.sannr`), and in
  every other state directory that has been used with that home (each records
  itself in `~/.sannr/telemetry.dirs` when first used); it never waits for a
  send in progress. Every Sannr process run with that home
  directory checks it before anything else, whatever `SANNR_HOME` it has, and
  nothing but `telemetry on` removes it. A process run with another home
  directory (another account, `sudo`, or a container or sandbox with its own
  `HOME`) keeps its own setting. The identifier, unsent counts and saved
  documents (they contain the identifier) are deleted at once where no send
  holds them, and otherwise before that state directory counts or sends again;
  they are never sent. It stays off across upgrades and reinstalls. Turning it
  off sends nothing; a document that was being prepared or was already on its
  way when you turned it off may still go out within a few seconds. If off cannot be recorded in `~/.sannr` (the location is not a
  writable directory), `telemetry off` says that off holds only for the
  directory it could write, and exits with status 1; set `SANNR_TELEMETRY=0`
  or `DO_NOT_TRACK=1` for every Sannr process instead.
- A marker or a home record that exists and cannot be read means off, and
  `telemetry status` says which file. Every state directory recorded with the
  home holds its own copy of the marker, so losing or moving `~/.sannr` later,
  or running with another `HOME`, does not turn any of them back on; a later
  `telemetry on` for the home lifts those copies. A state directory first used
  after `~/.sannr` was lost, and never recorded with it, has no copy.
- For one process or environment: `SANNR_TELEMETRY=0` (also `off`, `false` or
  `no`), or `DO_NOT_TRACK=1`. A CI environment is off automatically: `CI` set
  to anything but `0` or `false`, or any of `GITHUB_ACTIONS`, `GITLAB_CI`,
  `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD`, `TEAMCITY_VERSION`. In
  such a process nothing is counted, no identifier is made, nothing is sent,
  no notice is shown, and no command other than `telemetry` writes the
  telemetry state. The same holds for a process that a test runner marks
  (`NODE_TEST_CONTEXT`, `VITEST` or `JEST_WORKER_ID` set); other test runners
  (Mocha, AVA, tap, Bun, Deno) set none of these, so set `SANNR_TELEMETRY=0`
  there.
- A source tree of Sannr never counts or sends, so contributors' and agents'
  runs stay out of the numbers. A source tree is a package root that holds
  `.git` (a directory or a worktree file), the repository's test runner
  `scripts/test-unit.mjs`, or its test suite `test/telemetry.test.mjs`, so a
  ZIP download or an archive of the repository counts as one. The published
  package ships none of these.
- `sannr telemetry reset` deletes the identifier; a new one is made at the next
  document. It adds no document to the day: if one was sent today from that
  state directory, the next waits for the next UTC day. When there is no
  identifier yet, it says so and changes nothing.
- `sannr telemetry on` removes the marker of its state directory, starts that
  directory with a new identifier and no earlier counts, lifts the off
  recorded in `~/.sannr`, and lifts the copies off put in the other recorded
  state directories. A state directory where `telemetry off` itself was run
  stays off until `telemetry on` is run with it, and `on` names every such
  directory it finds, as well as any whose copy it could not remove; it says
  processes can count again only with those exceptions.

## Where it lives

The setting is `~/.sannr/telemetry.json` (or `$SANNR_HOME/telemetry.json`),
beside the machine usage log, never in a repository. Unsent counts and the
saved documents are under `~/.sannr/telemetry/`. On macOS and Linux, files Sannr
creates there are mode 0600 in 0700 directories; an existing directory keeps
its mode. If the setting cannot be read or written (a damaged file, a
read-only or misplaced state directory), Sannr keeps working, counts and sends
nothing, shows no notice, and `sannr telemetry status` says why; `telemetry
off` or `telemetry on` replaces a damaged file.

## Honest limits

- **An install is not a person.** Two machines count as two installs; a
  machine that resets its identifier counts as a new one. The numbers are
  active installs, not users.
- **Sannr cannot know that you read the notice.** It knows only that the
  notice was printed or handed to your agent. That is why sending waits a day,
  and why the install prompt asks your agent to tell you.
- **A count can be forged.** The code is open, so anyone can send a document
  with any counts. The endpoint limits how often one address can send and how
  many new installs one address can add in a day, but the figures are
  indications, not proof.
- **Counts are close, not exact.** If the endpoint stores a document but its
  2xx answer is lost, the same counts are sent once more with the next
  attempt. A command that runs at the very moment another one gathers the
  counts for a send can lose its own count.
- **The identifier links days.** It is pseudonymous rather than anonymous in
  the strictest sense: it is the same install from one day to the next, and
  each send arrives from an address at a time of day, as above. It is linked
  to nothing else Sannr knows.
