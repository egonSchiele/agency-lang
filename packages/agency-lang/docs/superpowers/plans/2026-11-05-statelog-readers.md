# Statelog readers in `std::statelog` — Implementation Plan

**Goal:** An Agency program can list the traces in a statelog, outline
one, search it, and open a row, with the same code the `agency logs`
commands run. A trace's summary counts its tool calls and how each one
ended.

**Spec:** `docs/superpowers/specs/2026-11-05-statelog-readers.md`.

**Shape:** two PRs.

1. **Count tool calls on a trace.** A change to the CLI and the trace
   summary only. It is useful alone and can be reviewed alone.
2. **The four readers.** Built on the first PR, so `logTraces` returns
   the counts from its first version.

**Tech stack:** the query functions in `lib/cli/logsQuery/`, the trace
summary in `lib/logsViewer/traceSummaries.ts`, trace selection in
`lib/runDirectory/traceSelection.ts`, the trace reader in
`lib/runDirectory/traces.ts`, the new stdlib bindings in
`lib/stdlib/statelogReaders.ts`, and `stdlib/statelog.agency`.

## Background

- `traces`, `outline`, and `search` are each a function from parsed
  options and a `QueryDeps` to a `QueryResult`
  (`{ text, json, exitCode }`). Only `register.ts` touches the process.
  All three go through `withPickedTraces` in `shared.ts`, which opens
  the log, picks the traces, and turns a refusal into the result.
- `openQueryLog` (`shared.ts`) does two jobs. It chooses the log with
  `chooseLog` from `lib/cli/logsSession/target.ts` (the `--log` flag, the
  open viewer, or `log.logFile`), and it reads it with `deps.readLog`,
  which is synchronous. The library needs the second job and not the
  first.
- `selectTraces` (`lib/runDirectory/traceSelection.ts`) holds the rules
  for `trace`, `last`, `since`, and `all`. Its refusal messages are
  constants that name the CLI flags.
- `logsSearch` takes `limit`, `context`, and `kind` as the text commander
  hands over, and parses them itself with `parseCount` and `kindsFrom`.
- `TraceSummary` (`lib/logsViewer/traceSummaries.ts`) is built once per
  trace by `summarize`. The CLI builds it for every trace in the log
  (`openQueryLog`), and so does the viewer's trace picker.
  `lib/cli/statelog/projectClient.ts` has an unrelated type of the same
  name.
- The viewer sorts a tool call into `completed`, `failed`, `rejected`,
  `awaitingApproval`, or `unfinished` (`classifyTool`,
  `lib/logsViewer/story.ts:122`). A tool row in the story outline
  carries the result as `status` (`ToolStoryRow`), from
  `classifyTool(toolEvidence(node, index))`. `toolEvidence` reads the
  tool's own span alone.
- A failed tool call always logs an `error` event inside its span, whether
  the tool threw or returned a failure (`recordFailure`,
  `lib/runtime/prompt.ts:976`). So `hasError` is already true for every
  trace with a failed tool call.
- `session show` builds a row with `expandRow`
  (`lib/logsViewer/rowText.ts:35`), which returns `undefined` for a row
  id the trace does not have. An address is split with `splitAddress`
  (`lib/logsViewer/address.ts`), which needs the log's trace ids.
- `readTraces` (`lib/runDirectory/traces.ts`) reads a file in chunks
  through `makeLineReader` and groups the lines by trace. The splitter
  under it, `makeLineSplitter` (`lib/statelog/lineReader.ts`), takes
  byte chunks from any source.
- `loadModelData` (`stdlib/llm.agency:297`) takes a path's real spelling
  with `_realTarget` (`lib/stdlib/fs.ts:19`), then raises `std::read`
  with its `dirname` and `basename`. `realPath` resolves a relative path
  against the host's working directory.
- `read` (`stdlib/index.agency:204`) is the model for a function that
  reads a file. It is `@capabilities(fileRead)` and `idempotent`,
  returns `Result`, calls `_prepareContainedPath` before the interrupt
  so the payload holds the real `dir`, raises `std::read`, and then
  reads with `host.files.readText(await host.files.fixedRoot(dir),
  filename)` (`lib/stdlib/builtins.ts:183`).
- A module that raises `std::read` declares the effect itself. See the
  comment and declaration at `stdlib/llm.agency:281`.
- Code under `lib/stdlib` may not import `fs`. A lint rule in
  `eslint.config.js` enforces it. Files are reached through
  `host.files`, which has `realPath`, `fixedRoot`, and `readChunks`.
- A run's own log file is `getStatelogSink().logFile` on the run's
  context (`lib/runtime/state/context.ts:461`). `_isLogging` in
  `lib/stdlib/statelog.ts` shows how a binding reaches the context.
- `capString(text, maxChars, onCut)`
  (`lib/runtime/trimStatelogEvent.ts:34`) cuts a string and appends
  `…[truncated N chars]`, with the marker inside the cap. `0` means no
  cap. Below the marker's length (about 24 characters), it returns the
  whole text or the marker alone, either of which can be longer than the
  cap.
- `lib/stdlib/statelog.ts` is imported by `stdlib/safeBash.agency`
  (`_debug`) and `lib/stdlib/cli.ts` (`logReplTurn`), so anything it
  imports loads into every program that uses either.

## PR 1: count tool calls on a trace

Branch `trace-tool-counts`, from `main`.

### 1a. The counts

In `lib/logsViewer/story.ts`, export `toolEvidence`. `toolRow` keeps
calling it as it does now.

In `lib/logsViewer/traceSummaries.ts`:

1. Add `toolCalls`, `toolsFailed`, `toolsRejected`, `toolsUnfinished`,
   and `errorsOutsideTools` to `TraceSummary`, all numbers.
2. Add one table that says which statuses are trouble. Everything
   below reads it, so a new counted status is one new row:

   ```ts
   export type ToolTrouble = {
     status: ToolStatus;
     field: "toolsFailed" | "toolsRejected" | "toolsUnfinished";
     word: string;
   };

   export const TOOL_TROUBLE: ToolTrouble[] = [
     { status: "failed", field: "toolsFailed", word: "failed" },
     { status: "rejected", field: "toolsRejected", word: "rejected" },
     { status: "unfinished", field: "toolsUnfinished", word: "unfinished" },
   ];
   ```

3. Add `toolCountsOf(root)`. It builds one `buildTreeIndex(root)`, takes
   every `toolExecution` node of `walkNodes(root)`, and takes each one's
   `toolEvidence(node, index)`.
   - `toolCalls` is how many tool nodes there are.
   - Each field of `TOOL_TROUBLE` is how many have that status, from
     `classifyTool(evidence).status`.
   - `errorsOutsideTools` is the trace's `error` events less the ones the
     tools own (`evidence.errors.length`, summed). `ownedToolNodes` leaves
     out a nested tool's nodes, so no error is counted twice.

   It doesn't build the story outline. That would run `roundDeltas` and
   lay out every row, for every trace the CLI and the trace picker
   summarize. The counts still agree with the viewer by construction,
   since both read `classifyTool(toolEvidence(...))`.
4. `summarize` puts the counts in the summary.

Tests, added to the existing `lib/logsViewer/traceSummaries.test.ts`
(`storyFixture.ts` and `traceFixture.ts` have the event builders):

1. A trace with one tool call of each status gives `toolCalls: 5` and
   one each for failed, rejected, and unfinished.
2. A tool call inside a subagent is counted.
3. A trace with no tool calls gives five zeros.
4. A failed tool's error is not in `errorsOutsideTools`. An error outside
   any tool is.
5. On a real recorded log with a rejected tool call, that call counts as
   rejected and not as unfinished. `recordRejection` (`prompt.ts:937`)
   logs neither an error nor a `toolCall` event, so the status comes
   only from the interrupt events inside the tool's span. Record the log
   with a scripted model and a handler that rejects, and keep it as a
   fixture.

### 1b. The CLI output

In `lib/cli/logsQuery/shared.ts`:

1. `traceRecord` adds `toolCalls`, `errorsOutsideTools`, and each field
   of `TOOL_TROUBLE`.
2. Add `troubleText(summary)`: `error` when `errorsOutsideTools` is above
   zero, then `<count> <word>` for each row of `TOOL_TROUBLE` whose count
   is above zero, joined with `, `. A clean trace gives `""`.

In `traces.ts`, the marker column of `tracesTable` prints
`troubleText(summary)`. `keep` and the `withErrors` count still use
`hasError`, so `--errors` and its help text don't change.

In `outline.ts`, `summaryLine` prints `troubleText(summary)` where it
prints `error` today.

Tests, in the existing `traces.test.ts` and `outline.test.ts`:

1. The marker column for a trace with two failed tools and no other
   error reads `2 failed`.
2. With an error outside the tools as well, it reads `error, 2 failed`.
3. `--json` has the five fields.

`queryFixture.ts` needs a way to give a fixture trace a failed tool
call, in the shape a real log has: a tool span with an `error` event
inside it. Add a `failedTools?: number` field to `FixtureTrace` beside
`error`.

### 1c. Docs

1. `docs/site/cli/logs.md`: the paragraph on `agency logs traces`
   (around line 170) describes the marker column's words, and the JSON
   fields are listed where the others are.
2. `stdlib/docs/cli/logs.md` is a staged copy. `make stdlib` rewrites
   it. Commit it only if `git status` shows it changed and tracked.

### 1d. Check the cost

Before the change and after it, time `agency logs traces --all` three
times on a large statelog and take the middle value. Write a synthetic
one for this: a few hundred traces with a few dozen tool calls each.

This is a check, not a gate: the counts already avoid the story outline.
If the command is clearly slower, find out why before opening the PR.

Put both timings in the PR description.

**Commits:** `Count tool calls on a trace summary`, then `Show failed
tool calls in agency logs traces and outline`.

## PR 2: the readers

Branch `statelog-readers`, from `main` after PR 1 merges. The spec and
this plan are already on that branch.

### 2a. Separate choosing the log from reading it

In `lib/cli/logsQuery/shared.ts`:

1. Replace `LogDeps`, `probe`, and `readLog` in `QueryDeps` with one
   function. The query functions then know nothing about how a log is
   chosen or where its bytes come from:

   ```ts
   export type LoadedLog = { logPath: string; traces: Trace[] };

   export type QueryDeps = {
     cwd: string;
     /** The log this `log` option names, read, or why there is none. */
     loadLog(log: string | undefined): Promise<LoadedLog | { refused: string }>;
     now(): number;
     names: OptionNames;
   };
   ```

2. `openQueryLog` calls `deps.loadLog(log)` and builds each trace's
   root and summary from what comes back.

In `lib/cli/logsQuery/register.ts`, `defaultLogsQueryDeps` builds
`loadLog` from `chooseLog`, `probe`, `pathKind`, `childRunDirectories`,
`configuredLog`, and `readTraces`. That is the code `openQueryLog` has
today, moved.

The tests that are about choosing a log (the open viewer, the
configured log, a run directory) move to a test of that `loadLog`
beside `register.ts`. The other tests use a `loadLog` that reads the
path it was handed with `readTraces`.

`queryFixture.ts` imports `pathKind` from `@/cli/logsSession/index.js`
today, for `queryDeps`. After this step `queryDeps` no longer needs
`pathKind`, `probe`, `childRunDirectories`, or `configuredLog`. Its
`liveViewer` helper builds a `ProbedRecord` for the viewer tests, which
move to `register.ts`'s tests, so `liveViewer` moves with them.

### 2b. Name options the way the caller spells them

In `lib/runDirectory/traceSelection.ts`:

1. Add the type and the CLI's spelling:

   ```ts
   export type OptionName = "trace" | "last" | "since" | "all" | "limit" | "context" | "kind";
   export type OptionNames = Record<OptionName, string>;

   export const FLAG_NAMES_CLI: OptionNames = {
     trace: "--trace",
     last: "--last",
     since: "--since",
     all: "--all",
     limit: "--limit",
     context: "--context",
     kind: "--kind",
   };

   export const FIELD_NAMES: OptionNames = {
     trace: "trace",
     last: "last",
     since: "since",
     all: "all",
     limit: "limit",
     context: "context",
     kind: "kinds",
   };
   ```

2. `selectTraces` takes `names` in its options. `TRACE_ALONE`,
   `ALL_AND_LAST`, and `ALL_AND_SINCE` become functions of `names`. The
   combinations table keeps its sixteen rows.
3. A `null` field counts as left out. The test for "given" becomes
   `flags[name] !== undefined && flags[name] !== null && flags[name] !==
   false`, and `TraceSelectionFlags` allows `null` on each field. A model
   that calls a reader as a tool sends `null` for the fields it doesn't
   use, and the runtime's `dropNullDefaultedArgs` only drops top-level
   arguments, never fields inside `select`. The CLI never sends `null`, so
   this changes nothing there.

In `traces.ts` and `search.ts`, the closing lines (`Pass --all to list
them, or --since to pick by time.` and `Narrow with --trace, --kind, or
a longer pattern, or raise --limit.`) are built from `deps.names`.

Counts are checked in one place. Today `parseCount` checks the text
of `--last`, `--limit`, and `--context` in the CLI, and nothing checks a
number, so a library call with `last: 0` would pass.

1. Replace `parseCount` with `countProblem(name, value)`, which takes a
   number and returns the refusal text for anything that is not a
   positive whole number, or `undefined`. It is the only place the rule
   lives.
2. `selectTraces` calls it for `last`. `logsSearch` calls it for
   `limit` and `context`. Both pass the name from `names`.
3. `register.ts` turns flag text into a value with `Number(text)` and
   checks nothing. `abc` becomes `NaN`, which `countProblem` refuses
   with the message it gives today.
4. `SearchOptions` takes `limit?: number`, `context?: number`, and
   `kinds?: string[]`. `register.ts` splits `--kind` on commas, and keeps
   today's refusal of a flag with no names in it (`--kind ","`, from
   `kindsFrom`). `logsSearch` keeps the check that every kind is in
   `SEARCH_KINDS`. In Agency an empty list means every kind, so the
   binding passes `undefined` for `[]`.

Tests: in `traceSelection.test.ts`, the three refusals read with
`FIELD_NAMES` and with `FLAG_NAMES_CLI`, `last` of `0`, `-1`, `2.5`, and
`NaN` is refused, and `{ trace: null, last: 2, since: null, all: null }`
picks the two newest traces. In `traces.test.ts` and `search.test.ts`,
one test each for the closing line.

### 2c. Move the query functions out of `lib/cli`

`git mv` these from `lib/cli/logsQuery/` to `lib/logsQuery/`:
`shared.ts`, `traces.ts`, `outline.ts`, `search.ts`, their three test
files, and `queryFixture.ts`. `register.ts` and `register.test.ts`
stay.

After 2a and the `liveViewer` move, none of the moved files imports from
`lib/cli/logsSession`. They still import `formatTextTable` and `oneLine` from
`lib/cli/runDirectory/table.ts`. Move that file to
`lib/runDirectory/table.ts` in the same commit and fix its importers.

`pnpm typecheck` names every import to fix.

### 2d. Open one row

Add `lib/logsQuery/row.ts`:

```ts
export type RowOptions = { address: string; log?: string; maxChars: number };

export async function logsRow(options: RowOptions, deps: QueryDeps): Promise<QueryResult>
```

1. Open the log with `openQueryLog`.
2. `splitAddress(options.address, traceIds)`. When it returns
   `undefined`, refuse with `"<address>" is not a row address: use
   <trace id>/<row id>, as logOutline and logSearch print it`.
3. Find the trace. `expandRow(trace.root, rowId)` with no comments.
   When it returns `undefined`, refuse with `no row <row id> in trace
   <trace id>`, the message `session show` prints.
4. Refuse a `maxChars` that is not `0` or a whole number of at least
   `MIN_ROW_CHARS` (100): `maxChars is 0 for no cap, or at least 100`,
   with the name from `deps.names`. Below the marker's length,
   `capString` can't keep the text under the cap.
5. `text` is `capString(expanded.text, options.maxChars, onCut)`, and
   `truncated` is whether `onCut` ran.
6. The JSON is `{ address, kind, header, truncated, events }`, plus
   `providerItems` for a hosted row, which has no events. Leave out
   `anchor` and `comments`.

`session show` is not changed.

Tests, in `lib/logsQuery/row.test.ts`: an address from `logsOutline` is
found; a bare row id is refused; an unknown row is refused; `maxChars`
shortens the text to at most `maxChars` characters with the marker, and
sets `truncated`; `maxChars: 0` leaves it whole; `maxChars: 50` is
refused; a hosted row carries `providerItems`.

### 2e. Read traces from chunks

In `lib/runDirectory/traces.ts`, add:

```ts
export async function readTracesFromChunks(
  chunks: AsyncIterable<Uint8Array>,
): Promise<ReadTracesResult>
```

It pushes each chunk into a `makeLineSplitter`, hands the lines to the
same `addLines` that `readTraces` uses, and calls `finish()` at the
end. Pull the shared part of `readTraces` into one helper, so both
readers group and drop repeated lines the same way.

Test: the result for a fixture log equals `readTraces` on the same
file, with the chunks cut in the middle of a line and in the middle of
a multi-byte character.

### 2f. The bindings

The bindings go in a new file, `lib/stdlib/statelogReaders.ts`, not in
`lib/stdlib/statelog.ts`. `statelog.ts` loads into every program that
uses `safeBash` or the REPL (see Background), and the readers would
bring `story.ts`, `rowText.ts`, `transcript.ts`, `rowSearch.ts` and the
rest with them.

The new file reaches `fs` through `lib/runDirectory/traces.ts`. Add it
to `NODE_ONLY` in `eslint.node-exceptions.mjs`, with the reason "reads a
statelog through lib/runDirectory/traces.ts", or
`scripts/lint-browser-reach.mjs` fails.

1. `_logToRead(log: string): string`. Take the current run on the first
   line. A non-empty `log` is returned as it is. An empty one becomes
   the run's `getStatelogSink().logFile`, and throws:
   - `This run has no log file. Pass a log path, or set log.logFile.`
     when there is none,
   - `This run is not writing its log: observability is off. Pass a log
     path.` when `observability` is false, since the file would hold only
     what earlier runs wrote.

   The real path is not taken here. `stdlib/statelog.agency` does that
   with `_realTarget`, as `loadModelData` does.
2. Two private helpers hold everything the four bindings share:

   ```ts
   /** The deps of a query on the approved log at `logPath`. */
   function approvedLogDeps(host: Host, logPath: string): QueryDeps

   /** A query's result as the library returns it; a refusal throws. */
   function answerOf(result: QueryResult): Record<string, unknown>
   ```

   `approvedLogDeps` returns:

   | Field | Value |
   | --- | --- |
   | `cwd` | `host.system.cwd()` |
   | `loadLog` | Reads `readTracesFromChunks(host.files.readChunks(await host.files.fixedRoot(path.dirname(logPath)), path.basename(logPath)))` and returns its traces with `logPath` |
   | `now` | The host's clock |
   | `names` | `FIELD_NAMES` |

   Reading through `fixedRoot` of the approved directory keeps the
   containment rules: a link planted below it is refused.

   `answerOf` throws `new Error(result.text)` for a non-zero `exitCode`
   and otherwise returns `{ ...result.json, text: result.text }`.
3. The four bindings are then one line each, with `currentHost()` taken
   before the `await`:

   ```ts
   export async function _logTraces(
     logPath: string,
     select: TraceSelectionFlags,
     errorsOnly: boolean,
   ): Promise<Record<string, unknown>> {
     const deps = approvedLogDeps(currentHost(), logPath);
     return answerOf(await logsTraces({ ...select, json: true, errors: errorsOnly }, deps));
   }
   ```

   `_logOutline(logPath, select, approvals, admin)`,
   `_logSearch(logPath, pattern, select, kinds, regex, caseSensitive,
   limit, context)`, and `_logRow(logPath, address, maxChars)` have the
   same two lines. None of them changes the JSON. `_logSearch` passes
   `undefined` for an empty `kinds` (2b).

Lines that do not parse are skipped, as the CLI skips them.

Tests, in `lib/stdlib/statelogReaders.test.ts`: `_logToRead("")` outside
a run throws the no-log-file message, and inside a run with observability
off throws the not-writing message. `_logToRead("x.jsonl")` returns it
unchanged.

### 2g. The Agency functions

In `stdlib/statelog.agency`:

1. Copy the whole `std::read` declaration from `stdlib/llm.agency:281-288`,
   the comment, `@alwaysUnder(dir)`, and the effect. Policy containment
   for `std::read` depends on `@alwaysUnder(dir)`.
2. Add the types from the spec: `StatelogTraceSelection`,
   `StatelogTrace`, `StatelogTraceList`, `StatelogRow`, `StatelogRows`,
   `StatelogOutlinedTrace`, `StatelogOutline`, `StatelogHit`,
   `StatelogSearchResult`, `StatelogExpandedRow`.
3. Add one private function that finds the log, takes its real path, and
   asks, written the way `loadModelData` writes it. The approval lives
   here and nowhere else:

   ```ts
   def approvedLog(log: string): Result<string> raises <std::read> {
     const named = try _logToRead(log)
     if (isFailure(named)) {
       return named
     }
     const real = try _realTarget(named.value)
     if (isFailure(real)) {
       return real
     }
     return interrupt std::read("Are you sure you want to read this log?", {
       dir: dirname(real.value),
       filename: basename(real.value)
     })
     return real
   }
   ```

   A log that doesn't exist fails at `_realTarget`, with the host's message
   for a missing path.

4. Add the four functions with the signatures in the spec. Each one
   says what it wants and nothing about paths or approval:

   ```ts
   const where = approvedLog(log)
   if (isFailure(where)) {
     return where
   }
   return try _logTraces(where.value, select, errorsOnly)
   ```

5. Docstrings are short and plain: one sentence on what the function
   answers, then one `@param` line each.
6. Add a "Reading a log" section to the module doc comment with the
   example from the spec.

Then run `make stdlib`, `make effect-sets`, and `make doc`, and commit
what they change.

`lib/stdlibCapabilities.test.ts` must pass without adding the four
names to `TOUCHES_NOTHING`. They are tagged.

### 2h. Agency tests

One folder, `tests/agency-js/statelog-readers/`, laid out like
`tests/agency-js/statelog-final-value-once/` (an `agency.json` that
writes `statelog.log`, an `agent.agency`, a `test.js`, a
`fixture.json`).

A trace has tool rows only when the tool was called from `llm()`, so the
`work` runs need a scripted model. Copy the setup from
`tests/agency-js/fetch-cache/`: an `llmMocks.json`, with a `toolCall`
reply and then a final reply for each `work` run, and the
`useTestLLMProvider` marker file.

`agent.agency` has three nodes:

1. `work(question)`: an `llm()` call with one tool, which the scripted
   model calls once before it replies. `test.js` runs it twice, so the
   log holds two traces. The question is longer than 200 characters, so
   its user row is long enough to cut.
2. `inspect()`: under a handler that approves `std::read` and records
   its payload, calls `logTraces("")`. It picks a `work` trace by its
   `ask`, because the newest trace is `inspect()`'s own run, which is
   still being written. Then it calls `logOutline` with `{ trace: ... }`
   for that trace id, `logSearch` for a word from the question, and
   `logRow` on the outline's user row with `maxChars: 100`. It returns
   what `test.js` needs.
3. `refused()`: under a handler that rejects `std::read`, calls
   `logTraces("")` and returns whether the result is a failure.

`__result.json` holds: the trace count is at least 2; the payload's
`filename` is `statelog.log` and its `dir` is absolute; the outline has
a tool row; the search matched; `logRow` returned the address it was
given, with `truncated: true` and a text of at most 100 characters, the
marker included; and the rejected call failed.

The `.gitignore` ignores `**/*.js`. Add `test.js` with `git add -f`.

### 2i. Docs

1. `docs/site/stdlib/statelog.md` is regenerated by `make doc`.
2. `docs/dev/cli/logs-viewer.md`: say that the query functions live in
   `lib/logsQuery/`, that `register.ts` is the CLI's half, and that
   `std::statelog` calls the same functions.

**Commits:**

1. `Separate choosing a log from reading it` (2a)
2. `Name selection options the way the caller spells them` (2b)
3. `Move the logs query functions to lib/logsQuery` (2c)
4. `Add logsRow and a chunked trace reader` (2d, 2e)
5. `Add logTraces, logOutline, logSearch, and logRow to std::statelog`
   (2f to 2i)

## Verification

For each PR:

1. `pnpm vitest run` on the test files named above.
2. `pnpm typecheck`, which covers the tests.
3. `pnpm fmt:ts` before pushing.

For PR 1 also: the timings from 1d.

For PR 2 also:

1. `pnpm lint:structure`, and in it `scripts/lint-browser-reach.mjs` in
   its own right. That's the check that fails if a reader lands in a file
   that isn't on `NODE_ONLY`. The rule that keeps `fs` out of
   `lib/stdlib` is the less likely failure.
2. `make build`, then
   `node dist/scripts/agency.js test js tests/agency-js/statelog-readers`.
3. Run `agency logs traces`, `outline`, and `search` once each on a
   real log and compare the text with `main`. Apart from the marker
   column from PR 1, it should not differ.

## Not in this plan

- A `stats` function. A program sums what `logTraces` returns.
- A cap on `events` in `logRow`. `maxChars` bounds `text`.
- An effect on `evalRecord` and its relatives.
- `agency logs extract`, the `session` commands, review comments, run
  directories as the `log` argument, and the hosted server.
- A cache between calls.
