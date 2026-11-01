# `agency logs` commands for agents: traces, outline, search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Paths are relative to `packages/agency-lang`.

**Goal:** An agent can list the runs in a log (`agency logs traces`), print every row of one run with its address (`agency logs outline`), and find the rows that mention a word (`agency logs search`), without reading `log.jsonl` itself. Every logs command finds the log the same way: `--log`, the one open viewer, `log.logFile` in `agency.json`, refusal. So none of the skill's steps need `--log`, and an address `search` prints is one `session show` finds. The `debug-logs` skill teaches the new steps.

**Architecture.** Four pieces, each with one job:

1. **Finding the log.** `chooseSession` in `lib/cli/logsSession/target.ts` becomes the exported `chooseLog`, with one new step: with no `--log` and no open viewer, the log `agency.json` names. The new commands probe the viewer registry the way the session commands do and call `chooseLog`, so all four skill steps read the same file.
2. **Picking traces.** One pure function in `lib/runDirectory/traceSelection.ts` takes trace summaries and the parsed `--trace`, `--last`, `--since`, `--all` flags and returns the selected traces or a refusal. `traces`, `outline`, and `search` call it.
3. **What each command prints.** Pure functions over a trace's forest: `traceSummaries` for the trace list, `storyOutline` plus `headerLine` for the outline, and `transcriptBlocks` plus `transcriptText` for search. Search adds nothing to the ownership rule; it is a filter over transcript blocks. The block-to-row mapping the transcript screen already has (`selectedRowId`) moves into `transcript.ts` as `blockRowId`, gains the cases search needs, and both the screen and search call it.
4. **The CLI.** `lib/cli/logsQuery/` holds one file per command, each a function from parsed options to `{ text, json, exitCode }`, and a `register.ts` that adds the three commands to `logs` the way `logsSession/register.ts` adds `session`.

**Tech stack:** TypeScript, the vendored commander, vitest. No Agency code changes.

**Spec:** `docs/superpowers/specs/2026-10-31-logs-commands-for-agents-design.md`.

**Review:** `docs/superpowers/plans/2026-10-31-logs-commands-for-agents-review.md`. Its findings are folded in below; the task that answers each one names it.

**Left out, on purpose:**

- `extract` keeps its positional log argument and takes none of the new flags. Only its two refusals change (Task 9).
- No flag for the viewer's `m` (forest) view. It replaces the story rows with raw span rows whose ids differ, and would not help an agent (review 5).
- A transcript command, a cap on `session show`, a "how the run ended" line, searching across run directories, the trace picker sorting by start time, and the log-format change are all listed under "Not in this design" in the spec.

## Global Constraints

- The row-ID contract in `docs/dev/cli/logs-viewer.md`: rows are found by looking an id up in the story outline (`findRow`), never by parsing it. `blockRowId` in Task 5 goes through the outline and reads fields, never a block's id.
- Nothing in `lib/logsViewer/` or `lib/runDirectory/` reads a flag or writes to stdout. The CLI files parse and print; the pure modules compute.
- The vendored commander refuses a flag a parent already declares. `logs` declares `--follow`, `--csv`, and `--trace-id`. The registration test (Task 8) builds the real program through `createProgram` in `scripts/agency.test.ts`, so a clash with those fails a test and not a user (review 10).
- Objects, not maps; arrays, not sets; types, not interfaces; no dynamic imports.
- The defaults in the spec are named constants where they are used, not bare numbers: `DEFAULT_TRACES_SHOWN = 20`, `DEFAULT_SEARCH_LIMIT = 30`, `DEFAULT_SNIPPET_CONTEXT = 60`, `ASK_COLUMN_CHARS = 60`, `HEADER_CHARS = 120`.
- Before writing a helper, search for one. The ones this plan already found: `fmtStartedAt`, `fmtDuration`, `fmtUsd`, `oneLine`, `formatAddress`, `findRow`, `matchTraceId`, `childRunDirectories`, `traceSummaries`, `storyOutline`, `transcriptBlocks`, `transcriptText`, `headerLine`, `selectedRowId`, `probeAll`, `removeStale`.
- `sampleRunForest()` returns `TreeNode[]`; a test over one trace takes `[0]` (review 18).
- `pnpm run typecheck`, `pnpm run lint:structure`, `pnpm run fmt:ts` on changed `.ts` files only (never a directory), and `pnpm vitest run <files>` with the output saved to a file in the scratchpad directory. Do not run the full agency suite.
- After `make build`, run the real binary once against the repository's `log.jsonl` (Task 11). Tests passed once while the built CLI crashed at registration.

## Review Focus

Each line names an input and what a person expects. The task that owns it has the test.

1. A word in the first user message of a five-call trace: one hit, the user row. Task 6.
2. A word in a tool result past 600 characters: one hit, the tool row, not the call that read the result. Task 6.
3. A word in the system prompt: one hit, on the first LLM call of the thread, with an address `session show` resolves (review 1). Task 5.
4. Every address `outline` and `search` print resolves with `findRow`, and the screen's `A` copies the same address for the same block (review 2). Tasks 5 and 6.
5. A viewer open on `runs/today/`, `agency.json` naming `log.jsonl`: `search` and `session show` read the same file (review 3). Task 1.
6. The largest trace in `log.jsonl`: its outline hides the 75 approved interrupts by default and `--approvals` shows them (review 4). Task 4.
7. Traces whose lines are interleaved in the file: `--last 1` is the one that started last. Task 2.
8. A user turn whose first line is 2,000 characters: the outline line and the search header are cut to `HEADER_CHARS` (review 6). Task 4.

---

### Task 1: Every logs command finds the log the same way

**Files:**
- Modify: `lib/cli/logsSession/target.ts`
- Modify: `lib/cli/logsSession/index.ts` (pass the configured log)
- Modify: `scripts/agency.ts` (hand the config reader to the session CLI)
- Test: `lib/cli/logsSession/target.test.ts`

Answers review 3, 8, 9, and 11.

**Interfaces:**

`chooseSession` is renamed `chooseLog` and exported. It keeps its signature shape and gains one step:

```ts
export type LogChoice =
  | { kind: "session"; session: LiveSession }
  | { kind: "files"; logPath: string }
  | { kind: "refused"; reason: string };

/**
 * The log a command acts on, in this order: `--log` (which also picks the
 * viewer on that log); the one open viewer; the log `agency.json` names,
 * when no viewer is open; else a refusal that says all three ways
 * forward. Several open viewers are refused with "say which", and the
 * configured log never overrides that. A run directory stands for the
 * statelog inside it; a directory of run directories is refused with a
 * pointer to `agency logs <dir> --csv`; a missing path is refused, so no
 * command reads a log that does not exist.
 */
export function chooseLog(log: string | undefined, live: LiveSession[], deps: LogDeps): LogChoice;

export type LogDeps = {
  cwd: string;
  pathKind(absolutePath: string): "file" | "directory" | "missing";
  /** `log.logFile` from `agency.json`, read only when `--log` is absent,
   *  so a broken config cannot stop a command that named its log. An
   *  empty string counts as unset: `--log stdout` writes `""` there on
   *  purpose to cancel a configured file. */
  configuredLog(): string | undefined;
};
```

`TargetDeps` extends `LogDeps`; `resolveTarget` calls `chooseLog` and wraps the choice with the comments store as it does today. `liveSessions` is exported too, since the new commands need it.

The no-log refusal reads:

```text
No log given. Pass --log <file>, set log.logFile in agency.json, or open a viewer with `agency logs <file>`.
```

**Steps:**

- [ ] Rename and export `chooseLog`, add the configured-log step after "the only live viewer" and before the no-viewer refusal, and leave the several-viewers refusal as it is. `childRunDirectories` from `lib/runDirectory/findRuns.ts` decides the directory-of-runs refusal. Write the order in a comment.
- [ ] `configuredLog` is a function, called only on the branch that needs it. In `scripts/agency.ts`, it reads `getConfig().log?.logFile` and returns `undefined` for `""`. Config is read when a command runs, not at registration.
- [ ] Tests in `target.test.ts`: `--log` wins over the configured log; the one live viewer wins over the configured log; the configured log is used when no viewer is open; two live viewers and a configured log is still "say which with --log"; an empty `logFile` gives the no-log refusal; a configured log missing on disk is refused with a message naming `agency.json`; `configuredLog` is not called when `--log` is given (a throwing stub proves it); a directory of run directories is refused; the no-log refusal names all three ways forward.
- [ ] Update the sentences in `docs/site/cli/logs.md` under "Comments and sessions" that say `--log` is needed without a viewer.

### Task 2: Picking traces

**Files:**
- Create: `lib/runDirectory/traceSelection.ts`
- Test: `lib/runDirectory/traceSelection.test.ts`

Answers review 7 and 16.

**Interfaces:**

```ts
export type TraceSelectionFlags = {
  trace?: string;
  last?: number;
  since?: string;
  all?: boolean;
};

/** What the picker needs to know about a trace. `TraceSummary` has both
 *  fields, so the commands pass their summaries straight in; start time
 *  is computed in one place, `traceSummaries`, and never again. */
export type Pickable = { traceId: string; startedAt: number | undefined };

export type TraceSelection<T extends Pickable> =
  | { kind: "selected"; picked: T[]; total: number; older: number }
  | { kind: "refused"; reason: string };

/** `30m`, `2h`, `3d`, or an ISO date, as a time in ms, or a refusal. */
export function parseSince(text: string, now: number): { at: number } | { error: string };

/** A flag's text as a positive whole number, or a refusal naming the flag. */
export function parseCount(flag: string, text: string | undefined): { value: number | undefined } | { error: string };

/**
 * The traces the flags pick, newest first by start time, by the
 * combinations table in the spec. `defaultLast` applies only when none of
 * the four flags is given. A trace with no timestamp sorts oldest and
 * `since` never picks it. `older` counts the traces `last` left out.
 */
export function selectTraces<T extends Pickable>(
  traces: readonly T[],
  flags: TraceSelectionFlags,
  options: { defaultLast: number; now: number },
): TraceSelection<T>;
```

The combinations table is the spec's. It is written as data: a list of `{ given: flag names, outcome }` rows checked in order, so a reader can match the spec's table against the code line by line.

**Steps:**

- [ ] Write `parseSince`, `parseCount`, and `selectTraces`.
- [ ] Tests: interleaved traces order by start time (two summaries whose start times reverse their list order); every row of the combinations table, each refusal with its message; an ambiguous prefix lists the ids; a trace with no timestamp sorts last and `--since` skips it; `older` is right; each `parseSince` form and the `2x` refusal; `parseCount` on `0`, `-1`, `abc`, `3`, and undefined.

### Task 3: The `traces` command

**Files:**
- Create: `lib/cli/logsQuery/shared.ts` (the opened log, trace picking, the header line)
- Create: `lib/cli/logsQuery/traces.ts`
- Test: `lib/cli/logsQuery/traces.test.ts`

**Interfaces:**

`shared.ts`:

```ts
export type QueryResult = { text: string; json: unknown; exitCode: number };

/** One trace of an opened log: its root and its summary, built once the
 *  way the viewer builds them (`buildForest` over the whole file, then
 *  `traceSummaries`), so every command reads the same records. */
export type OpenedTrace = { traceId: string; root: TreeNode; summary: TraceSummary };

/** The log a query reads, found by `chooseLog`. The first line of every
 *  command's text names `logPath`. */
export type OpenedLog = { logPath: string; traces: OpenedTrace[] };

export type QueryDeps = LogDeps & {
  /** The viewer registry, probed as the session commands probe it, so a
   *  query reads the log the open viewer has. */
  probe(): Promise<ProbedRecord[]>;
  readLog(logPath: string): Trace[];
  now(): number;
};

export function openQueryLog(log: string | undefined, deps: QueryDeps): Promise<OpenedLog | { refused: string }>;

/** `selectTraces` over the opened traces' summaries. Every command's
 *  selection goes through this. */
export function pickTraces(log: OpenedLog, flags: TraceSelectionFlags, defaultLast: number, deps: QueryDeps): TraceSelection<OpenedTrace>;

/** The header line every command prints first. */
export function logLine(log: OpenedLog, rest: string): string;
```

`openQueryLog` probes with `deps.probe()`, turns the records into `liveSessions`, and calls `chooseLog`. A `session` choice gives the viewer record's `logPath`; a `files` choice gives its path; a refusal is passed through. The forest is `buildForest` over every trace's events in one call, as the viewer does, and summaries are `traceSummaries(roots, {})`.

`traces.ts`:

```ts
export type TracesOptions = TraceSelectionFlags & { log?: string; json: boolean; errors: boolean };
export function logsTraces(options: TracesOptions, deps: QueryDeps): Promise<QueryResult>;
```

Columns and the header and footer lines are the spec's. The time column is `fmtStartedAt`; working time is `fmtDuration(durationMs, { minutes: true })`; cost is `fmtUsd`; the message is `oneLine(ask, ASK_COLUMN_CHARS)` from `lib/cli/runDirectory/table.ts`. `--errors` filters on `hasError`. The JSON shape is the spec's, with `startedAt` as an ISO string.

**Steps:**

- [ ] Write `shared.ts` and `traces.ts`.
- [ ] Tests, with a temp log written by `statelogLine` and `agentStartLine` from `lib/runDirectory/testFixtures.ts` and a `probe` stub: the header names the file; the default shows 20 and the footer counts the rest; `--all`; `--errors`; `--json` fields; the no-log refusal when the stub probe is empty and `configuredLog` gives undefined; the configured log is used when `--log` is absent; a live record from the stub probe wins over the configured log (Review Focus 5, half of it; Task 6 has the other half).

### Task 4: The outline

**Files:**
- Modify: `lib/logsViewer/story.ts` (the approved-interrupt rule as a pure function)
- Modify: `lib/logsViewer/screens/traceScreen.ts` (`matches()` calls it)
- Modify: `lib/logsViewer/rowText.ts` (export `headerLine`)
- Create: `lib/logsViewer/outlineText.ts`
- Create: `lib/cli/logsQuery/outline.ts`
- Test: `lib/logsViewer/story.test.ts`, `lib/logsViewer/outlineText.test.ts`, `lib/cli/logsQuery/outline.test.ts`

Answers review 4, 5, and 6.

**Interfaces:**

In `story.ts`:

```ts
/** The trace screen's default: an approved interrupt is hidden until
 *  the person asks for approvals. Rejected and pending ones always show.
 *  The screen and the outline command both apply this. */
export function hiddenByDefault(row: StoryRow): boolean;
```

`traceScreen.ts`'s `matches()` keeps its own switches (`showApprovals`, `machinery`, `admin`, `filter`, `quick`) and calls `hiddenByDefault(row)` in place of the two-line interrupt check.

`outlineText.ts`:

```ts
export type OutlineLine = { address: string; rowId: string; kind: StoryRow["kind"]; depth: number; header: string };

export type OutlineFlags = { approvals: boolean; admin: boolean };

/** Every row the trace screen would draw by default, in its order, with
 *  the header `session show` prints for it, cut to `HEADER_CHARS`.
 *  `approvals` shows approved interrupts, as `p` does; `admin` adds
 *  handler decisions, as the viewer's admin toggle does. */
export function outlineLines(trace: TreeNode, flags: OutlineFlags): OutlineLine[];

/** The summary line, a blank line, then one line per row: the address
 *  padded to one width and the header indented by depth. */
export function outlineText(lines: OutlineLine[], summary: TraceSummary): string;
```

`outlineLines` is `storyOutline(trace, { admin })`, filtered by `hiddenByDefault` unless `approvals`, mapped through `formatAddress`, `headerLine`, and `oneLine(header, HEADER_CHARS)`. The summary line is `<trace id> · N LLM calls · <working time> · <cost>` with ` · error` when `hasError`.

```ts
export type OutlineOptions = TraceSelectionFlags & OutlineFlags & { log?: string; json: boolean };
export function logsOutline(options: OutlineOptions, deps: QueryDeps): Promise<QueryResult>;
```

With several traces selected, each prints under its own summary line, newest first, separated by a blank line. The first line of the text names the log.

**Steps:**

- [ ] Add `hiddenByDefault` to `story.ts` and call it from `matches()`. Test in `story.test.ts`: an approved interrupt row is hidden, a rejected one and a pending one are not, a tool row is not.
- [ ] Export `headerLine` from `rowText.ts`. Its cases already cover every row kind; leave them.
- [ ] Write `outlineText.ts` and `outline.ts`.
- [ ] Tests over `sampleRunForest()[0]`: the lines are `storyOutline`'s rows in order with the right depth; every `rowId` resolves with `findRow`; approved interrupts are absent by default and present with `approvals`; `admin` adds handler-decision rows; a user turn with a 2,000-character first line prints a header of at most `HEADER_CHARS` (build it with `event` from `storyFixture.ts`); the text's first line names the log; `--json` records carry the five fields.

### Task 5: The block-to-row mapping lives in the transcript

**Files:**
- Modify: `lib/logsViewer/transcript.ts`
- Modify: `lib/logsViewer/screens/transcriptScreen.ts`
- Test: `lib/logsViewer/transcript.test.ts`

Answers review 1 and 2.

**Interfaces:**

A system block gains the call it was first carried by. `roundId` stays `undefined` on it, because the screen reads `roundId` to decide focus and that behaviour is not changing:

```ts
| { kind: "system"; text: string; /** The LLM call that first carried this prompt. */ ownerRoundId: string }
```

The mapping is one table keyed by block kind, and one function that applies it. A kind with no entry has no row. Adding a kind means adding one row here and nowhere else:

```ts
/** How a block finds its story row: the block's own id (a tool or hosted
 *  block is a story row), the LLM call the block sits in, that call's
 *  user row, or the row built from the same node as an error. */
type RowRule = "own" | "round" | "ownerRound" | "roundUser" | "sameNode";

const BLOCK_ROWS: Partial<Record<TranscriptBlock["kind"], RowRule>> = {
  tool: "own",
  hosted: "own",
  assistant: "round",
  history: "round",
  rewrite: "round",
  system: "ownerRound",
  user: "roundUser",
  handback: "roundUser",
  error: "sameNode",
};

/** The story row a block stands for, or undefined for a block with no
 *  row (a thread divider, a turn, a pause). `roundUser` falls back to the
 *  call when the outline has no user row for it; `sameNode` is the row
 *  whose `node.id` is the error's node id. Looks ids up in `story`;
 *  never parses one. */
export function blockRowId(block: TranscriptBlock, story: StoryRow[]): string | undefined;
```

`selectedRowId()` in `transcriptScreen.ts` becomes `blockRowId(block, this.story)`, with the screen holding the story outline it already builds for the trace (check what it has; if it has none, build `storyOutline(trace, { admin: true })` once per trace and keep it beside `blocks`).

**Steps:**

- [ ] Add `ownerRoundId` to system blocks, with a transcript test that the first call's id is on it (review 1).
- [ ] Write `BLOCK_ROWS` and `blockRowId`; switch `selectedRowId()` to it.
- [ ] Tests in `transcript.test.ts` over `sampleRunForest()[0]`: for every block, `blockRowId` is undefined or resolves with `findRow`; a system block maps to its first call; a user block maps to the call's user row; an error block outside a tool maps to the error row; the screen's `selectedRowId()` on a tool, user, and assistant block gives what it gave before (keep the existing screen test green).

### Task 6: Search over transcript blocks

**Files:**
- Create: `lib/logsViewer/rowSearch.ts`
- Test: `lib/logsViewer/rowSearch.test.ts`

Answers review 13, 14, and 17.

**Interfaces:**

```ts
export type SearchKind = "user" | "call" | "tool" | "hosted" | "error";

/** The search kind each searched block kind reports; a kind not listed
 *  is not searched (thread, turn, pause, rewrite). */
export const SEARCHED_BLOCKS: Partial<Record<TranscriptBlock["kind"], SearchKind>> = {
  system: "call",
  assistant: "call",
  history: "user",
  user: "user",
  handback: "user",
  tool: "tool",
  hosted: "hosted",
  error: "error",
};
export const SEARCH_KINDS: SearchKind[];

export type Matcher = { test(text: string): { count: number; first: number } | undefined };
export function matcherFor(pattern: string, options: { regex: boolean; caseSensitive: boolean }): Matcher | { error: string };

export type RowHit = { rowId: string; kind: SearchKind; header: string; matches: number; snippet: string };

/** The story rows whose own text matches, in transcript order. */
export function searchTrace(trace: TreeNode, matcher: Matcher, options: { context: number; kinds: SearchKind[] | undefined }): RowHit[];

/** One line: whitespace runs collapsed, `context` characters each side of
 *  the first match, an ellipsis where text was cut. */
export function snippetAround(text: string, at: number, length: number, context: number): string;
```

`searchTrace`: build `storyOutline(trace, { admin: true })` once; take `transcriptBlocks(trace)`; keep the blocks in `SEARCHED_BLOCKS` whose `transcriptText` matches; find each one's row with `blockRowId` from Task 5; merge the blocks that land on one row into one hit, matches added and the first block's snippet kept; set `header` from `oneLine(headerLine(row, trace), HEADER_CHARS)`.

`toolResultText` returns the whole recorded output; the 600-character cut lives only in `payload.ts`. The long-result test below holds it to that.

**Steps:**

- [ ] Write `matcherFor`, `snippetAround`, and `searchTrace`.
- [ ] Tests, each on a small forest built with `event` from `storyFixture.ts` so the message history is explicit:
  - A word in the first user message of a five-call trace matches the user row once (Review Focus 1).
  - A word in a tool result matches the tool row and not the next call, and a word past 600 characters of the result is found (Review Focus 2).
  - A word in the system prompt matches the first call on the thread and no later one, and the hit's address resolves (Review Focus 3).
  - After a `memoryCompaction` event, a message re-added on the next call matches on that call. The transcript test "shows a message repeated after a compaction removed its earlier copy" has the fixture shape to copy.
  - A word only in node state matches nothing.
  - A file name passed as a tool argument hits both the call that asked and the tool that ran, as two hits (review 13).
  - A top-level interrupt's message is not found (review 14), documenting the limit.
  - Every hit's `rowId` resolves with `findRow`, over `sampleRunForest()[0]` searched for a letter that is in most rows (Review Focus 4).
  - A tool with an error inside it: the error text matches the tool row.
  - Snippets: newlines collapse, the count is right, `context` changes the width, an invalid regex is refused with the parser's message, case folding on by default.
  - `kinds` filters.

### Task 7: The `search` command

**Files:**
- Create: `lib/cli/logsQuery/search.ts`
- Test: `lib/cli/logsQuery/search.test.ts`

**Interfaces:**

```ts
export type SearchOptions = TraceSelectionFlags & {
  pattern: string;
  log?: string;
  json: boolean;
  kind?: string;
  regex: boolean;
  caseSensitive: boolean;
  limit?: string;
  context?: string;
};
export function logsSearch(options: SearchOptions, deps: QueryDeps): Promise<QueryResult>;
```

`limit` and `context` arrive as text and go through `parseCount`. The default selection is the most recent trace; `--all` searches every trace. `--kind` is split on commas and checked against `SEARCH_KINDS`; an unknown name is refused with that list. The text and JSON shapes are the spec's. No hits prints `no rows matched` with exit code 0. The footer when `--limit` cuts hits is the spec's sentence.

**Steps:**

- [ ] Write `search.ts`.
- [ ] Tests over a temp log with three traces and a `probe` stub: the default searches the most recent trace only; `--all` searches every one; the header counts traces searched; hits print newest trace first; `--limit` and the footer; `--limit 0` refused; `no rows matched` exits 0; a bad `--kind` is refused; `--json` fields; the viewer-on-one-log scenario: with a live record on `runs/today/statelog.jsonl` and `configuredLog` giving `log.jsonl`, `search` reads the run directory's statelog, the same file `session show` would (Review Focus 5, with Task 3).

### Task 8: Registering the commands

**Files:**
- Create: `lib/cli/logsQuery/register.ts`
- Modify: `scripts/agency.ts`
- Test: `scripts/agency.test.ts`

Answers review 10 and 12.

**Interfaces:**

```ts
export type LogsQueryDeps = QueryDeps & { writeStdout(text: string): void };
export function addLogsQueryCommands(logs: Command, deps: () => LogsQueryDeps): void;
```

The three leaves declare `--log`, `--json`, and `--trace` in `register.ts` with their own help text (`--trace <id>`: "The trace to read, a full id or unique prefix"), and `--last <n>`, `--since <when>`, `--all` through one `withTraceSelection` helper. The session commands' `withSharedOptions` stays where it is; its `--trace` text describes a bare row id's trace, which is not what the flag means here. `traces` adds `--errors`; `outline` adds `--approvals` and `--admin`; `search` adds `--kind`, `--regex`, `--case-sensitive`, `--limit`, `--context`. Each action awaits its function, writes `text` or `JSON.stringify(json, null, 2)`, and sets `process.exitCode` when non-zero, as `logsSession/register.ts` does.

**Steps:**

- [ ] Write `register.ts` and call `addLogsQueryCommands(logsCmd, …)` in `scripts/agency.ts` next to `addLogsSessionCommands`, with deps built from `defaultSessionCliDeps`'s pieces (`probeAll` over `sessionsDir`, `pathKind`, `process.cwd()`) and a `configuredLog` that reads `getConfig().log?.logFile` at action time.
- [ ] Test in `scripts/agency.test.ts`, beside the existing `logs` test: `createProgram()` registers `traces`, `outline`, and `search` under `logs`, and each declares its flags. This builds the real parent with `--follow`, `--csv`, and `--trace-id`, so a clash fails here.
- [ ] A second test in `lib/cli/logsQuery/register.test.ts` parses each command line with every flag against a fake deps and checks the parsed options, including `search -- --force` reaching the action as the pattern `--force`.

### Task 9: `extract` points at `traces`

**Files:**
- Modify: `lib/cli/runDirectory/extract.ts`
- Delete: `lib/cli/runDirectory/traceListing.ts`
- Modify: `lib/cli/runDirectory/commands.test.ts` (the test that checks the old table)

Answers review 21. Both refusals point the same way:

```text
<log> holds N traces; say which with --trace <id>. List them with: agency logs traces --log <log>
No trace in <log> matches "<prefix>". List them with: agency logs traces --log <log>
```

**Steps:**

- [ ] Change the two messages, delete `traceListing.ts`, and fix the test that asserted the table.
- [ ] Run `pnpm vitest run lib/cli/runDirectory` with output saved to a file.

### Task 10: The skill and the docs

**Files:**
- Modify: `skills/debug-logs/SKILL.md`
- Modify: `docs/site/cli/logs.md`
- Modify: `docs/dev/cli/logs-viewer.md`
- Modify: `CLAUDE.md` and `.claude/skills/agency-cli-docs/SKILL.md` (the index line for `logs-viewer.md` mentions the new commands)

Answers review 15, 19, and 20.

**Steps:**

- [ ] Rewrite the skill with two cases: rows the person points at (today's text), and a run the agent looks at alone, with the five steps from the spec. Change the description so it triggers on "look at the logs", "what happened in the last run", and "why did that run fail". Say that no step needs `--log` when a viewer is open or `agency.json` names the log, and to pass `--log <file>` to each command otherwise. Keep it under a screen.
- [ ] `docs/site/cli/logs.md`: a section "Reading logs from a script or an agent" with the three commands, the trace-picking flags and their combinations table, the order a log is found in, `search -- --force` for a pattern that starts with a dash, and the note that top-level interrupts are in the outline and not in search. Update the `extract` paragraph.
- [ ] `docs/dev/cli/logs-viewer.md`: a section "The agent commands" with: why search is a filter over transcript blocks and not a second ownership rule; `blockRowId` as the one mapping the screen and search share, and `ownerRoundId` on system blocks; `hiddenByDefault` as the one approvals rule; `chooseLog` as the one place a log is found and the order; that `headerLine` is now shared by `show`, `outline`, and `search`, and that the two commands cut it; the measured cost of `--all` (0.35 s to read, 0.85 s for transcript blocks, on the 70 MB file). Correct the sentence, wherever it appears, that says the trace picker sorts by start time: `--csv` does, the picker lists file order.
- [ ] Check the prose against `~/.claude/skills/simplify-speech/general-writing-tips.md` and `verbal-tics.md`.

### Task 11: Build, smoke, format

**Steps:**

- [ ] `pnpm run typecheck && pnpm run lint:structure`, output to a file; read it.
- [ ] `pnpm run fmt:ts` on the changed `.ts` files only.
- [ ] `make build`, then against the repository's `log.jsonl`, with no viewer open:
  ```bash
  node dist/scripts/agency.js logs traces --log log.jsonl --last 3
  node dist/scripts/agency.js logs outline --log log.jsonl | head -40
  node dist/scripts/agency.js logs outline --log log.jsonl --approvals | wc -l
  node dist/scripts/agency.js logs search ENOENT --log log.jsonl --all --limit 5
  node dist/scripts/agency.js logs session show <an address from the search> --log log.jsonl
  ```
  Each must start, print its first line naming the file, and exit 0. The approvals count must be larger than the default. Paste the first lines of each into the PR description.
- [ ] Run the changed test files once with output saved to the scratchpad directory, and read the file.
