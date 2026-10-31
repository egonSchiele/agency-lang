# Agent tool traces: one line per call, and only what the user needs

Date: 2026-10-31. Status: design, approved in conversation by the owner.

## What this is

`agency agent` prints a block to the terminal every time the model calls a
tool, and another block when the tool finishes. The blocks show every
argument and a preview of the result. This design replaces most of those
blocks with one short line per call. The line names the thing the tool
touched, says whether the call worked, and shows a count or a verdict in
place of a result preview. It also writes down the rules that decide what a
tool's line shows, so the next person who adds a tool to the agent knows
what to do.

Here is a `read` call today:

```text
● Tool call read
 │ filename: "docs/dev/llm/mlx-local-models.md"
 │ dir: "."
 │ offset: 460
 │ limit: 120

✓ Tool finished read
 │ untouched, and a longer reply is logged with `… (truncated)`. `describeReply`
 │ then keeps that body w…
```

Here is the same call after this work:

```text
✓ Read docs/dev/llm/mlx-local-models.md · lines 460–580
```

## Why

A person watching the agent is asking four questions. Is it making
progress? Is it doing something risky? Is it on the right track? What is
taking so long? The argument dump answers none of them well. Nobody needs
to know that `grep` was called with `wholeWord: false`. Someone who does
want that detail has the statelog log and `--debug`.

One question matters more than it looks. When the agent reads a file in
pieces, the user sees the same filename go by four times and concludes the
agent is stuck in a loop. The line has to carry whatever makes two
consecutive calls look different when they are different. For `read` that
is the line range.

## Goals

- Each tool call prints one line unless the call can take long.
- The line names the noun the tool acted on and nothing else from the
  arguments.
- A result is shown as a count or a verdict, never as a text preview.
- Failures and rejections print their message in full.
- The display rules are data in one table, and a tool without an entry
  falls back to today's generic display.
- The guidelines are written into the existing dev doc,
  `docs/dev/agents/tool-output.md`, so they outlive this change.

## Non-goals

- The todo, web search, and subagent displays already print structured
  bodies and stay as they are, except that a subagent's completion line
  gains an elapsed time.
- `--debug` and `--verbose` output for model calls is not touched.
- The statelog log is not touched. It remains the place to see every
  argument.
- No change to what the model receives. This is display only, apart from
  the spill source name below, which the model also sees in the notice.

## Anti-goals

- A line that looks the same for two different calls. If the design makes
  a repeated `read` of two different ranges print identically, it has
  failed.
- A write, delete, commit, or post that the user only learns about after
  it happened. Those print their noun before they run.
- A failure hidden behind a tidy count.

## The guidelines

These go into `docs/dev/agents/tool-output.md` as a new section, in this
form. They are the rules; the table later in this document is their
application.

1. **The trace answers four questions, in this order.** What did the
   agent touch? Is this call different from the last one? Did it work?
   What is taking so long? Anything that answers none of these is noise.
2. **Show nouns, not arguments.** Each line names the thing the tool acted
   on: a path, a pattern, a command, a URL, a branch. Flags and options
   are left out, with one exception: a flag that changes what a risky
   call does (`force`, `all`) or what a read returns (`invert`, `staged`)
   counts as a noun.
3. **Two consecutive calls must never look identical unless they are.**
   The line includes whatever distinguishes a repeat from a new call: the
   line range of a `read`, the pattern and directory of a `grep`.
4. **One line per call unless the call can take long.** A tool gets a
   start line and a separate end line only when it can run for seconds or
   more. Instant tools get one line, printed when the call settles.
5. **Results are shown as a count or a verdict, not as text.**
   `12 matches`, `3 files`, `exit 0`, `clean`, `2 errors`. The result body
   is for the model. The exceptions are tools whose result is the point
   (todo lists, search sources), and they have custom displays.
6. **Failures are always shown in full.** A failed or rejected call prints
   the whole message on the row under the line.
7. **Risky calls stand out.** Anything that writes, deletes, commits,
   posts, or spends money prints its noun on a start line even if it is
   instant, so the user sees it before and not only after.
8. **Elapsed time appears only when it was at least one second**, and only
   on the end line of a two-line tool, in whole seconds.
9. **A tool nobody has thought about falls back to the generic display.**
   Full argument dump at start, preview at end, with the tool name in the
   heading, since that heading has no other label. That is allowed, and a
   reviewer should notice it. Tools whose names are not known when the
   code is written (MCP tools, `learned_*` tools, generated tools, Claude
   skill tools) use the generic display by design.
10. **Hand-written display code is the last resort.** A tool gets a custom
    describe function only when its output has a shape the summary table
    cannot express.

## How it works

### The end event carries the arguments

Today the runtime emits `onToolCallEnd` with the tool name, the result,
and the time taken (`lib/runtime/hooks.ts:53`, emitted at
`lib/runtime/prompt.ts:1686`). A one-line display printed at settle time
needs the arguments too, because the line is built from them.

Change: `onToolCallEnd` gains `args: Record<string, unknown>`, the same
object `onToolCallStart` received. The start event already has it in
scope in `prompt.ts`; the end step reads it from the same tool call
record. No other callback changes. The field is additive, so existing
callbacks keep working.

This is a runtime change in `lib/runtime/prompt.ts` and `hooks.ts`. The
builder should check that a resumed invocation (where the invoke step is
skipped and the end hook runs from the persisted state) still has the
arguments available. They are part of the tool call the model made, which
is in the message history, so they should be.

### The trace event types

`ToolEndEvent` in `lib/stdlib/agentToolTrace.ts` gains `args: unknown` and
`timeTaken: number` (milliseconds). `trace.agency` passes both through from
the callback data.

### The table is keyed by the name the model sees

`TOOL_PRESENTATIONS` is looked up by `event.toolName`, which the runtime
fills from the tool's model-facing name (`handler.name` in `prompt.ts`).
That is the name after any `.rename()`. So a row is written under the
renamed spelling: `agencyGuide`, not `docSkill`; `wikipedia_search`, not
`wikipediaSearch`. A `.rename()` without a matching row sends the tool to
the generic display, which guideline 9 permits and a reviewer should
catch. This is my call: adding the registered name to the event would
mean a new field on the runtime hook for no gain, since the user reads
the model-facing name in the log too.

### One table, four kinds

`TOOL_PRESENTATIONS` in `lib/stdlib/agentToolTrace.ts` is today a record
from tool name to a presentation of kind `tasks` or `agent`. It grows two
kinds:

- `summary`: the new data-driven display that most tools use.
- `silent`: the tool prints nothing. Today this is the `SKIP_TRACING` list
  in `trace.agency`; it moves into the table so there is one place.

The `summary` shape:

```ts
type SummaryPresentation = {
  kind: "summary";
  // The verb or noun that starts the line: "Read", "Grep", "git diff".
  label: string;
  // The parts shown after the label, built from the call's arguments with
  // a few shared helpers. A null part is skipped.
  show: (args: ToolArgs, lookup: SpillLookup) => (string | null)[];
  // true: a start line is printed when the call begins and an end line when
  // it settles. false: one line when it settles.
  twoLines: boolean;
  // How the successful result is summarized on the line.
  result: ResultSummary;
};
```

A row reads as data, one or two lines each:

```ts
read:      { kind: "summary", label: "Read",       twoLines: false, result: "none",
             show: (a) => [filePath(a), lineRange(a)] },
gitCommit: { kind: "summary", label: "git commit", twoLines: true,  result: "none",
             show: (a) => [firstLine(a.message)] },
```

`show` is a function and not a mini-language because the forms kept
multiplying (a range, a joined path, a first line, a flag, a spill
lookup), and each form of a format language is an interpreter feature
with its own code and tests. The helpers are the vocabulary: `text`
(a string, number, or string array as one piece), `filePath` (`dir`
joined to `filename` when `dir` is set and not `.`), `lineRange`,
`firstLine`, `flag` (a word when a boolean is true), and `spillOutput`
(`output of <source>` through the lookup, else the raw name). Every
shown value is cut to its first line with `…` when there was more, so a
heredoc command prints as one line.

Line ranges follow `sliceLines`: `offset` is the 1-based first line and
`limit` a count, each 0 when unset. So `offset 460, limit 120` prints
`lines 460–579`, `offset 0, limit 120` prints `lines 1–120`, `offset 460,
limit 0` prints `lines 460–end`, and both 0 prints nothing.

`ResultSummary` is `"none"`, `"preview"`, `{ one, many }` (a count with both noun forms),
`{ exitCode: true }`, or a `custom` function. `exitCode` prints `exit N`,
turns the mark red when N is not 0, and prints the command's output under
the line by the rule below. `exec` and `agencyCli` return a plain object,
not a Result, so this is how a failed command stops looking like a
success.

`custom` summarizers are small named functions in the same file, for the
handful of results where a count is not enough: grep (lines and files, or
files alone when `filesOnly` returned paths), grepSpill (lines summed
across patterns when `morePatterns` grouped them), typecheck (errors and
warnings), testFile (passed and failed cases). They take the result value
and the arguments and return a short string or null, and may say the
result counts as a failure so the mark turns red.

Command output under a line: show `stderr` when it is not empty, else
`stdout`. When that text is a spill notice (it starts with `[Output`), show
only its first line, which carries the size and exit code; the rest is
written for the model.

### How a line is built

For a one-line tool, nothing prints at start. At end:

```text
<mark> <label> <shown arguments joined by spaces> · <result summary> · <elapsed>
```

The mark is `✓` green on success, `✗` red on failure or rejection. On
failure, the result summary is dropped and the failure message prints in
full on a rail row under the line, as failures do today. Elapsed time
appears only when `timeTaken >= 1000` and the tool is two-line.

For a two-line tool, the start prints `● <label> <arguments>` in blue. The
end prints the same line with the mark and the summary, so the user can
pair them by eye. End events have no call id, so the renderer does not try
to pair them in code. This is the existing rule in the dev doc and it
stays.

A summary line does not carry the tool's registered name: the label is
enough. In `--debug` mode the name is appended in dim text, which is how
a reader finds the tool in the log. The generic, todo, search, and
subagent headings keep the name as today.

Shown values are sanitized by the renderer and wrap at the terminal
width. They are not cut at the 50-character argument preview: the
command or path is the whole point of the line.

### Rejected and failed calls

`trace.agency` already turns a Result failure or a native rejection into a
`toolEnd` with `outcome: "failure"`. Nothing changes there. The summary
display prints `✗ <label> <arguments>` and the message under it.

### Readable spill names

`safeBash` output over 2000 characters, and any tool result over an
`llm()` call's `spillToolResultsOver`, is saved in the run's output store
and the model is handed a name like
`2026-09-04T01-02-03-000Z-a1b2c3.log`. The model then calls `readSpill`
or `grepSpill` with that name. A trace line that says
`Read saved output 2026-09-04T01-02-03-000Z-a1b2c3.log` tells the user
nothing.

Change: every saved entry gets a readable `source` beside its name.

- `SavedOutput` in `lib/runtime/toolOutputStore.ts` becomes
  `{ name, text, source }`.
- `storeOutput(run, text)` becomes `storeOutput(run, text, source)`.
- `keepOutput(text, exitCode)` in `std::spill` gains a `source: string`
  parameter. Its only callers are in `safeBash.agency` and
  `safeBash/actions.agency`. Every path passes the command the user saw on
  the `safeBash` trace line, so `● Run pnpm run typecheck` is followed
  later by `✓ Read output of pnpm run typecheck`. `exec` never calls
  `keepOutput`; its output reaches the store only through the tool loop
  below.
- The tool loop's spill in `capToolResultForLlm`
  (`lib/runtime/toolInvocation.ts`, which today receives only a
  `ToolIdentity` and the result) gains the call's named arguments, threaded
  from the call site. Its source is the tool name followed by the first
  argument whose value is a string, cut at 80 characters: for example
  `fetchMarkdown https://example.com/docs`, or `exec git` for a command
  with its arguments in an array. This is a fixed rule in the runtime, not
  a lookup in the presentation table: `lib/runtime` must not depend on
  `lib/stdlib/agentToolTrace.ts`. Only the stdlib agents behind the
  subagent tools set `spillToolResultsOver` today, so this source appears
  inside subagent dispatches, not in the coordinator's own calls.
- A new `findOutputSource(run, name): string | null` returns the source.
- The notice the model sees adds the source in one phrase, so the model
  also knows what the output was: `[Output of "pnpm run typecheck" too
  long to return in full: ...]`. This is the one place the model's view
  changes.

The trace for `readSpill` and `grepSpill` then shows the source in place of
the name: `✓ Read output of pnpm run typecheck lines 1–200`. The renderer
is pure; the Agency bridge `_printAgentTrace` hands it a lookup over the
current run. When the name is not in the store, the line falls back to the
raw name.

Checkpoints: the store lives in the run's globals and rides in every
checkpoint. The checkpoint schema stores globals as an open record
(`lib/runtime/state/schemas.ts`), so adding a field needs no schema
change, and the code fingerprint covers module code only. An old
checkpoint whose entries have no `source` must still restore; readers
treat a missing `source` as null and fall back to the name.

### Where the guidelines live

`docs/dev/agents/tool-output.md` gains a "Display rules" rewrite with the
ten guidelines above and a description of the `summary` kind, plus the
instruction that adding a tool to an agent toolkit means adding a row to
`TOOL_PRESENTATIONS` or deciding, in review, that generic is fine. The
per-tool table below is not copied into the dev doc; the code table is the
record.

## The per-tool table

"One" means one line, printed when the call settles. "Two" means a start
line and an end line. The example is a successful call. Tools are grouped
by the toolkit function in `stdlib/agents/lib/toolkits.agency` that offers
them. Every tool in `mainAgentTools` (coordinator) and `codeTools` (code
agent) is listed.

### Files: `readOnlyFileTools`, `writableFileTools`

| Tool | Lines | Example | Shows | Result |
|---|---|---|---|---|
| read | one | `✓ Read docs/dev/llm/mlx.md lines 460–579` | `dir/filename` (dir dropped when `.`); range only when offset or limit set, by the `sliceLines` rule above | none |
| ls | one | `✓ List stdlib/agents · 14 entries` | dir; `recursive` when true | count, noun "entries" |
| glob | one | `✓ Glob **/*.test.ts in lib · 37 files` | pattern; `in <dir>` | count, noun "files" |
| grep | one | `✓ Grep "registers\|plugin" in docs/dev/llm · 12 lines in 3 files` | pattern; `in <path>`; `files only`, `inverted` when set | custom: lines matched and distinct files among the matches; `3 files` when `filesOnly` returned paths |
| write | one, but noun shown before the call runs: see note | `✓ Write docs/specs/foo.md · 2.1 KB` | `dir/filename`; `append` when mode is append | custom: byte size of content |
| edit | one | `✓ Edit lib/runtime/prompt.ts · 3 edits` | `dir/filename` | custom: length of edits array |

Note on `write` and `edit`: guideline 7 says a write shows its noun before
it runs. But these are instant and their interrupt prompt already names
the file before it runs when a policy does not pre-approve it. One line
is enough. The owner's decision in the conversation: instant file writes
get one line.

Grep counts: the result is a list of matches with a `file` field. "Lines"
is the length of the list. "Files" is the number of distinct `file`
values. This is files that had a match, not files searched, because the
tool does not report files searched. The owner asked for both numbers;
this reading is my call and the phrasing makes it honest.

### Shell: `shellTools`

| Tool | Lines | Example | Shows | Result |
|---|---|---|---|---|
| safeBash | two | `● Run pnpm run typecheck` then `✓ Run pnpm run typecheck · 14s` | command, first line | none on success; custom failure summarizer, see below |
| exec | two | `● Run git log --oneline -5` then `✗ Run git log … · exit 128` | command and args joined | exitCode: red when not 0, output under the line |
| readSpill | one | `✓ Read output of pnpm run typecheck lines 1–200` | source looked up from the name; range as `read` | none |
| grepSpill | one | `✓ Grep "error" in output of pnpm run typecheck · 4 lines` | pattern; source | custom: lines, summed across patterns |

`safeBash` returns a `Result<string>`. A success carries the output or
the spill notice, with no exit code, so a successful line is
`✓ Run <command>` with no `exit 0`. A failure's message is a JSON string
`{command, exitCode, stderr, stdout}` (`stdlib/safeBash/actions.agency`),
where `stderr` and `stdout` may each be a spill notice. The `safeBash`
row gets a custom failure summarizer that parses that JSON: the line reads
`✗ Run <command> · exit 2` and the command's output prints under it by
the rule above (stderr, else stdout; a notice shows its first line). When
the message is not that JSON, it prints in full as any other failure does.
`exec` and `agencyCli` return a plain `ExecResult` with `exitCode` on both
success and failure, so their `exitCode` summarizer reads it directly.
Guideline 6 is read as "print the part a human would read", not "print
the JSON".

### Git: `gitTools`

| Tools | Lines | Example | Shows | Result |
|---|---|---|---|---|
| gitIsRepo, gitStatus, gitLog, gitDiff, gitShow, gitBlame, gitBranchList, gitRemoteList, gitStashList | one | `✓ git diff lib/runtime` | label is the git subcommand; the path or ref argument when present; `--staged` on a staged diff | none |
| gitAdd, gitCommit, gitCheckout, gitSwitch, gitBranchCreate, gitBranchDelete, gitStashPush, gitStashPop, gitRestore | two | `● git commit Add summary tier` | commit: first line of message. checkout, switch, branch create and delete: the branch, plus `--force` when forced. add: the paths, or `--all`. restore: the paths. stash: nothing. | none |

The builder reads each tool's parameter names from its definition to fill
`show`. The label for every git tool is `git <subcommand>` in the same
spelling the command line uses.

### GitHub: `githubTools`

| Tools | Lines | Example | Shows | Result |
|---|---|---|---|---|
| ghPrGet, ghPrList, ghPrDiff, ghPrFiles, ghPrReviews, ghPrReviewComments, ghPrChecks, ghIssueGet, ghIssueList, ghIssueComments, ghIssueSearch | two | `● gh pr checks #1310` | the PR or issue number as `#N`; the query for search; nothing for list | none |
| ghPrReviewComment, ghPrReview, ghPrApprove, ghIssueCreate, ghIssueComment, ghIssueClose, ghIssueLabel | two | `● gh pr review #1310 REQUEST_CHANGES` | number; the review event as the API spells it, the issue title, or the labels | none |

Network calls, so two lines. Labels are `gh pr <x>` and `gh issue <x>`.

### Web: `webTools`

| Tool | Lines | Example | Shows | Result |
|---|---|---|---|---|
| fetchMarkdown | two | `● Fetch https://example.com/docs` then `✓ Fetch https://example.com/docs · 48 KB` | `baseUrl` (the runtime has already folded the `url` alias into it), with path appended when set | custom: size of the returned text |
| wikipedia_search, wikipedia_summary, wikipedia_article | two | `● Wikipedia "Hopfield network"` | the query or title | none |
| web search providers | custom, unchanged | | | |

A cached fetch is not marked. The result does not say whether the cache
answered, and adding that is out of scope.

### Agency: `agencyCodeTools` and the code agent's own

| Tool | Lines | Example | Shows | Result |
|---|---|---|---|---|
| typecheck | one | `✓ Typecheck · clean` or `✗ Typecheck · 3 errors, 1 warning` | nothing: the tool takes source text, not a path | custom from `TypeCheckReport`: "clean", or error and warning counts. Errors make the mark red even on a success Result. |
| parseAST | one | `✓ Parse` | nothing (source is inline text) | none |
| testFile | two | `● Test review.test.json` then `✓ Test review.test.json · 7 passed` | filename | custom from `TestReport`: passed and failed counts; any failure is red |
| agencyCli | two | `● agency fmt foo.agency` | args joined | exitCode |
| compile, run, and other `std::agency` tools the code agent may have | generic | | | |

### Docs and skills

| Tools | Lines | Example | Shows | Result |
|---|---|---|---|---|
| agencyGuide, agencyCliDocs, agencyDiagnostics, agencyStdlib, agencyAgent (the model-facing names of the doc tools; the brief variants share them) | one | `✓ Docs guide/interrupts.md` | `filename`: these tools are `read` partially applied to a docs directory | none |
| skill (Claude skills), coordinator_skills, superpowersSkill, skills_coding | one | `✓ Skill brainstorming` | the skill's `name`, or `filename` for the `read`-based ones | none |

The builder reads each skill tool's model-facing name and parameter from
its definition before writing the row.

### Memory and planning

| Tool | Lines | Example | Shows | Result |
|---|---|---|---|---|
| remember | two | `● Remember` then `✓ Remember · 3s` | nothing; the content is long and may be personal | none (the tool returns nothing on success). Two lines because it makes a model call. |
| recall | one | `✓ Recall "preferred editor"` | query | none (the result is formatted text, not a list) |
| todoWrite, todoAdd, todoUpdate, todoList | custom, unchanged | | | |
| saveDraft | silent | | | |

### Talking to the user

| Tool | Lines | Notes |
|---|---|---|
| whatIAmDoing | silent | Prints its own message. Already skipped. |
| question | silent | The interrupt prompt is the display. Owner's decision. |
| elapsedTime | one | `✓ Elapsed · 4m 10s`: the result is the point, so it is shown. |
| learnTools | two | `● Learn tools <module or file>`: dispatches a subprocess. |

A one-line tool that raises an interrupt shows the approval prompt before
its line, and the prompt names the path. That is enough; no trace line is
printed before the prompt.

### Subagents and handoffs

| Tools | Lines | Notes |
|---|---|---|
| researchAgent, codeAgent, reviewAgent, oracleAgent, explorerAgent, writingAgent, rewriteAgent | custom, one announcement per dispatch as today | The completion line gains `· 2m 14s` from `timeTaken`. Minutes and seconds when over a minute, else seconds. |

### Images

| Tool | Lines | Example | Shows | Result |
|---|---|---|---|---|
| generateImageFile | two | `● Generate image → out/cover.png` then `✓ … · 23s` | path, not the prompt | none |
| viewImageFile | one | `✓ View out/cover.png` | path | none |

### Code agent only

| Tools | Lines | Example | Shows | Result |
|---|---|---|---|---|
| setAgentCwd, getAgentCwd | one | `✓ Working directory → packages/agency-lang` | setAgentCwd: the new path. getAgentCwd: the result. | getAgentCwd: preview |

### Coordinator only: the rest of `mainAgentTools`

| Tools | Lines | Example | Shows | Result |
|---|---|---|---|---|
| learnSkill | two | `● Learn skill deploy-checklist` | name | none |
| writeToolFor | two | `● Write tool fetch-prices` | name | none |
| listPresets, savePreset, deletePreset, setDefaultPreset, useLlmOptions | one | `✓ Preset save fast-local` | the preset name when there is one | none |

## Testing

- `lib/stdlib/agentToolTrace.test.ts` already renders events to plain text
  and checks the output. Add one case per `summary` feature: one-line
  tool, two-line tool, range shown only when set, each result summarizer,
  failure under the line, elapsed time shown and hidden, generic fallback
  for an unknown tool.
- One test per custom summarizer with a real-shaped result (a grep match
  list, a `TypeCheckReport`, a `TestReport`).
- The spill store tests in `lib/runtime` or `lib/stdlib/spill.test.ts`
  gain: source stored and read back; an entry without a source restores
  and reads as null.
- A runtime test that `onToolCallEnd` receives `args`, including after a
  resume. There are existing callback tests in `tests/agency/` for the tool
  hooks; extend the nearest one.
- No LLM calls in any of these.

## Left to the builder

- Exact helper names in the presentation table.
- Whether the git tools' `show` is filled from a shared helper or listed per
  tool.
- Row order and any wrapping behaviour already owned by the renderer.
