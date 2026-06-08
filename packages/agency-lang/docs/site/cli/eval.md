---
title: Evaluating agent runs
description: Documents the `agency eval extract` command for converting a captured statelog trace into a structured eval record suitable for LLM judging, pairwise comparison, or programmatic behavioral checks.
---

# Evaluating agent runs

`agency eval` is the umbrella for tools that grade, compare, and analyze agent runs from their captured statelog traces. Today it has one subcommand:

```
agency eval extract <file>
```

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

- `userMessage` — the prompt the user typed (the last user-role message of the first `promptCompletion` on the top-level thread).
- `finalResponse` — the final reply the user saw (the `completion` of the last `promptCompletion` on the top-level thread).

Both are hoisted because they're load-bearing for the planned `agency eval compare` command (the LLM judge sees these two strings side-by-side across two runs). Everything else — thread tree, per-event sequence, interrupts, errors, incomplete tool calls, aggregated metrics — lives in `events`, `threads`, `interrupts`, `errors`, `incomplete`, and `metrics`.

## Record shape (overview)

```jsonc
{
  "traceId": "...",
  "recordVersion": 1,
  "formatVersion": 1,
  "durationMs": 12345,
  "source": "/path/to/run.statelog.jsonl",
  "userMessage": "what the user asked",
  "finalResponse": "what the agent replied",
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

`userMessage` and `finalResponse` are hoisted to the top level specifically because the planned `agency eval compare <a> <b>` will feed them to an LLM judge for pairwise quality comparison across two runs. `threads[*].label` is what consumer behavioral queries grep on. These are the two seams that connect `extract` to its (future) sibling commands.

## Legacy traces

Statelog traces captured before the relevant runtime fields landed (thread labels/sessions, `toolCallStart`, interrupt summaries, per-event `threadId`) still extract without error — fields that aren't present in the source come through as `null` and a single warning is emitted in `record.warnings`. Don't rely on those fields when grading legacy traces; recapture if you can.
