---
title: Evaluating agent runs
description: Documents the `agency eval extract` command for converting a captured statelog trace into a structured eval record suitable for LLM judging, pairwise comparison, or programmatic behavioral checks.
---

# Evaluating agent runs

`agency eval` is the umbrella for tools that run, grade, compare, and analyze agent runs from their captured statelog traces. The main subcommands are:

```
agency eval run --agent <file>[:<node>] (--inputs <file|dir> | --goal <text>)
agency eval optimize <file>[:<node>] [--inputs <file|dir>] [--goal <text>] [--graders <file>] [--validation-inputs <file|dir> | --validation-split <ratio>]
agency eval extract <file>
```

## Running an input suite

`agency eval run` executes an Agency agent against one or more eval inputs and writes a structured run directory:

```bash
agency eval run --agent agent.agency:evalMain --inputs inputs.json --run-id smoke
```

Input suites can be either a JSON file with `{ "inputs": [...] }` or a directory containing one `.json` file per input. An input has this shape:

```json
{
  "id": "fizzbuzz-write",
  "goal": "Should produce a typechecking fizzbuzz program.",
  "args": { "prompt": "Write fizzbuzz in Agency" },
  "node": "evalMain",
  "working_dir": "./fixtures/empty-project"
}
```

`goal` is required (for `eval run` and the default optimize judge; a custom grading module makes it optional — see [Custom graders](#custom-graders)). `args` defaults to `{}`. `id` defaults to a generated id and must be filesystem-safe when supplied. `expected` is an optional gold output (any JSON) read by match graders and surfaced to the optimizer's reflection. `working_dir` is copied into the input workdir before the subprocess runs, so each input can mutate its own isolated fixture copy.

For a single ad-hoc run, use `--goal` instead of `--inputs`:

```bash
agency eval run --agent agent.agency --goal "Answer with a concise summary"
```

Options:

- `--agent <file>[:<node>]` — required agent target. Directory targets resolve to `main.agency` inside the directory. The node defaults to `main`.
- `--inputs <file|dir>` — input suite file or directory. Mutually exclusive with `--goal`.
- `--goal <text>` — create one inline input with this goal. Mutually exclusive with `--inputs`.
- `--run-id <id>` — output run id. Defaults to a generated id.
- `--runs-dir <path>` — output root. Defaults to `eval.runsDir` in `agency.json`, or `runs/`.
- `--no-continue-on-error` — stop after the first input failure. By default, remaining inputs continue.

Each run writes:

```text
runs/<run-id>/
  config.json
  inputs/<input-id>/
    input.json
    statelog.jsonl
    eval-record.json
    workdir/
    error.txt
  summary.json
```

`summary.json` contains the run id, agent label, input results, and success/error counts. `eval-record.json` is produced with the same extractor described below whenever the input produced a non-empty statelog.

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

Without annotations, `extract` falls back to approximate trace-level heuristics: the last user-role message of the first top-level `promptCompletion` for `evalValues`, and the last top-level `promptCompletion` completion for `evalOutputs`. Falling back is supported for backwards compatibility, but the inference is approximate. Annotate your agent for trustworthy evals.

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

`evalValues` and `evalOutputs` are hoisted to the top level specifically because eval consumers and pairwise judges need the user-facing inputs and outputs without digging through raw `promptCompletion` events. `threads[*].label` is what consumer behavioral queries grep on. These are the two seams that connect `extract` to its sibling commands.

Next: use [`agency eval judge`](./eval-judge.md) to compare two eval records against a plain-English goal.

## Legacy traces

Statelog traces captured before the relevant runtime fields landed (thread labels/sessions, `toolCallStart`, interrupt summaries, per-event `threadId`) still extract without error — fields that aren't present in the source come through as `null` and a single warning is emitted in `record.warnings`. Don't rely on those fields when grading legacy traces; recapture if you can.
