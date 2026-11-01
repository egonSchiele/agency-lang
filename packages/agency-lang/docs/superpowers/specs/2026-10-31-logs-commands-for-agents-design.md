# `agency logs` commands for agents: list traces, print an outline, search rows

Date: 2026-10-31. Status: design, revised after review.

## What this is

This design adds three commands under `agency logs`, gives every logs
command one way to find the log, gives the new commands one shared way to
pick traces, and updates the `debug-logs` skill so agents use the new
commands instead of grepping the log file.

Here is an agent investigating a run it just finished, after this work:

```bash
$ agency logs traces --last 3
log.jsonl · 89 traces · showing the 3 most recent

FxGC_wBKmFGS2tHkxFwlt  2026-10-24 19:55  7.7s    $0.0022   3 calls  agency-agent         "Summarize the README in one line"
KBkZRrYbJRWX0hfg_WNOr  2026-10-24 19:55  4.5s    $0.0006   1 call   agency-agent         "What is 2 + 2?"
XjzSWOdvUfyZ_ZrQoMbGz  2026-10-24 19:46  7m00s   $0.0774  50 calls  agency-agent  error  "Explain the history of the city…"

$ agency logs outline --trace Xjz
log.jsonl · XjzSWOdvUfyZ_ZrQoMbGz · 50 LLM calls · 7m00s · $0.0774 · error

XjzSWOdvUfyZ_ZrQoMbGz/round:anYFPNTCb_Xq:0:user   User turn · Explain the history of the city in a paragraph…
XjzSWOdvUfyZ_ZrQoMbGz/round:anYFPNTCb_Xq:0        Thread · main · LLM call 1 of 50 · gpt-5-mini · 2.0s · $0.0009
XjzSWOdvUfyZ_ZrQoMbGz/span-9c01                     Tool · readFile · failed · 0.1s
XjzSWOdvUfyZ_ZrQoMbGz/leaf:span-9c01:error:0          Error · ENOENT: no such file or directory, open 'src/confg.json'
XjzSWOdvUfyZ_ZrQoMbGz/round:anYFPNTCb_Xq:1        Thread · main · LLM call 2 of 50 · gpt-5-mini · 3.1s · $0.0012
…

$ agency logs search "ENOENT" --trace Xjz
log.jsonl · searched 1 trace · 2 rows matched

XjzSWOdvUfyZ_ZrQoMbGz/span-9c01
  Tool · readFile · failed · 0.1s
  …Error: ENOENT: no such file or directory, open 'src/confg.json'…
XjzSWOdvUfyZ_ZrQoMbGz/round:anYFPNTCb_Xq:4
  Thread · main · LLM call 5 of 50 · gpt-5-mini · 3.1s · $0.0012
  …The read failed with ENOENT, so the path is probably misspelled. I'll list…

$ agency logs session show XjzSWOdvUfyZ_ZrQoMbGz/span-9c01
```

The first command answers "which run was that?". The second prints every
row of one run with its address, so the agent can read what happened and
pick rows to open. The third finds the rows that mention something. The
fourth command already exists: it opens one row by its address.

The trace IDs, times, and costs in the first block are real rows from the
repository's `log.jsonl`. The outline and search hits are made up, to show
the shape.

## Why

Agents read Agency logs by grepping `log.jsonl`, and grep returns far more
text than they need. The repository's own `log.jsonl` shows why:

1. The file is 70 MB, with 2,970 lines and 89 traces.
2. LLM completions are 298 of those lines, but 57 MB of the file.
3. Each completion stores the whole conversation so far (about 130 KB in a
   long run), plus every tool definition (about 25 KB). Only the reply is
   new, and the reply is about 13 KB.
4. Approval decisions are 811 lines. Most are startup checks, such as reading
   `AGENCY_AGENT_HOME`.
5. Lines from different traces are mixed together. The trace ID changes 101
   times from one line to the next across the file.

Because of point 3, a word that appears early in a conversation appears in
every later completion too. One grep can return dozens of lines of about
190 KB each. Because of point 5, "the last trace" is not "the last lines of
the file".

The viewer already solves both problems for a person. It turns a trace into
rows, and its transcript shows each message on the block where it first
appeared. An agent can open a row with `agency logs session show`, which
prints an LLM call in a few lines. But an agent has no way to list the rows
of a run, no way to find a row's address without the viewer open, and no
way to list traces except `--csv`, which is built for spreadsheets.

The right long-term fix for the file size is for a completion to store only
its new messages. That changes the statelog format, which the viewer and
the hosted statelog server also read, so it is a separate ticket. Every
command here is a way of reading the log well while it is still large.

## The commands

### Finding the log (shared by every `logs` command)

Every logs command that reads one log finds it the same way, in this order:

1. `--log <path>`, when given. It takes a statelog file or a run directory,
   which stands for the `statelog.jsonl` inside it.
2. The one open viewer's log. Finding it is a probe of the viewer
   registry, which the `session` commands already do; the new commands
   never talk to the viewer itself. Several open viewers need `--log`, as
   today, and the configured log below does not override that refusal,
   because "say which" is the safer answer.
3. The file `log.logFile` names in `agency.json`, when no viewer is open.
   The path is resolved against the current directory, because that is how
   the runtime opens it when it writes. An empty `logFile` counts as unset:
   `--log stdout` writes `""` there on purpose to cancel a configured file.
   The config is read only when `--log` is absent, so a broken
   `agency.json` cannot stop a command that named its log.
4. Otherwise the command stops with this message:

```text
No log given. Pass --log <file>, set log.logFile in agency.json, or open a viewer with `agency logs <file>`.
```

The order is the same for every command, the new ones included, so that
the skill's steps cannot disagree. Without step 2 on the new commands, an
agent with a viewer open on one run directory and `log.logFile` naming
another would get an address from `search` that `session show` then looks
up in the wrong log.

A directory that holds several run directories is refused, with a message
that points to `agency logs <dir> --csv`. Searching across many runs is not
part of this design.

The first line of output always names the file that was read. An agent that
reads the wrong log finds out from that line.

Today, steps 1 and 2 exist for the `session` commands in
`lib/cli/logsSession/target.ts`, and nothing has step 3. This design adds
step 3 there and exports the log-choosing half as `chooseLog`, so the
`session` commands and the new commands call one function. The
`debug-logs` skill then needs `--log` on none of its steps.

`extract` keeps its positional `<log>` argument. It is a different kind of
command (it writes a file), and giving it both an argument and `--log`
would be two ways to say one thing.

### Picking traces (shared by `outline`, `search`, and `traces`)

These three flags pick traces:

```bash
--trace <id>     # one trace, by full id or a unique prefix
--last <n>       # the n traces that started most recently
--since <when>   # traces that started at or after a time: 30m, 2h, 3d, or an ISO date
```

The rules for these flags:

1. "Most recently" means by start time. Start time is the earliest
   timestamp in the trace, `TraceSummary.startedAt`, which `--csv` already
   sorts by. (The viewer's trace picker lists traces in file order today;
   making it sort the same way is a later change.) Start time is used
   instead of position in the file, because lines from different traces
   are mixed in the file.
2. A prefix that matches more than one trace is refused. The message lists
   the matching IDs. The existing `matchTraceId` already does this.
3. A trace with no readable timestamp sorts as the oldest, and `--since`
   never selects it.
4. A count (`--last`, and `--limit` and `--context` on `search`) must be
   a positive whole number. Commander hands the text over as given, so
   `0`, `-1`, and `abc` are each refused with a message naming the flag.

What each combination of flags selects:

| Flags given | Selection |
| --- | --- |
| none | The command's default, below. |
| `--trace` | That one trace. |
| `--last n` | The n that started most recently. |
| `--since t` | Every trace that started at or after t. Not capped. |
| `--last n --since t` | The n most recent among those that started at or after t. |
| `--all` | Every trace. |
| `--trace` with `--last`, `--since`, or `--all` | Refused: `--trace names one trace; drop --last, --since, and --all`. |
| `--all` with `--last` | Refused: `--all and --last disagree about how many`. |
| `--all --since t` | Refused, the same way. `--since` alone already means every match. |

The default applies only when none of the four flags is given:

| Command | Default |
| --- | --- |
| `traces` | The 20 most recent traces. The footer says how many older traces there are. |
| `outline` | The most recent trace. The header names it, so an agent that meant another run sees which one it got. |
| `search` | The most recent trace. Searching all 89 traces in the 70 MB file takes about 1.2 seconds (0.35 s to read the file and 0.85 s to build every trace's transcript blocks), so `--all` is still cheap. |

The default for `search` and `outline` is the most recent trace because
that is what the skill tells an agent to look at first, and the plain
command should do what the skill teaches.

These rules live in one pure function. It takes the traces and the parsed
flags, and returns the selected traces or a refusal message. All three
commands call it, so the rules cannot drift apart.

`extract` does not take these flags. It copies one trace, and an agent
finds the trace with `traces` first. The two refusals `extract` prints,
for a log with several traces and for a `--trace` that matches nothing,
now point at `agency logs traces --log <log>` instead of printing their
own table. The table it prints
today (`describeTraces` in `lib/cli/runDirectory/traceListing.ts`) is
replaced by that pointer, so there is one trace listing and not two.

### `agency logs traces`

`traces` prints one line per trace, newest first:

```text
log.jsonl · 89 traces · showing the 20 most recent

FxGC_wBKmFGS2tHkxFwlt  2026-10-24 19:55  7.7s    $0.0022   3 calls  agency-agent         "Summarize the README in one line"
XjzSWOdvUfyZ_ZrQoMbGz  2026-10-24 19:46  7m00s   $0.0774  50 calls  agency-agent  error  "Explain the history of the city…"
…
69 older traces. Pass --all to list them, or --since to pick by time.
```

Each line has these columns, in this order:

1. The full trace ID, so it can be pasted into `--trace` or an address.
2. The start time, in local time.
3. Working time. Time spent waiting for the person between turns is left
   out, as on every other screen.
4. Cost.
5. The number of LLM calls.
6. The agent name, when the log recorded one.
7. `error` when the trace logged an error. The column is blank otherwise.
8. The first user message, cut to fit one line.

The first user message is the column an agent uses most. It is how the
agent tells "the run where I asked about the README" from the others.

All of these facts already exist as `TraceSummary` in
`lib/logsViewer/traceSummaries.ts`, which the trace picker uses. `traces`
prints those records and adds nothing new.

`traces` takes the trace-picking flags and `--all`. It also takes
`--errors`, which keeps only traces that logged an error.

With `--json`, `traces` prints an object instead:

```json
{
  "log": "/Users/adit/agency-lang/packages/agency-lang/log.jsonl",
  "total": 89,
  "traces": [
    {
      "traceId": "XjzSWOdvUfyZ_ZrQoMbGz",
      "startedAt": "2026-10-24T19:46:57.361Z",
      "workingMs": 420618,
      "costUsd": 0.077422,
      "tokens": 61234,
      "calls": 50,
      "agentName": "agency-agent",
      "hasError": true,
      "ask": "Explain the history of the city in a paragraph before giving your answer. What is the capital of France?…"
    }
  ]
}
```

The JSON keeps the whole first message. Times are ISO strings.

### `agency logs outline`

`outline` prints every row of one trace, in the order the viewer's trace
screen shows them, one line per row: the address, then the header line
that `session show` prints for that row, indented by the row's depth.

```text
log.jsonl · XjzSWOdvUfyZ_ZrQoMbGz · 50 LLM calls · 7m00s · $0.0774 · error

XjzSWOdvUfyZ_ZrQoMbGz/round:anYFPNTCb_Xq:0:user   User turn · Explain the history of the city in a paragraph…
XjzSWOdvUfyZ_ZrQoMbGz/round:anYFPNTCb_Xq:0        Thread · main · LLM call 1 of 50 · gpt-5-mini · 2.0s · $0.0009
XjzSWOdvUfyZ_ZrQoMbGz/span-9c01                     Tool · readFile · failed · 0.1s
XjzSWOdvUfyZ_ZrQoMbGz/leaf:span-9c01:error:0          Error · ENOENT: no such file or directory, open 'src/confg.json'
```

This is the command an agent runs to answer "what happened in this run?".
A fifty-call run is about 150 lines, which an agent can read whole and then
open the rows it cares about with `session show`.

The rows are `storyOutline` from `lib/logsViewer/story.ts`, the same rows
the trace screen draws, with the same two things hidden by default:

1. **Approved interrupts.** The trace screen hides them until `p` is
   pressed. In the repository's `log.jsonl` they are 418 of the 1,317
   outline rows, mostly startup reads of environment variables and skill
   folders; the largest trace has 75 of them. An agent would read a third
   of the outline as noise, which is the problem these commands exist to
   fix. Rejected and pending interrupts always show. `--approvals` shows
   the approved ones, matching `p`. The rule the screen applies in
   `matches()` moves into a pure function in `story.ts` that both call.
2. **Handler decisions.** `--admin` adds them under each interrupt, as
   the viewer's admin toggle does.

There is no flag for the viewer's `m` view. That view does not add rows to
the story; it replaces the story with the raw span tree, whose row ids
differ. It is unlikely to help an agent.

The header line per row is `headerLine` in `lib/logsViewer/rowText.ts`,
which is private today and becomes an export. A user turn's or an error's
header is the first line of its text, and a prompt written as one
paragraph is one line of thousands of characters, so the outline and
search cut every header to a fixed width (`oneLine`, 120 characters).
`session show` keeps the full header. The header of the whole output is
the trace's `TraceSummary`.

`outline` takes the trace-picking flags. With `--last 2` or `--since`, it
prints each selected trace in turn, newest first, each under its own
header. With `--json`, it prints an object with the log path and one record
per row: `address`, `rowId`, `kind`, `depth`, and `header`.

### `agency logs search <pattern>`

`search` finds the rows whose own content contains the pattern. It prints
each matching row's address, its header line, and a short snippet around
the first match. The header line is the same one `session show` and
`outline` print.

```text
log.jsonl · searched 1 trace · 14 rows matched · showing 14

XjzSWOdvUfyZ_ZrQoMbGz/round:anYFPNTCb_Xq:0:user
  User turn · Explain the history of the city in a paragraph before giving…
  …Explain the history of the city in a paragraph before giving your answer…
XjzSWOdvUfyZ_ZrQoMbGz/span-9c01  (3 matches)
  Tool · readFile · completed · 0.2s
  …"filename": "docs/history.md"…
```

#### What "own content" means

Each piece of text belongs to exactly one row, the row where it first
appeared. A search matches a row only on the text that row owns. A word in
the first user message therefore matches one row, the user row. It does
not match the 49 LLM calls that carried that message again as history.

The viewer's transcript already works this out. `transcriptBlocks` in
`lib/logsViewer/transcript.ts` walks a trace's rounds and keeps, per
thread, a record of every message a block has already stood for. A system
prompt becomes one block on the first call that carried it. A user message
becomes one block. A call's reply becomes one assistant block. A tool's
result sits on the tool block. After a compaction or a history rewrite,
only the messages that changed get new blocks. The matching rule,
`represents`, also handles cases a plain message comparison would miss,
such as the assistant message a handoff leaves in the caller's history
with some of its tool calls stripped. And `transcriptText` already returns
the text of each block.

Search is therefore a filter over transcript blocks:

```ts
transcriptBlocks(trace).filter((block) => matcher(transcriptText(block)))
```

Nothing new decides what a row owns. The table below says what that gives
for each kind of block, so the behaviour is written down, but it is a
description of `transcriptText`, not a second rule:

| Block | The text it owns |
| --- | --- |
| System | The system or developer message, on the first call of each thread that carried it. |
| User | A user message, on the call where it first appeared. |
| Assistant | The reply text, and the name, id, and arguments of each tool call the model requested. |
| Tool | The tool's name, its status, its error messages, its arguments, its full result, what the model read when that differs, and its interrupts. |
| Hosted | The tool's name and the items the provider recorded for it. |
| History | A message that reappeared after a rewrite, with its role and name. |
| Error | The error message, for an error outside any tool call. |

Thread groups, turns, pauses, and rewrite headings are not searched.

Two things the rule does not give, said plainly:

1. **A tool call's arguments appear on two rows.** The assistant block
   carries each requested call's name and arguments, and the tool block
   carries the arguments again. A search for a file name passed to `read`
   hits the LLM call that asked and the tool that ran. Both hits are
   useful, so they stay two hits.
2. **Interrupts outside a tool call are not searched.** The transcript has
   no interrupt block; an interrupt's text reaches search only inside its
   tool's block. The largest trace in `log.jsonl` has 24 interrupts at the
   top level, outside any tool. The outline shows them. `--kind` has no
   `interrupt` for that reason.

Runtime state is not searched, because no block carries it. That covers
the node state stored when a node starts and ends, the graph, and the tool
definitions. These make up a large part of the file. An agent asking
"where did the run mention X?" wants the conversation and the tools.

#### Which address a hit prints

A transcript block's id is not always a story row id. A tool or hosted
block uses the story row's id, but a system block is
`system:<round id>:<position>`, a user block is
`<round id>:user:<position>`, and an error block is `error:<node id>`.
`session show` resolves story row ids (`findRow`), so a hit prints the
story row nearest to its block.

The transcript screen already has this mapping, in `selectedRowId()`,
for the `A` key that copies a block's address. It covers tool, hosted,
assistant, and user blocks. Rather than write a second one beside it,
the mapping moves into `transcript.ts` as one pure function,
`blockRowId(block, story)`, gains the cases search needs, and both the
screen and search call it. The screen gains addresses for system,
history, and error blocks as a side effect.

| Block | The story row the hit names |
| --- | --- |
| Tool, hosted | The block's own id. It is the story row's id. |
| Assistant, history, rewrite | The block's `roundId`, the LLM call. |
| System | The LLM call that first carried it. A system block has `roundId: undefined` today, because the screen reads `roundId` to decide focus, and the round survives only in the block's id, which the contract forbids parsing. The block gains an `ownerRoundId` field that names the call. |
| User, hand-back | The call's user row, `<round id>:user`, when the story outline has one for that call; otherwise the call. |
| Error | The story row whose `node.id` equals the error's node id. |
| Thread, turn, pause | Not searched. |

The mapping goes through the story outline and never parses a row id,
which keeps the row-ID contract in `docs/dev/cli/logs-viewer.md`. Two
blocks that map to the same row (a system block and its call, say) are one
hit with both matches counted.

#### Flags

```bash
--trace, --last, --since   # pick traces, as above; --all searches every trace
--kind <kinds>             # only these row kinds, comma separated: user,call,tool,hosted,error
--regex                    # treat the pattern as a JavaScript regular expression
--case-sensitive           # match case; the default ignores it, as the viewer's search does
--limit <n>                # print at most n rows (default 30)
--context <n>              # characters of snippet on each side of the match (default 60)
--json                     # print an object instead of text
```

`--kind` names the block kinds a hit came from, mapped to the words an
agent would use: `user` for user and history blocks, `call` for system and
assistant blocks, `tool`, `hosted`, and `error`.

Rows print newest trace first, the same order `traces` uses. Within a
trace, rows print in transcript order. When more rows match than `--limit`
allows, the footer says how many were left out and how to narrow the
search:

```text
212 more rows matched. Narrow with --trace, --kind, or a longer pattern, or raise --limit.
```

The snippet is one line. Runs of whitespace, newlines included, become one
space. When a row matches more than once, the address line says how many
times, and the snippet shows the first match.

A pattern that starts with `-` is read by commander as a flag; the docs
show `agency logs search -- --force` for that case. An invalid `--regex`
pattern is refused with the parser's message. Finding no rows is not an
error. The command prints `no rows matched` and exits 0,
so an agent running it under `set -o pipefail` does not mistake "nothing
found" for a failure.

#### `--json`

```json
{
  "log": "/Users/adit/agency-lang/packages/agency-lang/log.jsonl",
  "pattern": "ENOENT",
  "tracesSearched": 1,
  "matched": 2,
  "omitted": 0,
  "hits": [
    {
      "address": "XjzSWOdvUfyZ_ZrQoMbGz/span-9c01",
      "traceId": "XjzSWOdvUfyZ_ZrQoMbGz",
      "rowId": "span-9c01",
      "kind": "tool",
      "header": "Tool · readFile · failed · 0.1s",
      "matches": 1,
      "snippet": "Error: ENOENT: no such file or directory, open 'src/confg.json'"
    }
  ]
}
```

The JSON does not include the matching text in full, or the row's raw
events. `session show --json` gives those for one row.

#### Reading a long match

`session show` cuts a tool result after 600 characters, so a match deep in
a long result can fall outside what `show` prints. The search snippet
shows the text around the match, which is usually enough. When it is not,
`--context` widens the snippet, and `session show --json` has the full
event. Making `show` print a chosen part of a long result is a separate
change, not part of this design.

### The `debug-logs` skill

`skills/debug-logs/SKILL.md` covers one case today: the person points at
rows in an open viewer. The new version covers a second case too: an agent
looking at a run on its own, with no viewer open. The second case gets
these steps:

1. **Find the run.** Run `agency logs traces --last 5`. Match the run by
   its first message and its time. If the person named a run by ID, skip
   this step.
2. **Read the outline.** Run `agency logs outline --trace <id>`. It prints
   every row with its address. For a run with a few hundred rows this is
   the whole story; read it before searching.
3. **Find the rows.** Run `agency logs search <words> --trace <id>` when
   the outline is long or the person named a word, a file, or an error.
   Narrow with `--kind error` or `--kind tool`.
4. **Read a row.** Run `agency logs session show <address>` on an address
   from the outline or the search results.
5. **Never grep the log file, and never `cat` it.** A completion line can
   be hundreds of kilobytes.

None of the steps need `--log` when a viewer is open or `agency.json`
names the log. Otherwise the skill says to pass `--log <file>` to each
command.

The skill's description also changes, so that it triggers on "look at the
logs", "what happened in the last run", and "why did that run fail", and
not only on comments in the viewer.

The skill ships in the npm package, and `agency skills install` writes a
stub that runs `agency skills show debug-logs`. Installed copies therefore
pick up the new text with the next release, with no reinstall.

## Where the code goes

All new logic is pure and lives beside the code it reuses. The CLI files
only parse flags, call the pure functions, and print.

| File | What it holds |
| --- | --- |
| `lib/cli/logsSession/target.ts` | `chooseSession` becomes the exported `chooseLog`, with the `log.logFile` step and the directory-of-runs refusal. The session commands and the new commands both call it. |
| `lib/logsViewer/transcript.ts` | `ownerRoundId` on system blocks, and `blockRowId`, the block-to-row mapping the screen and search share. |
| `lib/logsViewer/story.ts` | The approved-interrupt rule the trace screen applies, as a pure function the outline calls too. |
| `lib/runDirectory/traceSelection.ts` | The trace-picking function and the `--since` parser. |
| `lib/logsViewer/rowSearch.ts` | The search over one trace: transcript blocks to hits, snippets. |
| `lib/logsViewer/outlineText.ts` | One trace's outline as lines and records. |
| `lib/cli/logsQuery/traces.ts` | The `traces` command: a function from parsed options to output text and an exit code. |
| `lib/cli/logsQuery/outline.ts` | The `outline` command, in the same shape. |
| `lib/cli/logsQuery/search.ts` | The `search` command, in the same shape. |
| `lib/cli/logsQuery/register.ts` | Adds `traces`, `outline`, and `search` to the `logs` command, as `logsSession/register.ts` does for `session`. |
| `lib/cli/runDirectory/extract.ts` | The several-traces refusal points at `agency logs traces`. `traceListing.ts` is deleted. |

The new code reuses these existing pieces instead of rewriting them:

1. `readTraces` and `matchTrace` in `lib/runDirectory/traces.ts`, for
   reading the log and matching a prefix.
2. `resolveTarget` and `chooseSession` in `lib/cli/logsSession/target.ts`,
   for finding the log.
3. `buildForest` and `storyOutline`, for a trace's rows.
4. `traceSummaries`, for the `traces` columns and the `outline` header.
5. `transcriptBlocks` and `transcriptText`, for what each row owns.
6. `headerLine` in `lib/logsViewer/rowText.ts`, for the header `outline`
   and `search` print. It is private today and becomes an export.
7. `selectedRowId` in the transcript screen, which becomes `blockRowId`
   in `transcript.ts`.

The new commands declare `--log`, `--json`, and `--trace` themselves, with
their own help text. The `session` commands' helper describes `--trace`
as "the trace a bare row id belongs to", which is not what it means on
`search`.

### Flag names

Each new flag is declared on the command that uses it. The vendored
commander refuses a flag that a parent command already declares.
`logs` declares `--trace-id`, `--follow`, and `--csv`, and none of the new
flags reuse those names. The trace flag is `--trace`, as on `extract` and
the `session` commands. `--log` and `--json` mean the same thing they mean
on the `session` commands.

## Tests

These cases go in unit tests over the pure modules, using small statelog
fixtures. The ownership cases reuse the transcript's existing fixtures
where one fits, since the rule under test is the transcript's.

1. **Ownership.** A word in the first user message of a trace with five
   calls matches one row, the user row.
2. **Tool results.** A word in a tool result matches the tool row, and not
   the call that read the result.
3. **Long results.** A word after the first 600 characters of a tool
   result is still found.
4. **System prompts.** A word in the system prompt matches the first call
   on the thread, and no later call.
5. **History rewrites.** After a compaction, a message that is new again
   matches on the call where it reappeared.
6. **Runtime state.** A word that only appears in node state matches
   nothing.
7. **Addresses.** Every address a search hit or an outline line prints
   resolves with `findRow`, for every row kind in the fixture. The screen's
   `A` and search print the same address for the same block.
8. **Order.** Picking traces with lines mixed in the file orders them by
   start time, not by file position.
9. **Flag rules.** Every row of the combinations table, each refusal
   included. An ambiguous prefix lists the matches. A trace with no
   timestamp sorts oldest, and `--since` skips it. `--last 0`, `--last -1`,
   and `--last abc` are refused, and the same for `--limit` and `--context`.
10. **`--since` parsing.** `30m`, `2h`, `3d`, and an ISO date are accepted.
    `2x` is refused with a message.
11. **Snippets.** Newlines collapse to spaces, the match count is right,
    and `--context` changes the width.
12. **Limits.** With more hits than `--limit`, the footer counts the rest.
13. **Log path.** `--log` wins over the open viewer and `log.logFile`. The
    one open viewer wins over `log.logFile`, for `search` as well as for
    `session show`. Two open viewers and a configured log is still the
    "say which" refusal. `log.logFile` is used when nothing else names a
    log. An empty `logFile` counts as unset. A missing config gives the
    refusal message. A directory of run directories is refused. The
    viewer-on-one-log, config-on-another scenario: `search` and
    `session show` read the same file.
14. **Outline.** The lines are the story outline's rows in order, each
    with its depth and header. An approved interrupt is hidden by default
    and a rejected one is kept; `--approvals` shows the approved one;
    `--admin` adds handler decisions.
15. **Headers.** A user turn whose first line is 2,000 characters prints
    a cut header in the outline and in search, and the full one in
    `session show`.

The commands also get one test each through the command tree, so a flag
that the vendored commander refuses at registration fails a test and not a
user. After the build, the real binary runs once against the repository's
`log.jsonl`, to check that the commands start and print.

## Docs

1. `docs/site/cli/logs.md` gets a section, "Reading logs from a script or
   an agent", with `traces`, `outline`, `search`, the trace-picking flags,
   and the order a log is found in.
2. `docs/dev/cli/logs-viewer.md` gets a short section on the commands: why
   search is a filter over transcript blocks, the block-to-row mapping,
   and the one place a log is found.
3. The `extract` help text and its docs mention the new refusal.

## Not in this design

These came up in the same discussion and are left for later:

1. **A size limit on `session show`**, with a way to read the rest of a
   long result.
2. **A transcript command** that prints one thread's conversation once,
   as the viewer's transcript screen does. `transcriptText` makes this
   cheap; it is left out only to keep this change small.
3. **A line that says how a run ended**, at the top of the outline.
4. **Writing less to the log.** A completion could store only its new
   messages. This would shrink the file by about 80%, but it changes the
   statelog format, which the viewer and the hosted statelog server also
   read. It gets its own ticket.
5. **Searching across many run directories.**

## Open questions

1. **The default for `traces`.** Twenty traces is a guess at what fits a
   screen and an agent's context. It could be ten.
