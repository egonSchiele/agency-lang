---
title: Evaluating agent runs
description: How to run an Agency agent against an eval suite, score it with automatic graders, judge its output by hand, and extract an eval record from a statelog trace.
---

# Evaluating agent runs

`agency eval` is the umbrella for tools that run, grade, compare, and analyze agent runs from their captured statelog traces. The main subcommands are:

```
agency eval run (--agent <file>[:<node>] | --agent-cmd '<command with {task}>') (--inputs <file|dir|git-url> | --goal <text>) [-n <count>] [--graders <file>] [--no-grade]
agency eval grade <runDir> [--graders <file>] [-o <path>]
agency eval logs <runDir> [--input <id>] [-f]
agency eval optimize <file>[:<node>] [--inputs <file|dir>] [--goal <text>] [--graders <file>] [--validation-inputs <file|dir> | --validation-split <ratio>]
agency eval extract <file>
agency label ingest <source> --source <name> [--format run|files|json|statelog] [--trace <id>] [--output <trace>=print:<index>] [--task <text>]
agency label [--checklist <file>] [--dataset <dir>] [--annotator <id>]
```

The collection of judged outputs is a **dataset** (`--dataset`, or `eval.dataset`
in `agency.json`; `--store`/`eval.labelStore` still work as deprecated aliases).

`agency label` also answers to `agency eval label`, if you prefer to keep the
whole family under one name.

## Running an input suite

`agency eval run` executes an Agency agent against one or more eval inputs and writes a structured run directory:

```bash
agency eval run --agent agent.agency:evalMain --inputs inputs.json --run-id smoke
```

Input suites can be either a JSON file with `{ "inputs": [...] }` or a directory containing one `.json` file per input. An input has this shape:

```json
{
  "id": "fizzbuzz-write",
  "task": "Write fizzbuzz in Agency",
  "goal": "Should produce a typechecking fizzbuzz program.",
  "files": "./fixtures/empty-project"
}
```

Nothing in an input describes the agent — tests define the task; the person
running the eval picks the agent and its node with `--agent file.agency:node`.

`task` is required: what the agent is told. It is a string, or a JSON object
for agents that take structured data, and it is delivered as the entry
node's single parameter — **eval entry nodes take exactly one parameter**,
whatever it is named. Agents with a different shape add a small
one-parameter adapter node. That includes agents that need no input at all
(a fixed pipeline you run and grade): declare the parameter and ignore it —
`node main(task: string) { ... }`. The parameter count is checked before
anything runs, so a mis-shaped node is one configuration error, not a suite
of run failures.

`goal` is the success criterion, never shown to the agent. It is required
when the default LLM judge will run; a test with its own graders (or a
suite-level grading module) makes it optional — see
[Custom graders](#custom-graders). `id` defaults to a generated id and must
be filesystem-safe when supplied. `expected` is an optional gold output
(any JSON) read by match graders and surfaced to the optimizer's
reflection. `files` names the test's fixture directory (see
[Test files and suites](#test-files-and-suites)). `timeoutSec` overrides
the suite's wall clock for this one test (terminal-bench's per-task
`timeout_sec`), for tasks that legitimately need longer. `graders` names the
test's own grading module, resolved relative to the test — in the
test-directory form a `graders.ts` beside `test.json` is picked up
automatically. Graders are code the harness executes: pulling a remote
suite means trusting it.

For a single ad-hoc run, use `--goal` instead of `--inputs`:

```bash
agency eval run --agent agent.agency --goal "Answer with a concise summary"
```

Options:

- `--agent <file>[:<node>]` — required agent target. Directory targets resolve to `main.agency` inside the directory. The node defaults to `main`.
- `--inputs <file|dir|git-url>` — input suite: a JSON file, a directory, or a git source (`URL[//subdir][?ref=...]`). Mutually exclusive with `--goal`.
- `--goal <text>` — create one inline input whose task AND goal are both this text (the quick case where instruction and criterion coincide). Mutually exclusive with `--inputs`.
- `--run-id <id>` — output run id. Defaults to a timestamp-prefixed id (e.g. `2026-07-31-143022-Ab3dEf`), so run directories list in creation order. The run directory path is printed at the start of the run.
- `--runs-dir <path>` — output root. Defaults to `eval.runsDir` in `agency.json`, or `runs/`.
- `--no-continue-on-error` — stop after the first input failure. By default, remaining inputs continue.
- `--graders <file>` — a TypeScript grading module that OVERRIDES every test's own graders for this run (the experiment knob). Without it, each test grades itself with its own `graders` module; tests without one fall back to `eval.graders` in `agency.json`, then the bundled goal judge.
- `--no-grade` — skip scoring; only run the agent.
- `-n, --parallel <count>` — run up to this many inputs at once (default 1, sequential). Above 1, per-agent output is replaced by a live status board on stderr: each test's name, state, elapsed time, and cost so far (tailed from its statelog every second). Drill into a live run with `agency eval logs <runDir> --input <id> -f`.
- `--max-tool-call-rounds <n>` — max LLM tool-call rounds per tool loop, same as `agency run` (default 10; overrides `agency.json`). Agents that iterate — write code, hit an error, retry — routinely need more than the default.
- `--max-tool-result-chars <n>` — cap on a single tool result fed back to the model, same as `agency run` (0 disables; overrides `agency.json`).
- `--strict` — fail the run on any fatal type error, same as `agency run`.

Each run's agent subprocess also gets a wall-clock limit — 60 seconds unless
`eval.limits.wallClockSec` in `agency.json` raises it:

```json
{ "eval": { "limits": { "wallClockSec": 900, "maxCostUsd": 50 } } }
```

`maxCostUsd` is a defensive per-run LLM spend ceiling (default $50): the
harness watches each run's cost as it happens — cost telemetry for file
agents, the statelog for command agents — and kills the run when it passes
the cap. Enforcement lags by one LLM call (a call's cost is known only when
it returns), so treat it as an accident stopper, not an exact budget. The
CLI prints the total LLM cost after every run, interrupted runs included.

## Command agents

`--agent-cmd` runs a CLI as the agent instead of compiling an `.agency`
file — the way to benchmark `agency agent` itself:

```bash
agency eval run \
  --agent-cmd 'agency agent --agent code --policy approve-all --max-tool-call-rounds 100 --verbose -p -- {task}' \
  --inputs evals/terminal-bench-mini
```

The command string must contain `{task}`; every occurrence is replaced with
each input's task. The string is tokenized by a minimal quote-aware splitter
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
  command string is recorded verbatim as `agentLabel` in `summary.json`;
  the child inherits your environment, so API keys need no argv.
- **Limits:** the wall clock applies (enforced by the harness); memory is
  capped via `NODE_OPTIONS --max-old-space-size` (V8 heap of Node
  processes — weaker than the file-target sandbox); output is drained and
  capped for display but never fails the run.
- `eval optimize` does not accept `--agent-cmd`: the optimizer mutates
  agent files, which a command target does not expose.

Provenance for command runs records the command string, the harness
version, and (when the command invokes the `agency` CLI) that CLI's
`--version` — command runs lose file-target provenance's sha-comparability,
so these anchor comparisons over time.

## Test files and suites

A workdir is seeded from **two ingredients**: the input's declared files and the
agent's own code — the entry `.agency` file, everything it transitively imports,
and any local TypeScript files those imports use (computed; never list agent
files by hand). The same suite can therefore grade any agent.

An input declares its fixture directory with `files`; the contents land at the
workdir root:

```jsonc
{ "id": "summarize", "task": "Summarize report.txt into summary.md",
  "goal": "summary.md captures the report's findings", "files": "./fixtures/summarize" }
```

For file-heavy tests, a directory form is equivalent: a directory of test
directories, each holding `test.json` (the input spec; `id` defaults to the
directory name) and an optional `files/` directory. Point `--inputs` at the
parent. A directory holds one suite shape: a single `inputs.json`, loose
one-input `.json` files, or test directories — never a mix.

Suites and fixtures can come from git. Anywhere a directory is accepted, a git
source works too:

```bash
agency eval run --agent a.agency --inputs 'github.com/you/evals//tests?ref=v1.2'
```

`//subdir` names a directory inside the repo; `?ref=` takes a branch, tag, or
commit sha (a local path with `?ref=` reads that repo's files as of the commit).
Whatever you wrote, `config.json` records the **resolved sha**, so any past run
is pinnable by copying its sha into `?ref=`. Clones cache under
`~/.agency/cache/git/`; branch refs re-fetch per run, shas never do. A suite
loaded from git may not point `files` at another git source (sources resolve
one level deep).

An agent that reads a project file that was never seeded gets a file-not-found
error inside the workdir; the run's `error.txt` lists what was seeded and which
fix applies.

Each run writes:

```text
runs/<run-id>/
  config.json           # resolved provenance: agent closure with file hashes,
                        #   inputs source (resolved sha when git), options
  summary.json          # counts + the latest grading block
  verifier/
    grading.json        # what the graders concluded; re-grades write
                        #   verifier-2/, verifier-3/ instead of overwriting
  inputs/<input-id>/
    input.json          # the resolved input spec
    agent/
      statelog.jsonl    # what the agent did
      eval-record.json  # the normalized trace
      error.txt         # only on error
    workdir/            # the isolated directory the agent ran in
```

`summary.json` contains the run id, agent label, input results, success/error counts, and — unless you passed `--no-grade` — a `grading` block with the objective and a per-input breakdown. `eval-record.json` is produced with the same extractor described below whenever the input produced a non-empty statelog.

## Scoring a run

`agency eval run` scores what it ran and prints an objective between 0 and 1:

```bash
agency eval run --agent agent.agency --inputs inputs.json
#   3/3 inputs ok
#   objective  0.71
#     goal  0.71
```

`agency eval grade <runDir>` re-scores a finished run without re-running
the agent — each input's recorded graders are read from the run directory,
so no flags are needed. `agency eval logs <runDir>` opens the run's
statelog in the interactive viewer (`--input <id>` picks one when the run
has several; an input directory or a statelog file also works). Press `t`
in the viewer for the timeline views — where the run's time went, call by
call and function by function (see the observability guide).

With no `--graders`, each test grades itself with the `graders` module it
carries; tests without one fall back to `eval.graders` from `agency.json`,
then to the bundled goal judge scoring against the input's `goal` field —
the same default `agency optimize` uses. Pass `--no-grade` to skip scoring
and only run the agent.

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

  // compare against the input's `expected` field
  new ExactMatch({ mustPass: true }),
];
```

The module can be a test's own (`"graders"` in its spec, or a `graders.ts`
beside its `test.json`), the suite-wide fallback (`eval.graders` in
`agency.json`), or a run-wide override (`--graders`):

```bash
agency eval run --agent agent.agency --inputs inputs.json --graders graders.ts
```

A grader function receives `{ output, input, workdir, record, judge }` and returns
a number from 0 to 1, a boolean, or a full `Grade`. Options control how it counts:
`mustPass` makes it a gate, `weight` sets its share of the objective, `threshold`
sets the passing bar for scalar scores, `samples` runs it k times, and
`inputScope` restricts it to a subset of inputs.

When a grading module is supplied, `goal` becomes optional on your inputs.

### Pass and fail

A `mustPass` grader is the assertion. If one fails, that input scores 0, the run
reports `gatesPassed: false`, and the command exits 2 — so a gate is what makes
`agency eval run` usable as a CI check. Every other grader is a measurement you
track over time.

An input whose agent run errored, or which produced no output, scores 0 and fails
every gate. It is counted, not skipped: one bad input out of fifty pulls the mean
down by its share rather than zeroing the whole run.

### Re-scoring a finished run

Grading is also a separate command, so you can iterate on a grader without
re-running the agent:

```bash
agency eval grade runs/abc --graders graders.ts
#   objective  0.71
```

It reads the run directory, scores it again, and writes the next `verifier-N/`
directory (`verifier/`, then `verifier-2/`, `verifier-3/`, …), so every grading
pass survives. `summary.json` is never rewritten. Use `-o` to write out of tree
instead.

This costs nothing and is deterministic for `ExactMatch`, `Contains`,
`Similarity`, and function graders that do not call `judge`. An `LlmJudge`, or a
function grader calling `judge(...)`, still makes a live LLM call each time — much
cheaper than re-running agents, and the outputs being judged stay fixed.

## Judging output by hand

Some questions have no automatic grader. Is this summary really about today? Do
these citations point at pages that exist? Is this explanation worth reading?
You find out by looking.

`agency label` is the tool for those questions. You write a checklist of
yes-or-no questions, then answer them one output at a time. Your answers are
stored, so you can turn them into training data later, or measure how well an
LLM judge agrees with you.

Labelling takes two steps. First you add records, then you judge them.

```bash
agency label ingest runs/abc --source agent-v1
agency label --checklist news.json
```

### Adding records

A record is one thing you judge. It holds named pieces of text, usually a `task`
and an `output`.

`ingest` reads four kinds of source:

| Source | Each record is |
|---|---|
| A run directory | one input's final output, together with its task |
| A directory of files | one whole file |
| A `.json` file holding an array of strings | one element of the array |
| A statelog `.jsonl` file | one chosen trace, named with `--trace` |

It guesses which kind you meant. Pass `--format run`, `--format files`,
`--format json`, or `--format statelog` when you want to say so yourself.

### Promoting a statelog trace

A statelog usually holds many traces, so you name the one(s) you want with a
repeatable `--trace <id>`:

```bash
agency label ingest run.jsonl --source agent-v1 --trace rpGXbww2gfHaZDLBL8Z2H
```

The trace's output is resolved by precedence: an `evalOutput()` value, else the
entry node's return value, else one of its `print`/`printJSON` values. When a
trace has several printed values and no recorded output, pick one with a keyed
`--output <trace-id>=print:<index>` (headless never guesses):

```bash
agency label ingest run.jsonl --source agent-v1 --trace T1 --output T1=print:2
```

Running `--trace` with an unknown id, or `--output` for a trace you did not
request, is an error that lists the available traces. A statelog with any
unparseable line fails the whole ingest — a dataset must never be built from a
partially read trace. (You can also do all of this interactively from the log
viewer's `l` key; see [Viewing logs](/cli/logs#labeling-a-trace-from-the-viewer).)

A directory holds one record per file. Add `--recursive` to descend into
subdirectories. There is no pattern matching, so point it at a directory that
holds what you want:

```bash
agency label ingest ./gold/ --source handwritten --task "Summarize today's tech news"
```

`--task` adds the same task field to every record in the batch. That is the
usual shape for handwritten answers, because you wrote them all against one
question.

`--source` names the batch. It is how you tell one agent's outputs from
another's when you read the labels back, so give each batch its own name.

Two agents that produce identical text produce **one** record with two
observations. You judge it once, and both agents get credit for that judgement.
This is what makes "did version 2 beat version 1" a question you can answer.

```bash
agency label ingest runs/v1 --source agent-v1
agency label ingest runs/v2 --source agent-v2
agency label ingest ./gold/ --source handwritten --task "Summarize today's tech news"
agency label --checklist news.json
```

Ingest reports what it skipped and why. It skips a failed run, an empty file,
and a run that produced no output. Storing a placeholder for those would be
worse than leaving a gap, because a placeholder can be labeled.

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

`weight` is optional and defaults to 1. A record's score is the weighted share
of questions you answered yes.

Do not agonize over the list. You add questions while labeling, and discovering
them halfway through is the normal way this goes, not a planning failure.

### One rule for questions

**Every question must be answerable from the record's fields alone.**

The record and your answer are the whole training example. An agent learning
from your labels sees those two things and nothing else. A question that depends
on anything outside the record produces a label about information the agent never
receives.

"Is every story from today?" breaks that rule when the output never says which
day it was written. The fix is to make the output say so, not to reword the
question. A code review is unjudgeable without the diff, so ingest the diff and
the review as two fields of one record.

Nothing checks this for you. It cannot: the tool has no way to know that "today"
is unanchored, or that a review refers to a diff that is missing.

### Labelling

`agency label --checklist news.json` opens the screen. One record fills the
left, the checklist fills the right.

| Key | What it does |
|---|---|
| `space` | answer the current question yes or no |
| `↑` `↓` | move between questions |
| `←` `→` | move between records |
| `enter` | sign off on this record and go to the next |
| `a` | add a question |
| `d` | remove a question, or bring one back |
| `m` | write a note |
| `q` | quit |

Signing off is deliberate. Your answers are not recorded until you press
`enter`, so moving through a record to read it changes nothing.

Quitting halfway is safe. The session is saved as you go, and reopening it puts
you back where you stopped.

### Where your answers go

Everything lives in one directory, `labels/` by default. Set another with
`--dataset`, or with `eval.dataset` in `agency.json` (`--store` /
`eval.labelStore` remain as deprecated aliases).

| File | Holds |
|---|---|
| `outputs.jsonl` | copies of the records you are judging |
| `labels.jsonl` | your answers |
| `occurrences.jsonl` | which source each record came from |
| `checklists/` | every version of your question list |

The store keeps **copies**, so you can delete `runs/` and your labels survive.

Each version of a checklist is kept. Editing a question does not rewrite
history, so a label made against an older version still says what it meant.

## Optimizing marked declarations

`agency eval optimize` (also `agency optimize`) rewrites the declarations you mark with the `optimize` modifier, grading candidates against your inputs and keeping the best one. It has its own page — see **[Optimizing agents](optimize.md)** for marking targets, custom graders, validation sets, configuration, and run artifacts.

## Extracting eval records

`extract` is **not** a tool for running the agent. It takes a `.statelog.jsonl` file you've already captured and turns it into a small, normalized JSON artifact — an **eval record** — that downstream tools can grade with an LLM judge, compare against another run, or pattern-match for behavioral assertions.

Why a separate format? The raw statelog is a chronological event stream optimized for the runtime to emit and the TUI viewer to render — long, redundant, and full of fields a grader doesn't care about. The eval record is the inverse: short, deduped, attribution-resolved, and stable enough to diff between two runs.

## Quick example

```bash
agency eval extract /tmp/run.statelog.jsonl
# Wrote eval record to /tmp/run.eval.json (42 events, 3 threads, 0 incomplete)
```

By default the record lands next to the input as `<basename>.eval.json` (stripping `.statelog.jsonl` or `.jsonl`). Use `-o` to override.

## Options

- `-o, --out <path>` — output JSON path. Defaults to `<file>.eval.json`.
- `--preview-chars <n>` — max characters retained for tool `argsPreview` / `outputPreview` fields. Default `200`. Pass `0` for full content (warning: can be very large).
- `--compact` — emit compact JSON instead of pretty-printed. Use this when feeding the record into a diff pipeline.

## Contract

The extractor output is deliberately **generic** — it knows nothing about specific subagent names (oracle, explorer, code, etc.) or project-specific rules. Semantic queries belong in the consumer; the extractor exposes the raw signal so consumers can write them.

The two semantic anchors the extractor does surface at the top level are:

- `evalValues` — chronological values recorded by `evalValue(value)`.
- `evalOutputs` — chronological values recorded by `evalOutput(value)`.

Both are hoisted because they're load-bearing for eval consumers and judges. Everything else — thread tree, per-event sequence, interrupts, errors, incomplete tool calls, aggregated metrics — lives in `events`, `threads`, `interrupts`, `errors`, `incomplete`, and `metrics`.

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

There is no guessing here. The last LLM completion is never used as a stand-in for a return value, because a plausible-looking chat reply is worse than an honest gap: it makes an agent that produced nothing look like it produced something. If the node returns nothing, or returns `null`, and `evalOutput()` was never called, the record has no output and says so in `warnings`. `agency eval extract` prints an error and exits non-zero.

Returning `null` counts as no output rather than as the value `null`. An unmatched `match` or a missing key normalizes to `null` in Agency, so grading the string `"null"` would silently score a program that produced nothing. If your node genuinely has no return value, call `evalOutput(value)` to say what should be graded.

`evalValues` is different: it is inferred from the last user-role message of the first top-level `promptCompletion`, and warns when it does so. That one is a genuine guess — annotate with `evalValue(prompt)` if you care about it.

## Record shape (overview)

```jsonc
{
  "traceId": "...",
  "recordVersion": 2,
  "formatVersion": 1,
  "durationMs": 12345,
  "source": "/path/to/run.statelog.jsonl",
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
- `truncated` is present only when the serialized value exceeded `STATELOG_EVAL_MAX_VALUE_BYTES`. The default cap is 100KB; set that environment variable before running `agency eval extract` to override it. Oversized string values are kept as readable string prefixes; oversized non-string values are converted to JSON-preview strings.

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

`evalValues` and `evalOutputs` are hoisted to the top level specifically because eval consumers and pairwise judges need the user-facing inputs and outputs without digging through raw `promptCompletion` events. `threads[*].label` is what consumer behavioral queries grep on. These are the two seams that connect `extract` to its sibling commands.

Next: use [`agency eval judge`](./eval-judge.md) to compare two eval records against a plain-English goal.

## Legacy traces

Statelog traces captured before the relevant runtime fields landed (thread labels/sessions, `toolCallStart`, interrupt summaries, per-event `threadId`) still extract without error — fields that aren't present in the source come through as `null` and a single warning is emitted in `record.warnings`. Don't rely on those fields when grading legacy traces; recapture if you can.
