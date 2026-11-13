# Telemetry: the anonymous daily usage counts

Sannr sends one small anonymous document a day to
`https://sannr.dev/api/v1/usage`. It is on unless you turn it off, and nothing
is sent until Sannr has told you so on this machine. It has no account behind
it, and it is separate from [feedback](feedback.md), which stays optional and
asks first.

## What is sent

Exactly the document in
[`lib/usage.schema.json`](../lib/usage.schema.json), at most 2,048 bytes,
with these nine fields and nothing else:

| Field | What it is |
| --- | --- |
| `v` | The document version, `1`. |
| `install` | A random identifier made on this machine (a version-4 UUID from the platform's secure random source) the first time a document is sent. It is derived from nothing: not the machine, the user, a repository or a credential. |
| `version` | The Sannr version. |
| `os` | `darwin`, `linux`, `win32` or `other`. |
| `arch` | `arm64`, `x64` or `other`. |
| `node` | The Node.js major version. |
| `since` | The UTC date of the previous document from this install, or `null`. |
| `features` | How many times each Sannr command or MCP tool ran since the previous document, under fixed names from Sannr's code: one per command (`connect`, `doctor`, `request`), the subcommand folded in where it is the feature (`suite_run`, `saved_run`, `stack_add`), and `mcp_<tool>` for each MCP tool call (`mcp_api_request`). A command that has no fixed name is not counted. Each count includes runs that failed and stops at 10,000. |
| `api_calls` | How many API requests Sannr executed since the previous document. A number only, stopping at 1,000,000. |

An example:

```json
{"v":1,"install":"1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b","version":"0.1.0-beta.2","os":"darwin","arch":"arm64","node":22,"since":"2026-11-11","features":{"doctor":1,"mcp_api_request":14,"request":3},"api_calls":17}
```

## What is never sent

Nothing about your repositories, APIs or requests: no repository or folder
name, no path, no host, URL, method, header, body or status, no stack or
environment name, no credential or credential name, no note text, no
argument you typed, no error text, no user or host name. The endpoint accepts
exactly the schema above and refuses anything else.

## When

- **Not before you are told.** The first time Sannr runs on a machine, it
  prints a notice: `connect` shows it in its output (and as
  `telemetry_notice` in `connect --json`); any other command prints it once on
  standard error; the MCP server adds it as a separate text block to its first
  tool result, for your agent to relay. Standard output and JSON output are
  otherwise unchanged. Until the notice has been shown, nothing is counted and
  no identifier exists.
- **A day later.** The first document is sent no earlier than 24 hours after
  the notice. If you turn it off within that day, nothing about you is ever
  sent.
- **Once a day at most.** When a document is due, the next command (or the MCP
  server, in the background) sends it from a separate process that the command
  does not wait for. A failed send keeps the counts for the next attempt, with
  at most three attempts in a UTC day. Counts are cleared only when the
  endpoint accepts them.
- **The request itself** is a `POST` with `content-type: application/json` and
  a user agent of the product name and version, nothing else that identifies
  anything: no cookie, no authorization, no redirect followed, a five-second
  timeout, no proxy and no setting that changes the destination.

## See it

- `sannr telemetry` (or `sannr telemetry status`): on or off and why, when the
  notice was shown, when the next document may go, and where the state lives.
- `sannr telemetry show`: the exact bytes the next document would carry, the
  destination, and the last document sent. Before the first send, a
  placeholder stands in for the identifier, which does not exist yet.
- Every document is written to `~/.sannr/telemetry/sent/` (or
  `$SANNR_HOME/telemetry/sent/`) before it is sent; the last 30 are kept.

Each command accepts `--json`.

## Turn it off

- `sannr telemetry off`, or tell your agent **"opt out"** and it runs that
  command. Off is for the whole machine and stays off across upgrades and
  reinstalls, until `sannr telemetry on`. It deletes the identifier, the
  unsent counts and the saved documents, and sends nothing: an opt-out is not
  counted.
- For one process or environment: `SANNR_TELEMETRY=0` (also `off`, `false` or
  `no`), or `DO_NOT_TRACK=1`. A CI environment is off automatically: `CI` set
  to anything but `0` or `false`, or any of `GITHUB_ACTIONS`, `GITLAB_CI`,
  `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD`, `TEAMCITY_VERSION`. In
  such a process nothing is counted, no identifier is made, nothing is sent,
  no notice is shown and the telemetry state is not written.
- `sannr telemetry reset` deletes the identifier; a new one is made at the next
  send.
- `sannr telemetry on` turns it back on, with a new identifier.

## Where it lives

The setting is `~/.sannr/telemetry.json` (or `$SANNR_HOME/telemetry.json`),
beside the machine usage log, never in a repository. Unsent counts and the
saved documents are under `~/.sannr/telemetry/`. Files are mode 0600 in 0700
directories. If the setting cannot be read or written (a damaged file, a
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
  many new installs one address can add in a day, and it stores no IP address,
  but the figures are indications, not proof.
- **The identifier is pseudonymous, not anonymous in the strictest sense:** it
  is the same install from one day to the next, which is what makes daily and
  weekly counts possible. It is linked to nothing else Sannr knows.
