# Statelog readers in `std::statelog`

## The problem

An Agency program cannot read a statelog that holds more than one trace.

`std::statelog` has `evalRecord` and its relatives. They read a file that
holds a single trace, and they return one record built for grading.

A long-running program writes every run to one log file. To ask "which
runs failed today" or "what did the last run do", the program has to
shell out to `agency logs traces --json` and parse the output. That
needs the CLI on the path and a shell the program is allowed to use.

The CLI already answers these questions well. `agency logs traces`,
`outline`, `search`, and `session show` were built for an agent to read
a large log a little at a time. This spec makes the same four readers
callable from Agency code.

This is the first step toward offering what the `agency` CLI does through
the standard library.

## What is added

Four functions in `std::statelog`. Each one is the Agency form of one CLI
command and returns that command's `--json` output plus its text.

| Function | CLI command | Answers |
| --- | --- | --- |
| `logTraces` | `agency logs traces` | Which runs are in this log? |
| `logOutline` | `agency logs outline` | What happened in this run, row by row? |
| `logSearch` | `agency logs search` | Which rows mention this text? |
| `logRow` | `agency logs session show` | What is in this one row? |

The names start with `log` because `traces` and `search` say too little
once they are imported into a program.

A program uses them in the same order an agent uses the commands: list
the traces, outline one, then open the rows that matter.

```ts
import { logTraces, logOutline } from "std::statelog"

node main() {
  const recent = logTraces("./statelog.jsonl", { since: "1d" }, errorsOnly: true)
  if (isFailure(recent)) {
    return recent
  }
  for (trace in recent.value.traces) {
    const outline = logOutline("./statelog.jsonl", { trace: trace.traceId })
    if (isSuccess(outline)) {
      print(outline.value.text)
    }
  }
}
```

One change is made to the CLI as well: a trace's summary now counts its
tool calls and how each one ended. See "Counting tool calls" below.

## Picking the log

Every function takes the log as a path to a statelog file. A relative
path is relative to the working directory.

An empty string means the log this run is writing to, which is
`log.logFile` from the run's config. This is what a program uses to read
its own history. It is a failure when the run has no log file, and when it
has one but isn't writing to it because observability is off. That file
would hold only what earlier runs left in it.

Two things the CLI accepts are not carried over:

1. The log of the one open viewer. A program should not change what it
   reads because a person has a viewer open.
2. A run directory in place of its statelog. A program names the file.

## Reading is an effect

Each function reads a file, so each one raises `std::read`, the effect
`read` raises. The payload has the two fields the effect declares:

```ts
{ dir: "/real/path/to/logs", filename: "statelog.jsonl" }
```

`dir` is the real directory that holds the log, with links followed
once, and `filename` is the log's name inside it. This is the spelling a
policy sees and the spelling the read then uses.

The effect is `std::read` and not a new one for two reasons. A policy
that already allows reads under a directory covers a log in that
directory with no new rule. A policy that asks before any read asks
before this one too, which is right: a log holds every prompt and every
tool result of the runs in it.

The functions carry `@capabilities(fileRead)`, like `read`.

The file is read through the host's file part (`host.files`), so the
containment rules of `docs/dev/stdlib/contained-files.md` hold: a
symlink below the approved directory is refused.

The functions take no `allowedPaths`. The effect is the gate. A program
that hands a reader to a model fixes the `log` argument first, so the
model cannot point it at another file:

```ts
const tools = [logTraces.partial(log: "./statelog.jsonl")]
```

## Results and failures

Each function returns a `Result`, as `read` does.

A failure carries the message the CLI prints for the same mistake.
Examples are a rejected `std::read`, a `trace` prefix that matches two
traces, and `all` given with `last`.

A log that does not exist is the exception. Its real path is taken before
the approval, as `loadModelData` takes it, so it fails there with the
host's message for a missing path. The CLI's message for it is not used.

The CLI's messages name flags, such as `--trace names one trace; drop
--last, --since, and --all`. From Agency code the same message names the
fields: `trace names one trace; drop last, since, and all`. The function
that writes these messages takes the spelling of each name from its
caller, so there is still one set of rules and one set of messages.

A function that finds nothing succeeds. `logSearch` with no match
returns `matched: 0` and an empty `hits`.

## Picking the traces

`logTraces`, `logOutline`, and `logSearch` take one selection value. It
has the four fields the CLI has as flags.

```ts
export type StatelogTraceSelection = {
  trace?: string;   // a full trace id, or a prefix that matches one trace
  last?: number;    // the n traces that started most recently
  since?: string;   // "30m", "2h", "3d", or an ISO date
  all?: boolean     // every trace
}
```

The rules are the CLI's rules, from the same function (`selectTraces`).
A field set to `null` counts as left out. A model that calls these
functions as tools usually sends every field of `select`, with `null` in
the ones it doesn't use.

| Fields given | Selection |
| --- | --- |
| none | The function's default: 20 traces for `logTraces`, the most recent trace for `logOutline` and `logSearch`. |
| `trace` | That one trace. |
| `last` | The n that started most recently. |
| `since` | Every trace that started at or after that time. |
| `last` and `since` | The n most recent among those. |
| `all` | Every trace. |
| `trace` with any other field, or `all` with `last` or `since` | A failure. |

`last`, and `limit` and `context` on `logSearch`, must be positive whole
numbers. Anything else is a failure that names the field. One function
holds this rule for the CLI and the library.

## Counting tool calls

Today a trace's summary has one fact about trouble: `hasError`, which is
true when the trace logged an `error` event anywhere. A failed tool call
always logs one, inside the tool's span, whether the tool threw or
returned a failure (`recordFailure` in `lib/runtime/prompt.ts`). So
`hasError` can't tell "one tool failed and the model carried on" from
"the run crashed". It also says nothing about a tool call a person
rejected, or one that never finished.

The logs viewer already sorts every tool call into one of five statuses
(`classifyTool` in `lib/logsViewer/story.ts`): completed, failed,
rejected, awaiting approval, and unfinished. The trace summary gains five
counts:

| Field | Counts |
| --- | --- |
| `toolCalls` | Every tool call in the trace. |
| `toolsFailed` | Tool calls that logged an error and did not complete. |
| `toolsRejected` | Tool calls whose interrupt was rejected. |
| `toolsUnfinished` | Tool calls with no completion, no error, and no pending or rejected interrupt. |
| `otherErrors` | `error` events no failed tool call accounts for, such as a run that crashed, or an error inside a tool that went on to complete. |

A tool call that is awaiting approval is in `toolCalls` only. It belongs
to a paused run, and nothing has gone wrong with it.

The counts are part of `TraceSummary`, so both the library and the CLI
get them:

1. `agency logs traces --json` and `agency logs outline --json` gain the
   five fields on each trace.
2. The marker column of the `agency logs traces` table, which reads
   `error` today, lists what went wrong, joined with commas: `error` when
   `otherErrors` is above zero, then `2 failed`, `1 rejected`, and
   `1 unfinished`. A trace whose only trouble is two failed tools reads
   `2 failed`. It is empty for a clean trace.
3. The summary line of `agency logs outline` gains the same words.

`hasError` keeps its meaning, so `--errors` does too: it keeps the traces
that logged an error, which includes every trace with a failed tool call.
The viewer's trace picker is not changed.

## The functions

### `logTraces`

```ts
@capabilities(fileRead)
export idempotent def logTraces(
  log: string = "",
  select: StatelogTraceSelection = {},
  errorsOnly: boolean = false,
): Result<StatelogTraceList> raises <std::read>
```

```ts
export type StatelogTrace = {
  traceId: string;
  startedAt: string | null;   // ISO time
  workingMs: number | null;   // waits for a person between turns are left out
  costUsd: number;
  tokens: number;
  calls: number;              // LLM calls
  agentName: string | null;
  hasError: boolean;
  otherErrors: number;
  toolCalls: number;
  toolsFailed: number;
  toolsRejected: number;
  toolsUnfinished: number;
  ask: string | null          // the first user message
}

export type StatelogTraceList = {
  log: string;                // the absolute path that was read
  total: number;              // traces in the log
  older: number;              // traces the selection left out
  traces: StatelogTrace[];    // newest first
  text: string
}
```

`errorsOnly` is `--errors`: it keeps the traces that logged an error,
before the selection counts them. A failed tool call logs one, so these
include every trace with a failed tool call. `{ last: 5 }` with
`errorsOnly` is the five most recent such traces.

### `logOutline`

```ts
@capabilities(fileRead)
export idempotent def logOutline(
  log: string = "",
  select: StatelogTraceSelection = {},
  approvals: boolean = false,
  admin: boolean = false,
): Result<StatelogOutline> raises <std::read>
```

```ts
export type StatelogRow = {
  address: string;   // "<trace id>/<row id>", the value logRow takes
  rowId: string;
  kind: string;      // "user", "round", "tool", "interrupt", "error", ...
  depth: number;
  header: string     // one line, at most 120 characters
}

export type StatelogRows = { rows: StatelogRow[] }

export type StatelogOutlinedTrace = StatelogTrace & StatelogRows

export type StatelogOutline = {
  log: string;
  traces: StatelogOutlinedTrace[];
  text: string
}
```

This is the CLI's JSON as it is: a trace's fields with `rows` beside
them.

`approvals` shows approved interrupts, which are hidden by default.
`admin` also shows the handler decisions under each interrupt.

A tool row's header carries its status, so the failed, rejected, and
unfinished tool calls that `logTraces` counted can be found by reading
the rows.

### `logSearch`

```ts
@capabilities(fileRead)
export idempotent def logSearch(
  pattern: string,
  log: string = "",
  select: StatelogTraceSelection = {},
  kinds: string[] = [],
  regex: boolean = false,
  caseSensitive: boolean = false,
  limit: number = 30,
  context: number = 60,
): Result<StatelogSearchResult> raises <std::read>
```

```ts
export type StatelogHit = {
  address: string;
  traceId: string;
  rowId: string;
  kind: string;      // "user", "call", "tool", "hosted", or "error"
  header: string;
  matches: number;   // matches inside this row
  snippet: string    // the first match with `context` characters each side
}

export type StatelogSearchResult = {
  log: string;
  pattern: string;
  tracesSearched: number;
  matched: number;   // rows that matched
  omitted: number;   // matched rows past `limit`
  hits: StatelogHit[];
  text: string
}
```

A row is searched on its own text only. A word that is repeated in the
history of every later LLM call is found once, on the row where it first
appeared.

`kinds` narrows the search to those kinds of row. An empty list searches
every kind. A name that is not a kind is a failure.

### `logRow`

```ts
@capabilities(fileRead)
export idempotent def logRow(
  address: string,
  log: string = "",
  maxChars: number = 0,
): Result<StatelogExpandedRow> raises <std::read>
```

```ts
export type StatelogExpandedRow = {
  address: string;
  kind: string;
  header: string;
  text: string;                    // the row as the logs viewer shows it
  truncated: boolean;              // `text` was cut to `maxChars`
  events: Record<string, any>[];   // the statelog events behind the row
  providerItems?: Record<string, any>[]  // a hosted row's items, as the provider sent them
}
```

`address` is a value from `StatelogRow.address` or `StatelogHit.address`.

A hosted row, such as a provider's own web search, has no events. Its
`providerItems` hold what the provider sent, the field `session show
--json` prints.

`session show` also prints the review comments on a row and can read the
row a viewer has focused. `logRow` does neither. It reads one row from
one log.

## Size caps

A row can be long. The row for an LLM call holds the reply and every
tool call the model made, and the row for a tool call holds its whole
result. A program that passes rows to a model needs a bound.

`maxChars` on `logRow` is that bound. `text` is at most `maxChars`
characters, the marker included. A longer text is cut at the end and
finishes with `…[truncated N chars]`, the marker the log itself uses, and
`truncated` is true. `0`, the default, means no cap.

`maxChars` is `0` or a whole number of at least 100. Anything else is a
failure that names the field. Below about 24 characters the marker alone
is longer than the cap, so a small cap can't keep its promise.

`events` is not capped. It is the raw record, for a program to pick
fields out of. A program that sets `maxChars` and passes the result to a
model passes `text` and drops `events`. Each string inside `events` is
already bounded by `log.maxValueChars`, which the writer applied.

The other three functions are bounded by what they return:

| Function | Bound |
| --- | --- |
| `logTraces` | One line per trace. `last` sets how many. |
| `logOutline` | One line of at most 120 characters per row. |
| `logSearch` | `limit` rows, each with a snippet of `context` characters a side. |

## `text`

Every result has a `text` field. It is what the CLI prints without
`--json`.

That text was written for an agent to read: one line per trace or row,
addresses first, a closing line that says how to see more. A program
that gives these functions to a model as tools can return `text` and
nothing else. A program that counts or filters uses the other fields.

The closing lines of the CLI text name flags (`Pass --all to list
them`). From Agency code they name the fields, by the same mechanism as
the failure messages.

## Where the code goes

The four commands are already functions from options to a result, with
no access to the process. They live in `lib/cli/logsQuery/`, and
`session show` builds its row with `expandRow` in
`lib/logsViewer/rowText.ts`.

1. Move `shared.ts`, `traces.ts`, `outline.ts`, `search.ts`, their
   tests, and `queryFixture.ts` from `lib/cli/logsQuery/` to
   `lib/logsQuery/`. `register.ts` stays in `lib/cli/logsQuery/`, since
   it is the part that knows about commander and stdout. The standard
   library then does not import from `lib/cli`.
2. Add `lib/logsQuery/row.ts`. It splits an address against the log's
   trace ids, calls `expandRow` with no comments, and applies
   `maxChars`.
3. Add the tool counts to `TraceSummary` in
   `lib/logsViewer/traceSummaries.ts`.
4. Add the four bindings to a new file, `lib/stdlib/statelogReaders.ts`,
   and not to `lib/stdlib/statelog.ts`. `safeBash` and the REPL import
   `statelog.ts`, so readers there would load the logs viewer into every
   program that uses either. The new file reaches `fs` through
   `lib/runDirectory/traces.ts`, so it joins `NODE_ONLY` in
   `eslint.node-exceptions.mjs`.
5. Add the types and the four functions to `stdlib/statelog.agency`.
   One private function there takes the log's real path with
   `_realTarget`, as `loadModelData` does, and raises `std::read` with its
   `dirname` and `basename`. The four call it. An empty `log` is turned
   into the run's own log file first, by one small binding.

The CLI and the standard library call the same functions. A change to
what `agency logs traces` reports changes `logTraces` with it.

Three things differ between the CLI's call and the library's:

| | CLI | Library |
| --- | --- | --- |
| Finding the log | `--log`, the open viewer, or `log.logFile` | The `log` argument, or the run's own log file |
| Reading the file | `readTraces`, straight from disk | `host.files.readChunks` under the approved directory |
| Names in messages | Flags (`--last`) | Fields (`last`) |

The file is read in chunks and split into lines as it arrives, so its
text is never one string. The line splitter the CLI's reader uses
(`makeLineSplitter`) takes those chunks as they are.

## Cost of a call

Every call reads the whole log file and builds the traces it needs.
Nothing is cached between calls.

The earlier measurement on a 70 MB log with 89 traces was 0.35 seconds
to read the file, and 0.85 seconds more to search every trace. Building
the traces is synchronous, so a server that calls these functions does
nothing else for that part of the time.

This is acceptable for a first version. Logs are much smaller now that
events are capped. A program that reads a very large log on a busy
server should run the read in a subprocess.

Counting tool calls adds work to every trace summary, which the CLI and
the viewer's trace picker build for every trace in a log. The counts come
from each tool span alone, so they don't build the story outline. The plan
measures `agency logs traces --all` before and after on a large log.

## Decisions

1. **The readers raise `std::read`.** They read a file.
2. **No `stats` function.** `logTraces` with `{ all: true }` returns
   cost, tokens, calls, working time, and the tool counts for every
   trace. A program adds up what it wants.
3. **Failed tool calls are counted on each trace**, in the CLI and the
   library alike.
4. **`maxChars` caps the text of a row.** The events behind it are left
   whole.
5. **`kind` is a `string`.** The row kinds grow when the viewer learns a
   new row. A union type here would break programs each time.
6. **`evalRecord` and its relatives are not changed.** They raise no
   effect today. Bringing them in line is a separate change.

## Not in this change

1. `agency logs extract`, which writes a trace to a file.
2. The `agency logs session` commands that talk to an open viewer, and
   review comments.
3. Reading from the hosted statelog server. These functions read files.
4. Run directories as the `log` argument.

## Tests

1. Unit tests for the tool counts: a trace with one completed, one
   failed, one rejected, one awaiting, and one unfinished tool call
   gives `5, 1, 1, 1`, and a tool call inside a subagent is counted. A
   failed tool's error is not in `otherErrors`; an error outside any
   tool is, and so is one inside a tool that went on to complete.
2. Unit tests for `agency logs traces`: the marker column for each kind
   of trouble. A trace with only failed tools reads `2 failed`, without
   `error`.
3. The counts on a real recorded log with a rejected tool call, so a
   rejection is counted as rejected and not as unfinished.
4. Unit tests for `lib/logsQuery/row.ts`: an address is found, a bare
   row id is refused, an unknown row is refused, and `maxChars` cuts the
   text and sets `truncated`, and a `maxChars` of 50 is refused.
5. A unit test that a selection of `{ trace: null, last: 2, since: null,
   all: null }` picks the two newest traces.
6. The existing tests for `traces`, `outline`, and `search` move with
   their files and keep passing.
7. A test that the failure and closing-line messages use field names
   when called with the library's spelling, and flag names with the
   CLI's.
8. One agency test that calls all four functions on a small fixture log
   with two traces, made by a scripted model that calls a tool, under a
   handler that approves `std::read`. It checks
   the trace count, the payload's `dir` and `filename`, a row address
   from the outline, a search hit, and that `logRow` opens that address.
9. One agency test that a rejected `std::read` gives a failure. The
   file is read only after the approval, so nothing more needs checking.
10. One agency test that an empty `log` reads the run's own log file, and
   is a failure when the run has none.

## Docs

1. The module doc comment in `stdlib/statelog.agency` gains a section on
   reading a log, with the example above.
2. `docs/site/stdlib/statelog.md` is regenerated from it.
3. `docs/site/cli/` gains the new fields and the marker column's words
   where `agency logs traces` is described.
4. `docs/dev/cli/logs-viewer.md` says the query functions live in
   `lib/logsQuery/` and are shared with `std::statelog`.
