---
title: Evaluating agent runs
description: How to run an Agency agent against a test suite, score it with graders, judge its output by hand, and keep everything in one run directory.
---

# Evaluating agent runs

`agency eval` runs, grades and compares agent runs. Everything it produces lives in a **run directory**: a folder with the runs' statelog and an append-only file of annotations (grades, notes, checklist answers). The main commands are:

```
agency eval run (--agent <file>[:<node>] | --agent-cmd '<command with {task}>') (--suite <file|dir|git-url> | --goal <text>) [-n <count>]
agency eval grade <runDir> [--graders <file>]
agency eval logs <runDir> [-f]
agency eval optimize <file>[:<node>] [--suite <file|dir>] [--goal <text>] [--graders <file>]
agency label <runDir> --checklist <file> [--annotator <id>]
agency note <runDir> <text> [--trace <id>]
agency runs add <runDir> [--statelog <file>]... [--code <entry>] [--workdir <path>]
agency runs list <runDir>
```

`agency label`, `agency note` and `agency runs` also work without the `eval` prefix, as written above.

## Running a test suite

`agency eval run` runs an Agency agent against every test in a suite and writes a run directory:

```bash
agency eval run --agent agent.agency:evalMain --suite suite.json --run-id smoke
```

A suite is a JSON file with `{ "inputs": [...] }` or a directory with one `.json` file per test. A test looks like this:

```json
{
  "id": "fizzbuzz-write",
  "input": "Write fizzbuzz in Agency",
  "goal": "Should produce a typechecking fizzbuzz program.",
  "files": "./fixtures/empty-project"
}
```

A test says nothing about the agent. Tests describe the work; whoever runs the eval picks the agent with `--agent file.agency:node`.

`input` is required. It is what the agent is told: a string, or a JSON object for agents that take structured data. The runner passes it as the entry node's single parameter, so **eval entry nodes take exactly one parameter**, whatever it is named. An agent that needs no input still declares one and ignores it: `node main(input: string) { ... }`. The runner checks the parameter count before anything runs.

`goal` is the success criterion. The agent never sees it. The default LLM judge needs it; a test with its own graders makes it optional (see [Custom graders](#custom-graders)). `id` defaults to a generated id and must be filesystem-safe when you supply one. `expected` is an optional gold output that match graders read. `files` names the test's fixture directory (see [Test files and suites](#test-files-and-suites)). `timeoutSec` overrides the suite's wall clock for one test. `graders` names the test's own grading module, resolved relative to the test; in the test-directory form a `graders.ts` beside `test.json` is picked up automatically. Graders are code the harness runs, so pulling a remote suite means trusting it.

For a single ad-hoc run, use `--goal` instead of `--suite`:

```bash
agency eval run --agent agent.agency --goal "Answer with a concise summary"
```

Options:

- `--agent <file>[:<node>]`: the agent. A directory resolves to `main.agency` inside it. The node defaults to `main`.
- `--suite <file|dir|git-url>`: the tests. A JSON file, a directory, or a git source (`URL[//subdir][?ref=...]`). Mutually exclusive with `--goal`.
- `--goal <text>`: one inline test whose input and goal are both this text. Mutually exclusive with `--suite`.
- `--run-id <id>`: the run directory's name. Defaults to a timestamp-prefixed id such as `2026-07-31-143022-Ab3dEf`, so run directories list in creation order.
- `--runs-dir <path>`: where run directories go. Defaults to `eval.runsDir` in `agency.json`, or `runs/`.
- `--no-continue-on-error`: stop after the first test failure. By default the remaining tests still run.
- `-n, --parallel <count>`: run up to this many tests at once. Above 1, per-agent output is replaced by a live status board on stderr with each test's name, state, elapsed time and cost so far. Drill into a live run with `agency eval logs <runDir> -f`.
- `--max-tool-call-rounds <n>`, `--max-tool-result-chars <n>`, `--strict`: the same compile-time flags `agency run` takes.

Running never grades. When the run finishes it prints the run directory and the grade command:

```
Run smoke completed: 3/3 tests ok
total LLM cost: $0.42
runs/smoke
grade it with: agency eval grade runs/smoke
```

Each run's agent process gets a wall-clock limit of 60 seconds unless `eval.limits.wallClockSec` in `agency.json` raises it:

```json
{ "eval": { "limits": { "wallClockSec": 900, "maxCostUsd": 50 } } }
```

`maxCostUsd` is a per-run LLM spend ceiling, $50 by default. The harness watches each run's cost as it happens and kills the run when it passes the cap. Enforcement lags by one LLM call, because a call's cost is known only when it returns, so treat it as an accident stopper rather than an exact budget.

## Command agents

`--agent-cmd` runs a CLI as the agent instead of compiling an `.agency`
file — the way to benchmark `agency agent` itself:

```bash
agency eval run \
  --agent-cmd 'agency agent --agent code --policy approve-all --max-tool-call-rounds 100 --verbose -p -- {task}' \
  --suite evals/terminal-bench-mini
```

The command string must contain `{task}`; every occurrence is replaced with
each test's input. The string is tokenized by a minimal quote-aware splitter
and **never passes through a shell**: no expansion, no operators — and
substitution happens after tokenization, per token, so a hostile task is
inert (`; rm -rf /` inside a task is bytes in one argv entry, not a
command). An object task substitutes as its JSON serialization.

The command runs in each input's isolated workdir. The workdir is seeded
from the input's `files` plus the invoking directory's `agency.json`/`.env`
(so two machines running the same benchmark see the same config); there is
no agent closure and nothing is compiled.

**Agency CLIs only.** The harness hands the command's process the statelog
path via `AGENCY_CONFIG_OVERRIDES` and a shared trace id via
`AGENCY_TRACE_ID` — every compiled Agency process honors both, so the
agent's own execution record (tool calls, cost, interrupts, its whole
process tree) becomes the eval record, and grading/judging work unchanged.
A non-Agency command writes no statelog and the run fails saying so.

Rules that follow from the mechanism:

- **The command must run headless and one-shot** (`agency agent --policy
  approve-all -p -- {task}`). There is no IPC channel, so eval's interrupt
  auto-approval cannot reach a command agent — an interactive command just
  waits for input that never comes until the wall clock kills it.
- **Do not pass `--log` inside the command** — it overrides the statelog
  path the harness set, and the run fails with an error naming this.
  `--trace` is safe (merged, both survive).
- **Compile-time eval flags don't apply.** `--max-tool-call-rounds`,
  `--max-tool-result-chars`, and `--strict` are baked into compiled file
  agents; a command target compiles nothing, so combining them with
  `--agent-cmd` is an error — put the agent's own flags inside the command,
  budget flags (`--max-cost`) included.
- **Keep credentials in the environment, never in the command.** The
  command string is recorded verbatim in the run directory's annotations;
  the child inherits your environment, so API keys need no argv.
- **Limits:** the wall clock applies (enforced by the harness); memory is
  capped via `NODE_OPTIONS --max-old-space-size` (V8 heap of Node
  processes — weaker than the file-target sandbox); output is drained and
  capped for display but never fails the run.
- `eval optimize` does not accept `--agent-cmd`: the optimizer mutates
  agent files, which a command target does not expose.


## Test files and suites

A workdir is seeded from two ingredients: the test's declared files and the agent's own code. The agent's code means the entry `.agency` file, everything it imports, and any local TypeScript those imports use. It is computed, so you never list agent files by hand, and the same suite can grade any agent.

A test declares its fixture directory with `files`. The contents land at the workdir root:

```jsonc
{ "id": "summarize", "input": "Summarize report.txt into summary.md",
  "goal": "summary.md captures the report's findings", "files": "./fixtures/summarize" }
```

For file-heavy tests there is a directory form: a directory of test directories, each holding `test.json` and an optional `files/` directory. The test's `id` defaults to the directory name. Point `--suite` at the parent. A directory holds one suite shape, never a mix: a single suite file with an `inputs` array, loose one-test `.json` files, or test directories.

Suites and fixtures can come from git. Anywhere a directory is accepted, a git source works too:

```bash
agency eval run --agent a.agency --suite 'github.com/you/evals//tests?ref=v1.2'
```

`//subdir` names a directory inside the repo. `?ref=` takes a branch, tag, or commit sha. Whatever you wrote, the run records the resolved sha, so any past run is pinnable by copying its sha into `?ref=`. Clones cache under `~/.agency/cache/git/`; branch refs re-fetch per run, shas never do.

An agent that reads a project file that was never seeded gets a file-not-found error inside the workdir, and the run's error names what was seeded.

## The run directory

Each run writes one directory:

```text
runs/<run-id>/
  statelog.jsonl        # every test's trace, one file
  annotations.jsonl     # what anyone concluded: run rows, grades, notes, labels
  code/<hash>/          # the agent code that ran, keyed by its content hash
  workdir/<trace-id>/   # the isolated directory each test ran in
  checklists/           # your labeling checklists (see below)
```

The statelog is the record of what happened. Everything else is derived from it or appended beside it, so a directory with only a `statelog.jsonl` is already a valid run directory. `agency runs list <dir>` shows one line per trace:

```
TRACE     STARTED           ENDED  TIME   COST   LLM  TOOLS  SCORE  NOTES  LABELED  INPUT
rpGXbww2  2026-08-18 09:14  ok     41s    $0.12  5    12     0.71   1               Write fizzbuzz…
```

You can also build one by hand. `agency runs add <dir> --statelog run.jsonl` merges a statelog in by trace, `--code agent.agency` stores the agent's code, and `--workdir ./project --trace <id>` snapshots a directory for one trace. `agency run agent.agency --capture-workdir <dir>` does all three for a plain run.

## Scoring a run

`agency eval grade <runDir>` scores a finished run and prints an objective between 0 and 1:

```bash
agency eval grade runs/smoke
#   3/3 tests ok
#   objective  0.71
#     goal  0.71
```

Each grader's verdict is appended to `annotations.jsonl` as a **score**. Grading again appends another pass rather than rewriting anything, so every grading pass survives and the latest complete pass is the one listings show. Re-grading costs nothing for `ExactMatch`, `Contains`, `Similarity` and function graders that do not call `judge`; an `LlmJudge` still makes a live LLM call each time.

With no `--graders`, each test grades itself with the `graders` module it carries. Tests without one fall back to `eval.graders` in `agency.json`, then to the bundled goal judge scoring against the test's `goal`. `--graders <file>` overrides every test's own graders for this pass, which is the experiment knob.

`agency eval logs <runDir>` opens the run in the interactive viewer, one trace per test, with each trace's grades, notes and labels summarised on its row. Press `t` for the timeline views (see the observability guide).

### Custom graders

A grading module default-exports one grader or a list of them:

```ts
// graders.ts
import { grader, ExactMatch } from "agency-lang/eval";
import { existsSync } from "fs";
import { join } from "path";

export default [
  // the return value
  grader(({ output }) => String(output).length < 500, { name: "concise" }),

  // a file the agent wrote
  grader(({ workdir }) => existsSync(join(workdir, "analyze.py")), { name: "wrote-script" }),

  // what it did along the way
  grader(({ record }) => record.metrics.costUsdTotal < 0.05, { name: "cheap" }),

  // compare against the test's `expected` field
  new ExactMatch({ mustPass: true }),
];
```

The module can be a test's own (`"graders"` in its spec, or a `graders.ts`
beside its `test.json`), the suite-wide fallback (`eval.graders` in
`agency.json`), or a run-wide override (`--graders`):

```bash
agency eval grade runs/smoke --graders graders.ts
```

A grader function receives `{ output, test, workdir, record, judge }` and returns
a number from 0 to 1, a boolean, or a full `Grade`. Options control how it counts:
`mustPass` makes it a gate, `weight` sets its share of the objective, `threshold`
sets the passing bar for scalar scores, `samples` runs it k times, and
`inputScope` restricts it to a subset of tests.

When a grading module is supplied, `goal` becomes optional on your tests.

### Pass and fail

A `mustPass` grader is the assertion. If one fails, that test scores 0, the run
reports `gatesPassed: false`, and `agency eval grade` exits 2, which makes it
usable as a CI check. Every other grader is a measurement you track over time.

A test whose agent run errored, or which the harness killed, scores 0 and fails
every gate. It is counted, not skipped: one bad test out of fifty pulls the mean
down by its share rather than zeroing the whole run. A test that produced no
output still grades, with `output` set to `null`, because for file-writing agents
the deliverable is the workdir.

## Judging output by hand

Some questions have no automatic grader. Is this summary really about today? Do
these citations point at pages that exist? Is this explanation worth reading?
You find out by looking.

`agency label` is the tool for those questions. You write a checklist of
yes-or-no questions, then answer them one trace at a time. Your answers are
appended to the run directory's `annotations.jsonl`, next to the graders'
scores, so you can turn them into training data later or measure how well an
LLM judge agrees with you.

```bash
agency label runs/smoke --checklist news.json
```

Every trace in the directory is one thing to judge. The screen shows the
trace's input and its output. When a trace recorded no output, it shows the
agent's last message instead and says so.

### Notes

For a one-off remark, skip the checklist:

```bash
agency note runs/smoke "too slow, and it never checked the date" --trace rpGXbww2
```

`--trace` is optional when the directory holds one trace. Notes show up in
`agency runs list`, in the log viewer, and in the optimizer's reflection
prompt (see [Optimizing agents](optimize.md)).

### Writing a checklist

A checklist is a JSON file listing your questions:

```json
{
  "name": "news-quality",
  "questions": [
    { "text": "Is every story actually from today?" },
    { "text": "Does each claim have a source?" },
    { "text": "Would I want to read this?", "weight": 2 }
  ]
}
```

`weight` is optional and defaults to 1. A trace's score is the weighted share
of questions you answered yes.

Do not agonize over the list. You add questions while labeling, and discovering
them halfway through is the normal way this goes, not a planning failure.

### One rule for questions

**Every question must be answerable from the trace's input and output alone.**

Those two things and your answer are the whole training example. An agent
learning from your labels sees nothing else. A question that depends on
anything outside them produces a label about information the agent never
receives.

"Is every story from today?" breaks that rule when the output never says which
day it was written. The fix is to make the output say so, not to reword the
question. Nothing checks this for you; the tool cannot know that "today" is
unanchored.

### Labelling

`agency label runs/smoke --checklist news.json` opens the screen. One trace
fills the left, the checklist fills the right.

| Key | What it does |
|---|---|
| `space` | answer the current question yes or no |
| `↑` `↓` | move between questions |
| `←` `→` | move between traces |
| `enter` | sign off on this trace and go to the next |
| `a` | add a question |
| `d` | remove a question, or bring one back |
| `m` | write a note |
| `q` | quit |

Signing off is deliberate. Your answers are not recorded until you press
`enter`, so moving through a trace to read it changes nothing.

Quitting halfway is safe. The session is saved as you go, and reopening it puts
you back where you stopped.

### Where your answers go

Each sign-off appends one `checklist` row to `annotations.jsonl`, naming the
trace, the checklist version and your answers per question. Every version of a
checklist is kept under `checklists/`. Editing a question does not rewrite
history, so a label made against an older version still says what it meant.

Two people labeling the same directory keep separate answers, keyed by
`--annotator` (your user name by default). Only one labeling session can have
a run directory open at a time.

## Optimizing marked declarations

`agency eval optimize` (also `agency optimize`) rewrites the declarations you mark with the `optimize` modifier, grading candidates against your suite and keeping the best one. It has its own page: see **[Optimizing agents](optimize.md)** for marking targets, custom graders, validation sets, configuration, and run artifacts.

## The eval record

Graders and judges do not read raw statelog events. They read an **eval record**: a small, normalized view of one trace, computed from the statelog whenever it is needed and never written to disk. It is what a grader's `record` argument holds and what `agency eval judge` compares.

## How to annotate a run

Import `std::statelog` and call `evalValue` / `evalOutput` where values cross the user-facing boundary:

```ts
import { evalValue, evalOutput } from "std::statelog"

node main(prompt: string): string {
  evalValue(prompt)
  const reply = doWork(prompt)
  evalOutput(reply)
  return reply
}
```

`evalOutputs` is **the entry node's return value** — the same thing `agency run` prints and a TypeScript caller receives. An agent that returns its answer needs no annotation at all.

There is no guessing here. The last LLM completion is never used as a stand-in for a return value, because a plausible-looking chat reply is worse than an honest gap: it makes an agent that produced nothing look like it produced something. If the node returns nothing, or returns `null`, and `evalOutput()` was never called, the record has no output and says so in `warnings`.

Returning `null` counts as no output rather than as the value `null`. An unmatched `match` or a missing key normalizes to `null` in Agency, so grading the string `"null"` would silently score a program that produced nothing. If your node genuinely has no return value, call `evalOutput(value)` to say what should be graded.

`evalValues` is different: it is inferred from the last user-role message of the first top-level `promptCompletion`, and warns when it does so. That one is a genuine guess — annotate with `evalValue(prompt)` if you care about it.

## Record shape (overview)

```jsonc
{
  "traceId": "...",
  "recordVersion": 2,
  "formatVersion": 1,
  "durationMs": 12345,
  "source": "/path/to/runs/smoke/statelog.jsonl",
  "evalValues": [{ "value": "what the user asked", "threadId": "0", "tMs": 120 }],
  "evalOutputs": [{ "value": "what the agent replied", "threadId": "0", "tMs": 420 }],
  "threads": [{ "threadId": "0", "label": "main", "parentThreadId": null, ... }],
  "events":  [{ "kind": "llm", "threadId": "0", "model": "gpt-5", ... }, ...],
  "interrupts": [...],
  "errors": [...],
  "incomplete": [...],
  "metrics": { "llmCalls": 5, "toolEnds": 12, "toolCounts": { "grep": 8, ... }, ... },
  "warnings": []
}
```

Every entry in `events` is one of three discriminated shapes:

- `{ kind: "llm" }` — one per `promptCompletion`. Carries model, tools, duration, cost, token counts.
- `{ kind: "tool_start" }` — one per `toolCallStart`. Carries `argsPreview`.
- `{ kind: "tool_end" }` — one per `toolCall`. Carries `outputPreview` and duration.

All three carry `threadId`, `spanId`, `parentSpanId`, and `tMs` (milliseconds from the start of the run).

Every entry in `evalValues` and `evalOutputs` has this shape:

```jsonc
{ "value": unknown, "threadId": "0", "tMs": 420, "truncated": true }
```

- `value` is the JSON-serializable value passed to `evalValue` / `evalOutput`, or a heuristic fallback value when annotations are missing.
- `threadId` identifies the active thread that recorded the value, or `null` when unavailable.
- `tMs` is milliseconds from the trace start, derived from the statelog envelope timestamp.
- `truncated` is present only when the serialized value exceeded `STATELOG_EVAL_MAX_VALUE_BYTES`. The default cap is 100KB; set that environment variable to override it. Oversized string values are kept as readable string prefixes; oversized non-string values are converted to JSON-preview strings.

Consumers that need one response typically read `record.evalOutputs.at(-1)?.value`. A pairwise judge compares the last element of `evalOutputs`; without annotations that value is the entry node's return value, and the array is empty when the node returned nothing.

## Behavioral-flag recipe

Common "did the agent do X?" questions are consumer recipes, not built-ins. Two examples:

```typescript
import type { EvalRecord } from "agency-lang/lib/eval/types.js";

function consultedOracle(rec: EvalRecord): boolean {
  return rec.threads.some(t => t.label === "oracle");
}

function grepBeforeWrite(rec: EvalRecord): boolean {
  const firstWrite = rec.events.findIndex(e =>
    e.kind === "tool_end" && (e.tool === "write" || e.tool === "edit"));
  if (firstWrite === -1) return true; // no write happened
  return rec.events.slice(0, firstWrite).some(e =>
    e.kind === "tool_end" && e.tool === "grep");
}
```

If a convention emerges (a set of rules every project wants), it can be promoted to a built-in `agency eval check --rules <file>` later.

## Downstream chain

`evalValues` and `evalOutputs` are hoisted to the top level because graders and pairwise judges need the user-facing inputs and outputs without digging through raw `promptCompletion` events. `threads[*].label` is what behavioral queries grep on.

Next: use [`agency eval judge`](./eval-judge.md) to compare two runs against a plain-English goal. To hand one trace to someone else, `agency logs extract run.jsonl --trace <id> -o trace.jsonl` copies it out of a statelog.

## Legacy traces

Statelog traces captured before the relevant runtime fields landed (thread labels/sessions, `toolCallStart`, interrupt summaries, per-event `threadId`) still produce a record. Fields that are not present in the source come through as `null` and a single warning is emitted in `record.warnings`. Don't rely on those fields when grading legacy traces; recapture if you can.
