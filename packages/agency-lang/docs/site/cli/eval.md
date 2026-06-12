---
title: Evaluating agent runs
description: Documents the `agency eval extract` command for converting a captured statelog trace into a structured eval record suitable for LLM judging, pairwise comparison, or programmatic behavioral checks.
---

# Evaluating agent runs

`agency eval` is the umbrella for tools that run, grade, compare, and analyze agent runs from their captured statelog traces. The main subcommands are:

```
agency eval run --agent <file>[:<node>] (--tasks <file|dir> | --goal <text>)
agency eval optimize --agent <file>[:<node>] --tasks <file|dir> --goal <text>
agency eval extract <file>
```

## Running a task suite

`agency eval run` executes an Agency agent against one or more eval tasks and writes a structured run directory:

```bash
agency eval run --agent agent.agency:evalMain --tasks tasks.json --run-id smoke
```

Task suites can be either a JSON file with `{ "tasks": [...] }` or a directory containing one `.json` file per task. A task has this shape:

```json
{
  "task_id": "fizzbuzz-write",
  "goal": "Should produce a typechecking fizzbuzz program.",
  "args": { "prompt": "Write fizzbuzz in Agency" },
  "node": "evalMain",
  "working_dir": "./fixtures/empty-project"
}
```

`goal` is required. `args` defaults to `{}`. `task_id` defaults to a generated id and must be filesystem-safe when supplied. `working_dir` is copied into the task workdir before the subprocess runs, so each task can mutate its own isolated fixture copy.

For a single ad-hoc run, use `--goal` instead of `--tasks`:

```bash
agency eval run --agent agent.agency --goal "Answer with a concise summary"
```

Options:

- `--agent <file>[:<node>]` — required agent target. Directory targets resolve to `main.agency` inside the directory. The node defaults to `main`.
- `--tasks <file|dir>` — task suite file or directory. Mutually exclusive with `--goal`.
- `--goal <text>` — create one inline task with this goal. Mutually exclusive with `--tasks`.
- `--run-id <id>` — output run id. Defaults to a generated id.
- `--runs-dir <path>` — output root. Defaults to `eval.runsDir` in `agency.json`, or `runs/`.
- `--no-continue-on-error` — stop after the first task failure. By default, remaining tasks continue.

Each run writes:

```text
runs/<run-id>/
  config.json
  tasks/<task-id>/
    task.json
    statelog.jsonl
    eval-record.json
    workdir/
    error.txt
  summary.json
```

`summary.json` contains the run id, agent label, task results, and success/error counts. `eval-record.json` is produced with the same extractor described below whenever the task produced a non-empty statelog.

## Optimizing marked declarations

`agency eval optimize` runs an eval-driven optimization loop over declarations marked with the `optimize` modifier. Target discovery starts at the agent file and follows local relative `.agency` imports, then the optimizer evaluates the baseline, proposes declaration mutations, evaluates each candidate against the task suite, and accepts candidates that beat the current champion by the configured win/loss margin.

```bash
agency eval optimize \
  --agent agent.agency:main \
  --tasks tasks.json \
  --goal "Improve factual accuracy without adding verbosity" \
  --iterations 5
```

Mark each string declaration the optimizer may change:

```agency
optimize const systemPrompt = "Answer accurately."

node main(question: string): string {
  optimize const prompt = "Answer accurately: ${question}"
  const answer: string = llm(prompt)
  return answer
}
```

Legacy `@optimize(...)` tags are no longer supported. Use `optimize const` or `optimize let` on the declaration itself.

Options:

- `--agent <file>[:<node>]` — required agent target. Directory targets resolve to `main.agency` inside the directory. The node defaults to `main`.
- `--tasks <file|dir>` — required task suite file or directory. Unlike `eval run`, optimizer tasks must come from a suite; `--goal` is reserved for the optimization objective.
- `--goal <text>` — required plain-English objective used by the prompt mutator.
- `--iterations <n>` — maximum candidate iterations after the baseline. Defaults to `5`.
- `--judge-samples <n>` — pairwise judge samples per task. Defaults to `3`.
- `--accept-threshold <n>` — accept when confident candidate wins minus losses is greater than this value. Defaults to `0`.
- `--mutator-model <model>` — optional model override for proposing prompt mutations.
- `--run-id <id>` — output run id. Defaults to a generated id.
- `--runs-dir <path>` — optimizer output root. Defaults to `eval.optimizeRunsDir` in `agency.json`, or `eval.runsDir/optimize`, or `runs/optimize`.

Only task-level verdicts with aggregated confidence at least `50` count toward the win/loss margin. Pairwise judge confidence is an integer from `0` to `100`.

Each optimize run writes:

```text
runs/optimize/<run-id>/
  config.json
  targets.json
  iter-0/
    agent/<agent-filename>
    workspace/
    eval-run/<run-id>/summary.json
  iter-1/
    agent/<agent-filename>
    mutation.md
    verdict.json
    workspace/
    eval-run/<run-id>/summary.json
  champion/
    agent/<agent-filename>
    championIter
  summary.json
```

The CLI installs an approval handler for the internal `std::agency.run(...)` calls used by eval execution. The stdlib `agency.eval.optimize(...)` function does not install a handler; Agency callers should wrap it in their own handler when they want auto-approval.

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

- `evalInputs` — chronological values recorded by `evalInput(value)`.
- `evalOutputs` — chronological values recorded by `evalOutput(value)`.

Both are hoisted because they're load-bearing for eval consumers and judges. Everything else — thread tree, per-event sequence, interrupts, errors, incomplete tool calls, aggregated metrics — lives in `events`, `threads`, `interrupts`, `errors`, `incomplete`, and `metrics`.

## How to annotate a run

Import `std::statelog` and call `evalInput` / `evalOutput` where values cross the user-facing boundary:

```ts
import { evalInput, evalOutput } from "std::statelog"

node main(prompt: string): string {
  evalInput(prompt)
  const reply = doWork(prompt)
  evalOutput(reply)
  return reply
}
```

Without annotations, `extract` falls back to approximate trace-level heuristics: the last user-role message of the first top-level `promptCompletion` for `evalInputs`, and the last top-level `promptCompletion` completion for `evalOutputs`. Falling back is supported for backwards compatibility, but the inference is approximate. Annotate your agent for trustworthy evals.

## Record shape (overview)

```jsonc
{
  "traceId": "...",
  "recordVersion": 2,
  "formatVersion": 1,
  "durationMs": 12345,
  "source": "/path/to/run.statelog.jsonl",
  "evalInputs": [{ "value": "what the user asked", "threadId": "0", "tMs": 120 }],
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

Every entry in `evalInputs` and `evalOutputs` has this shape:

```jsonc
{ "value": unknown, "threadId": "0", "tMs": 420, "truncated": true }
```

- `value` is the JSON-serializable value passed to `evalInput` / `evalOutput`, or a heuristic fallback value when annotations are missing.
- `threadId` identifies the active thread that recorded the value, or `null` when unavailable.
- `tMs` is milliseconds from the trace start, derived from the statelog envelope timestamp.
- `truncated` is present only when the serialized value exceeded `STATELOG_EVAL_MAX_VALUE_BYTES`. The default cap is 100KB; set that environment variable before running `agency eval extract` to override it. Oversized string values are kept as readable string prefixes; oversized non-string values are converted to JSON-preview strings.

Consumers that need one response typically read `record.evalOutputs.at(-1)?.value`. A pairwise judge compares the last element of `evalOutputs`; without annotations, that value may be the last LLM completion rather than what the user actually saw.

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

`evalInputs` and `evalOutputs` are hoisted to the top level specifically because eval consumers and pairwise judges need the user-facing inputs and outputs without digging through raw `promptCompletion` events. `threads[*].label` is what consumer behavioral queries grep on. These are the two seams that connect `extract` to its sibling commands.

Next: use [`agency eval judge`](./eval-judge.md) to compare two eval records against a plain-English goal.

## Legacy traces

Statelog traces captured before the relevant runtime fields landed (thread labels/sessions, `toolCallStart`, interrupt summaries, per-event `threadId`) still extract without error — fields that aren't present in the source come through as `null` and a single warning is emitted in `record.warnings`. Don't rely on those fields when grading legacy traces; recapture if you can.
