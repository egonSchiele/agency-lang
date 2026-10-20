# Log viewer comments and live sessions

Lets a person point at one row of an agent's log and have a coding agent
see exactly that row, in both directions: the person leaves a comment on a
row in the `agency logs` viewer, and the agent reads it, answers on the
same row, and can move the viewer to another row while explaining.

## The problem

Reviewing a run with an agent today goes like this. The person opens the
log in the viewer, finds the LLM call where something went wrong, and
then writes a description of where it is:

> Look at trace `k3Pq9…`, the thread named `reviewer`, the fourth LLM
> call, where it calls `readFile` on the config a second time. Why?

The agent then greps `log.jsonl` for the trace, reads raw events until it
finds the call, and reconstructs what the viewer already showed. Both
halves are slow, and both are error-prone: the person miscounts calls,
the agent picks the wrong `readFile`.

The viewer already knows the exact row. It has a stable ID for every row
it draws, one that survives follow-mode updates. Nothing exposes that ID,
and nothing on the agent's side accepts one.

This is the same problem that [Hunk](https://github.com/modem-dev/hunk)
solves for diffs. Hunk is a terminal diff viewer. The person leaves
comments on lines, and the agent runs `hunk session comment add --file
src/App.tsx --new-line 42` style commands from another terminal against
the live viewer, which registers with a local daemon so the commands can
find it. The two things that make it work are a stable address for "this
spot" and a cheap way for the agent to read and write at that address.

## What is built

Five pieces, each small, listed in the order they should land.

1. **`--trace-id` on `agency logs`.** Opens the viewer on one trace.
2. **Addresses.** A documented, copyable form of the viewer's row IDs,
   and a `Y`-style key that copies the focused row's address.
3. **Comments.** A `c` key that attaches a note to the focused row, a
   store for those notes beside the log, and markers on commented rows.
4. **The session.** The running viewer listens on a local socket and
   registers itself, so a command in another terminal can ask what the
   person is looking at and move the cursor.
5. **The CLI and the skill.** `agency logs session …` commands that talk
   to the session when one is open and to the files when none is, and a
   skill that tells the agent to use them.

Piece 1 and piece 2 are useful on their own. Piece 3 is useful with no
daemon. Piece 4 is the part that can be deleted later if it turns out to
add more complexity than it saves; the section "Keeping the session
separate" says how.

## `--trace-id` on `agency logs`

```
agency logs run.jsonl --trace-id k3Pq9abc
agency logs runs/2026-10-19/ --trace-id k3Pq9abc
```

The viewer boots on that trace and does not open the trace picker. The
other traces in the file stay reachable through the picker, as they do
when the runs explorer drills into a run. This is focus, not a filter:
sub-runs and resumes that logged under another trace ID are often what
the person is hunting for, so they are not hidden.

The viewer already takes a `focusTraceId` option that does exactly this
(`lib/logsViewer/run.ts`); the runs explorer and the labeling controller
pass it. The flag forwards it. An ID the file does not contain is an
error naming the IDs it does contain, and the viewer does not open.

## Addresses

An address names one row of one trace:

```
k3Pq9abc/round:span-7f3a:2
```

The part before the slash is the trace ID. The part after is the row ID
the viewer already uses for cursor and focus state. No single character
can split an address: a trace ID can be anything a config or the trace-ID
environment variable supplies, slashes included, and a leaf directly under
the trace root embeds the trace ID in its row ID. An address is split
against the trace IDs of the log it names, longest match first; the CLI
reads the log before it splits, and text no trace ID starts is a bare row
ID. These IDs exist
today in `lib/logsViewer/story.ts` and `tree.ts`:

| Row | ID | Example |
| --- | --- | --- |
| An LLM call (a round) | `round:<span id>:<ordinal>` | `round:span-7f3a:2` |
| The user turn before a round | `<round id>:user` | `round:span-7f3a:2:user` |
| A tool call | its span ID | `span-9c01` |
| An interrupt, error, or other event under a parent | `leaf:<parent id>:<event type>:<ordinal>` | `leaf:span-9c01:interrupt:0` |

Every screen shares them: the overview selects by round ID, the trace
outline's cursor is a row ID, a transcript block carries its round or
span ID, and the timeline opens the same rows. So one address form
covers all four screens, and the screen is not part of the address.

The row ID becomes a contract. `docs/dev/cli/logs-viewer.md` gets a
section that states the four shapes above and says that changing them
breaks stored comments. Each stored comment also carries an **anchor**: a
few facts about the row that do not depend on the ID format (the
nearest event's timestamp, the tool name or model, and the thread
label). A reader that cannot resolve a row ID falls back to the anchor
and reports the comment as re-anchored, in the same spirit as the
viewer's own fallback from a missing cursor ID to its nearest ancestor.

**Copying an address.** A new key in the trace, transcript, overview, and
timeline screens copies the focused row's address to the clipboard, the
way `Y` copies a trace's events. The person pastes it into chat. This
alone removes most of the translation in the problem statement, and it
costs one binding and the clipboard action the shell already owns.

## Comments

### Leaving one

`c` on a focused row opens a one-line prompt at the bottom of the
screen, the same `promptLine` the trace screen uses for search. Enter
saves the text as a comment on that row; Esc cancels. The row gains a
marker in its gutter, `✎`, and the Details pane shows the comment text
under the row's payload, in a `comments` section painted like any other
payload section. A trace's line in the trace picker grows a count, so
`notes · score 0.70` becomes `notes · 3 comments · score 0.70`.

A comment from the agent is drawn the same way, with `⚑` instead of `✎`.
An agent comment that replies to one of the person's comments is always
shown under it, since the person asked for that answer. Any other agent
comment is hidden until `C` toggles agent notes on, so unprompted
agent writing never crowds the person's reading; this is Hunk's rule
too. (`a` is taken: it toggles admin rows on two screens.)

### Where comments live

Comments are not written into the log. The log is append-only and
written by the runtime. Follow mode re-reads it and treats a shrinking
file as rotation; statelog upload, the parser, and the runs explorer all
read it. A human-authored row inside it would have to be skipped by every
one of those readers.

Instead, one `comments.jsonl` file, append-only, in a place chosen by
how the log was opened:

| How the log was opened | Where comments go |
| --- | --- |
| A run directory (`agency logs <runDir>` or a drill-in from the explorer) | `<runDir>/comments.jsonl`, beside `notes.md` and `annotations.jsonl` |
| A loose statelog file | `<file>.comments.jsonl` next to it |
| Stdin, or a remote statelog | no comments in this version; `c` says so |

A comment is keyed by trace ID and row ID, never by file, so a comment
written against a loose file still matches the same trace once that file
is wrapped into a run directory. `wrapTracesAsRunDirectories` in
`lib/runDirectory/mutations.ts` copies the trace's rows into the new
directory; the sidecar is never rewritten, because wrapping copies the
statelog and does not move it.

### The record

```json
{
  "id": "c_8f2a…",
  "traceId": "k3Pq9abc",
  "rowId": "round:span-7f3a:2",
  "anchor": { "at": "2026-10-19T14:02:11.408Z", "thread": "reviewer", "name": "gpt-5" },
  "author": { "kind": "human", "id": "adit" },
  "text": "why does it read the config a second time here?",
  "created": "2026-10-19T14:30:02.000Z"
}
```

`author.kind` is `human` or `agent`. An agent comment carries
`"replyTo": "<comment id>"` when it answers one. The `id` is random, not
content-derived: two identical comments on one row are two comments.
There is no way to resolve a comment in this version; nothing would
write such a row. If it is missed, a `comment resolve <id>` command can
append a resolve row later without changing the rows that exist.

The module that owns the shape, the read, and the fold from rows to
effective comments is `lib/runDirectory/comments.ts`, beside
`annotations.ts`. It follows that module's split: pure shapes and fold
in one file, writing under the run directory's writer lock in
`mutations.ts`. `humanFeedbackFor` in `humanFeedback.ts` includes
effective human comments after `notes.md`, so graders and optimizers
that read human feedback see them with no further change. This is why
comments are run-directory code and not viewer code: the eval value
stays if the viewer feature is removed.

Comments are not rows in `annotations.jsonl`. That file holds opinions
about a trace as a whole, with content-derived IDs and a fold that
decides effective scores. A comment is about one row, has no score, and
needs its own ID. Sharing the file would make every reader of
annotations check a kind it does not understand.

### Reading comments back into the viewer

The viewer reads the comments file once at open, as it does trace
annotations, and passes the result to the screens as data: a map from
row ID to its marks and comment texts, the same way `traceAnnotations`
flows in today. The painters gain one lookup per row and no knowledge of
where comments come from. When the viewer is following a log, it polls
the comments file on the same timer, so a comment added from another
terminal appears without reopening. When the session is open, the
session's own `comment add` appends and re-reads in one step, so no
polling is needed for that path.

## The session

### What it is for

Comments cover "check my comments". The session covers two things a file
cannot:

- **Pointing without typing.** The person puts the cursor on a row and
  says "why did it do this?". The agent reads the focused address and
  answers.
- **Pointing back.** The agent says "the cause is three calls earlier"
  and moves the person's cursor there.

### Registering

When the viewer opens on a local file, it starts a server on a Unix
socket and writes a registry record:

```
<agent home>/log-sessions/<pid>.json
<agent home>/log-sessions/<pid>.sock
```

```json
{ "pid": 48213, "logPath": "/Users/adit/runs/2026-10-19/k3Pq9abc/statelog.jsonl", "commentsPath": "/Users/adit/runs/2026-10-19/k3Pq9abc/comments.jsonl", "cwd": "/Users/adit/project", "started": "2026-10-19T14:28:40Z" }
```

The record names the comments file because the CLI cannot work it out
from the log path alone: a statelog in a run directory and a loose
statelog file keep their comments in different places. A viewer with no
comments store leaves the field out.

The session is opt-in from the viewer's side: the CLI and the explorer
pass the sessions directory, and a viewer opened without it (every unit
test) opens no socket and writes nothing. The viewer removes both files
on quit, including on the `finally` path that already stops the follow
watcher. The terminal's signal handlers exit without that path, so a
viewer also removes any leftover socket and record at its own pid's
paths before it listens.

`session list` probes each record with a timeout and tells three states
apart. A record whose process is gone is stale, and `list` deletes it
and does not show it. A process that is alive and answers is live. A
process that is alive and does not answer in time, as a viewer suspended
with Ctrl+Z is, shows as `not responding` and is kept; a timeout is not
the same as a dead viewer.

The embedded viewer inside the runs explorer goes through the same
`runViewer` call, so it registers too, with the run directory's log as
`logPath`. A viewer on stdin has no log path and does not register; the
person is told so once in the viewer's notice line if they ask for a
session key. Windows has no Unix sockets at these paths, so the viewer
shows the same notice there and the CLI's `get` and `navigate` report no
viewer.

### Choosing a session

Every `session` command picks a viewer like this: `--log <path>` matches
`logPath` exactly after resolving both; otherwise, if one session is
open, that one; otherwise the command refuses and prints the list, one
per line with its log path and pid, and asks for `--log`.

### The protocol

One request per connection, newline-delimited JSON, a reply and close.
Requests name trace IDs and row IDs only, never screens or objects, so a
viewer refactor cannot break the wire.

| Request | Reply |
| --- | --- |
| `{ "op": "get" }` | `{ "traceId", "screen", "rowId", "logPath" }` for the current focus |
| `{ "op": "navigate", "traceId", "rowId" }` | `{ "ok": true }` or `{ "error": "no such trace" \| "no such row" \| "row hidden by filter" }` |
| `{ "op": "reload" }` | `{ "ok": true }` after the viewer re-reads comments |

There is no request that writes a comment. The CLI writes through its
own store, under its own author, and then sends `reload`; a write over
the socket would be saved under the viewer's author, which is the
person.

`navigate` switches trace when needed, then switches to the trace screen
with that row focused, through the host's existing `selectTrace` and
`switchTo(screen, focusId)`, closing the help overlay if it is open. A
row the trace screen is hiding (an admin row, or one removed by the `F`
filter or a `/` search) is not focused; the reply says it is hidden and
the cursor stays, so the person is never silently landed on an
ancestor. The viewer renders after each request, the same way it
renders after a follow update, except while a prompt is open, when the
redraw waits for the prompt to close. A `get` with the trace picker open
reports the picker's selected trace and no row.

### The port

The shell hands the server a small adapter and nothing else:

```ts
type SessionPort = {
  focus(): { traceId: string; screen: ScreenName; rowId: string | undefined };
  navigate(traceId: string, rowId: string | undefined): NavigateResult;
  reloadComments(): void;
  notify(message: string): void;
};
type NavigateResult = "ok" | "no such trace" | "no such row" | "row hidden by filter";
```

The server never touches a file. `reloadComments` is the same refresh
the `c` key and the follow tick use, so there is one path that reads
comments and redraws.

Everything the port needs already exists on `ScreenHost` and `Screen`:
`currentTraceId`, `activeScreen`, `target().focusId()`, `selectTrace`, and
`switchTo`. No screen changes for `get` or `navigate`.

## The CLI

All under one subcommand. Every command takes `--json` for the agent and
prints readable text otherwise, and `--log <path>` to choose a session or,
with no session open, the file to read.

```
agency logs session list
agency logs session get
agency logs session show <address|row id>
agency logs session comments [--trace-id <id>] [--all]
agency logs session comment add <address|row id> "<text>"
agency logs session navigate <address|row id>
```

**With a viewer open**, `get` and `navigate` go over the socket, and the
rest read and write the comments file and tell the viewer to reload.
**With no viewer open**, `show`, `comments`, and `comment add` work on
the files named by `--log`, and `get` and `navigate` say that no viewer
is open and exit non-zero. The agent does not need to know which case
it is in.

### Trace IDs

A row ID is only unique inside one trace, so a command that takes a row
needs a trace. A full address carries it. A bare row ID takes it from
`--trace` (the flag is `--trace` on the session commands, since `logs`
already declares `--trace-id`), else from the open viewer's current trace, else the
command refuses and lists the trace IDs in the file. With no viewer
open, `comments` shows every trace in the file, grouped, since there is
no current trace to prefer. With a viewer open, `comments` shows
the current trace by default and every trace, grouped, with `--all`.
`navigate` with an address whose trace is not the current one switches
the viewer to it.

### Expanded output

"Expanded" means what the person dictates by hand today. `get`, `show`,
and `comments` print each row like this:

```
k3Pq9abc/round:span-7f3a:2
  Thread · reviewer · LLM call 4 of 9 · gpt-5 · 2.1s · $0.004
  input:  (last user message) "Check the config file for stale keys…"
  output: readFile({ path: "config/app.json" })
  comments:
    ✎ adit, 14:30: why does it read the config a second time here?
```

The text comes from the viewer's own payload functions
(`payloadFor`, `roundResponsePayload`, `toolResultPayload` in
`lib/logsViewer/payload.ts`), rendered to plain text through the TUI's
plain-text renderer, so the agent reads what the person reads. `--json`
gives the same facts as fields plus the raw events for the row, so the
agent can go deeper without a second tool.

There is no `review --json` dump of a whole trace. `show` on a row and
the existing `x` extract cover it, and a whole-trace dump invites the
agent to read everything rather than the rows it was pointed at.

## The skill

`.claude/commands/debug-logs.md` today says: grep `log.jsonl` for the
trace. It is replaced by a skill that says, in order:

1. Run `agency logs session get` when the person says "this one", "here",
   or "what I'm looking at". Then `show` on the address it returns.
2. Run `agency logs session comments` when the person says "my comments"
   or "the ones I marked". Answer each, and leave the answer with
   `comment add --reply-to <id>` so it sits on the row.
3. When explaining a row the person is not on, `navigate` to it first.
4. Read raw events only through `show --json`; do not grep the log.

## Keeping the session separate

The session is the piece most likely to be removed, so it is built so
that removal is a deletion:

- All of it lives in `lib/logsViewer/session/`: the server, the
  registry, the protocol types, and the client. The CLI command is one
  directory, `lib/cli/logsSession/`. The skill is one file.
- The session directory imports from the viewer. The viewer imports one
  type from it, `SessionPort`, and that type can move into `run.ts` on
  removal.
- `run.ts` changes in three places: build the port from `host`, start the
  server after the first `render()`, stop it in the `finally` that stops
  the watcher. About ten lines.

Removing the session deletes the directory, the CLI directory, the skill
lines that mention `get` and `navigate`, and those ten lines. Comments,
addresses, the copy key, and `--trace-id` stay, since they do not depend
on it.

The parts that do touch existing screens are the comment marks and the
`c` key, and they are kept to data: marks arrive the way
`traceAnnotations` does, and the prompt is the existing `promptLine`.

## Testing

- `comments.test.ts` in `lib/runDirectory/`: shapes, the fold with
  replies, the two storage locations, the trace's rows copied into the
  child run on wrap with the sidecar unchanged.
- `session/` tests use the viewer's injected input and output, open a
  server on a socket under a temp directory, and drive it with the
  client: `get` after a few key presses reports the cursor, `navigate`
  moves it and the next frame shows it, a stale record is dropped by
  `list` and a not-responding one is kept, two sessions make the CLI
  refuse without `--log`.
- `run.shell.test.ts` gains: `c` writes a record and the next frame shows
  the mark; the copy key puts an address on the clipboard; a comment
  added through the file while following appears on the next poll.
- The CLI tests run each command with no viewer against a fixture run
  directory and check the expanded text and the `--json` fields; one
  test opens a headless viewer and checks that `get` and `navigate` go
  through it.
- A fixture comment whose row ID no longer resolves is reported as
  re-anchored, not dropped.

## Out of scope, left open on purpose

- **Line-level targets.** A comment on one line inside a payload. The
  record can grow an optional `line` field later; nothing here blocks it.
- **Remote comments.** A hosted statelog log has no local file. The
  record is keyed by trace and row, so a server store can adopt it
  unchanged.
- **A web viewer.** It would reuse addresses as long as they stay
  derived from span IDs and ordinals in the log, not from screen layout.
- **Rich agent notes.** Notes with code or links. Plain text first.
