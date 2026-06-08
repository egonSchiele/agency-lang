# `agency eval extract` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new top-level `agency eval` CLI command with one subcommand, `extract`, that reads a `.statelog.jsonl` file from one agent run and produces a structured **eval record** (JSON) suitable for grading by an LLM judge, pairwise comparison across agent versions, or programmatic behavioral checks.

**Non-goals:** Running tasks against an agent, scoring an eval record, comparing two records. Those are separate downstream commands (`eval run`, `eval judge`, `eval compare`) and are out of scope for this plan.

**Architecture:** Pure-function pipeline. A small `lib/eval/` module reads statelog events, builds a span/thread index, and emits a normalized chronological event list plus aggregations. `lib/cli/evalExtract.ts` is the I/O wrapper. The eval record is deliberately **generic** — it does not bake in any Agency-agent-specific subagent names (oracle/explorer/code/etc.). Semantic identification happens downstream from the thread `label` and `session` fields, which the runtime records on `threadCreated` events (commit `d1d95671`: thread label/session, `toolCallStart`, `interrupt: {kind, message, data}` on handlerDecision/interruptResolved).

**Tech Stack:** TypeScript, Commander CLI, vitest.

**Prerequisites:**

1. **Already landed (commit `d1d95671`):** statelog logs thread `label`/`session` on `threadCreated`, emits `toolCallStart` events alongside `toolCall`, and carries the `interrupt: {kind, message, data}` summary on `handlerDecision` and `interruptResolved`.
2. **Must land before Task 4 (this plan, Task 0):** add an explicit `threadId` field to the `data` payload of `promptCompletion`, `toolCall`, and `toolCallStart` events at emit time. Without this, normalized events cannot be reliably attributed to a thread (the span tree does not link an LLM call back to its owning `threadCreated`, and there is no `threadEnded` event to anchor a fallback active-thread stack).

The captured `statelog.log` at the repo root **predates both** changes above — it has no `label`/`session`, no `toolCallStart`, no `interrupt` summary, and no `threadId` on tool/LLM events. The plan treats that log as a **legacy fixture** (used to check graceful degradation), and assumes fresh captures (Task 8) for fields that depend on the prerequisites.

---

## File Structure

### New files

```
lib/statelog/wireTypes.ts            # Shared EventEnvelope / EventData (moved out of logsViewer)
lib/statelog/wireAccessors.ts        # Thin accessor layer for wire-format fields
                                     # (tokensIn, tokensOut, cost, threadIdOf, toolNameOf,
                                     #  userMessageOf, completionOf, timestampMs, byType, ...)
lib/eval/types.ts                    # EvalRecord type + sub-types
lib/eval/normalize.ts                # Raw envelopes → RawNormalizedEvent[] (one pass)
lib/eval/extract.ts                  # Pure: events[] → EvalRecord, composed over normalize.ts
lib/eval/extract.test.ts             # Unit tests over hand-crafted event arrays
lib/eval/parseJsonl.ts               # Streaming JSONL → EventEnvelope[]
lib/eval/parseJsonl.test.ts
lib/cli/evalExtract.ts               # CLI wrapper: read file, call extract, write output
lib/eval/fixtures/                   # Integration-test fixtures (real captured statelogs)
  <name>.statelog.jsonl              # Fresh capture (post-Task 0)
  <name>.expected.json               # Expected EvalRecord output
  legacy.statelog.jsonl              # Pre-prereq trace for graceful-degradation test
docs/site/cli/eval.md                # User-facing CLI doc
```

### Modified files

```
lib/logsViewer/types.ts              # Re-export EventEnvelope/EventData from lib/statelog/wireTypes
                                     # (or update all logsViewer imports to the new location)
scripts/agency.ts                    # Register new `eval` top-level command + `extract` subcommand
```

**Note on `EventEnvelope` placement.** Today `EventEnvelope` / `EventData` live in `lib/logsViewer/types.ts`. The eval module is a peer of the viewer, not a dependent — both consume the wire format. Move the envelope/data types into a shared `lib/statelog/wireTypes.ts` and update both consumers. Do this as part of Task 2 (before the JSONL parser imports anything).

---

## Task 0: Runtime prereq — emit `threadId` on tool/LLM events

**Files:**
- Modify: `lib/statelogClient.ts` — extend the `promptCompletion`, `toolCall`, `toolCallStart` event method signatures (and their TypeScript types) to accept a `threadId: string | null`.
- Modify: `lib/runtime/prompt.ts` — pass the current thread id when calling `statelogClient.promptCompletion(...)`.
- Modify: `lib/runtime/runner.ts` (and any other site emitting `toolCall` / `toolCallStart`) — pass the current thread id.

**Why:** the span tree does not link a `promptCompletion` back to its owning `threadCreated` (verified against the captured `statelog.log`: `threadCreated.parent_span_id === null`, and `promptCompletion`'s parent chain does not pass through a thread span). There is also no `threadEnded` event, so an "active-thread stack" fallback cannot be popped reliably. The cheapest, most explicit fix is to stamp the active thread id directly onto each event at emit time.

- [ ] **Step 1: Locate the active thread id at each emit site.** In `lib/runtime/`, the thread context is available via the runtime ctx / thread store. Use the same accessor the existing thread-related logging uses (`ctx.currentThread().id` or equivalent — verify against `lib/runtime/state/threadStore.ts`).

- [ ] **Step 2: Extend `lib/statelogClient.ts` method signatures** to take `threadId` and include it in the emitted `data` payload. Keep backwards-compatible parse-side handling: consumers must treat the field as `string | null` because legacy traces won't have it.

- [ ] **Step 3: Update runtime call sites** (`prompt.ts`, `runner.ts`, anywhere else `toolCall` / `toolCallStart` / `promptCompletion` is emitted) to pass `threadId`.

- [ ] **Step 4: Update tests in `lib/runtime/__tests__/testHelpers.ts`** to accept the new field on the mock spies (the no-op stubs already accept anything; just confirm types compile).

- [ ] **Step 5: Capture a fresh statelog** (small agent run) and `jq` to confirm `threadId` appears on `promptCompletion`, `toolCall`, and `toolCallStart` events.

This task is a hard prerequisite of Task 4 — without it, `NormalizedEvent.threadId` is always `null` and the headline use case ("did the oracle subagent run?") collapses.

---

## Task 1: Define the `EvalRecord` type

**Files:**
- Create: `lib/eval/types.ts`

The shape must be:
- **Generic** — no Agency-agent-specific labels baked in.
- **Tool-call-sequence-centric** — the central structure is a chronological event list; everything else derives from it.
- **Span-traceable** — every event carries `span_id` so consumers can rebuild the tree.

- [ ] **Step 1: Write `lib/eval/types.ts`**

```typescript
/** A normalized eval record produced from one statelog trace.
 *
 * Deliberately project-agnostic: nothing in this shape knows about
 * specific subagent names (oracle/explorer/code/etc.). Consumers who
 * want semantic identification ("did the oracle fire?") query the
 * thread `label` / `session` fields populated by the runtime.
 */
export type EvalRecord = {
  /** trace_id from the source statelog. */
  traceId: string;
  /** Format version of the EvalRecord shape itself (NOT the statelog
   *  format_version). Bump when fields change incompatibly. */
  recordVersion: 1;
  /** Statelog wire-format version, copied from the source envelope
   *  (`events[0].format_version`). Lets consumers reason about which
   *  optional fields they can expect (label, threadId, etc.). */
  formatVersion: number;
  /** Total wall-clock duration in milliseconds, derived from the
   *  first event's timestamp to the last event's timestamp. */
  durationMs: number;
  /** Source file path, for traceability. Always a real path — stdin
   *  input is not supported. */
  source: string;

  /** The user's prompt that drove this run — the user-role message
   *  from the first chronologically-ordered `promptCompletion` on
   *  the top-level thread. Hoisted to the top level because both
   *  the LLM judge and any diff tool need it, and digging it out of
   *  `events[*].messages` is awkward. Null if the trace has no
   *  `promptCompletion` events. */
  userMessage: string | null;

  /** The final assistant-facing reply the user saw — the
   *  `completion` from the LAST `promptCompletion` on the top-level
   *  thread. This is what `eval compare` shows to an LLM judge.
   *  Null if no `promptCompletion` events were captured. */
  finalResponse: string | null;

  /** Every thread observed in the trace. Each `threadCreated` event
   *  becomes one entry. Resumes (`threadResumed`) do NOT create new
   *  entries — they map back to the existing thread by id. */
  threads: ThreadEntry[];

  /** Chronological list of normalized events. The single source of
   *  truth — everything else in this record is a derived aggregation
   *  over this list. */
  events: NormalizedEvent[];

  /** Interrupts that surfaced during the run, with their resolution
   *  outcome. Built from `interruptThrown` / `handlerDecision` /
   *  `interruptResolved` events. Carries the kind/message/data so
   *  consumers can see what was approved/rejected without
   *  correlating manually. */
  interrupts: InterruptEntry[];

  /** Errors raised during the run. */
  errors: ErrorEntry[];

  /** Tool invocations that started (`toolCallStart`) but never
   *  emitted a matching `toolCall` end event. Almost always means
   *  the run was killed or aborted mid-tool. */
  incomplete: IncompleteInvocation[];

  /** Coarse-grained aggregations for quick scanning. NOT meant to be
   *  authoritative — anything load-bearing should be re-derived from
   *  `events` by the consumer. */
  metrics: Metrics;

  /** Warnings the extractor emitted while processing this trace
   *  (e.g. unknown event types, missing fields, suspicious shapes). */
  warnings: string[];
};

export type ThreadEntry = {
  threadId: string;
  threadType: "thread" | "subthread";
  parentThreadId: string | null;
  /** From `thread(label: "...")`. The most useful semantic tag. */
  label: string | null;
  /** From `thread(session: "...")`. Only populated on first create
   *  of a session; resumes don't re-emit. */
  session: string | null;
  hidden: boolean;
  /** Milliseconds since trace start (NOT epoch). */
  createdAtMs: number;
};

/** One step in the chronological tool-call / LLM-call sequence. */
export type NormalizedEvent =
  | {
      kind: "llm";
      tMs: number;
      threadId: string | null;
      spanId: string;
      parentSpanId: string | null;
      model: string;
      /** Tool names available to this LLM call. Useful for
       *  fingerprinting an agent when thread labels are absent. */
      tools: string[];
      durationMs: number | null;
      costUsd: number | null;
      tokensIn: number | null;
      tokensOut: number | null;
    }
  | {
      kind: "tool_start";
      tMs: number;
      threadId: string | null;
      spanId: string;
      parentSpanId: string | null;
      /** Sourced from `toolCallStart.data.toolName`. */
      tool: string;
      argsPreview: string;
      model: string | null;
    }
  | {
      kind: "tool_end";
      tMs: number;
      threadId: string | null;
      spanId: string;
      parentSpanId: string | null;
      /** Sourced from `toolCall.data.toolName`. */
      tool: string;
      outputPreview: string;
      durationMs: number | null;
    };

export type InterruptEntry = {
  interruptId: string;
  /** From the interrupt summary attached to handlerDecision /
   *  interruptResolved by the runtime. Null on older traces. */
  kind: string | null;
  message: string | null;
  /** Full data payload as it was on the interrupt object. May be
   *  large — consumers should preview, not log verbatim. */
  data: unknown;
  outcome: "approved" | "rejected" | "propagated" | "unresolved";
  resolvedBy: "handler" | "user" | "policy" | "ipc" | null;
  thrownAtMs: number | null;
  resolvedAtMs: number | null;
};

export type ErrorEntry = {
  tMs: number;
  errorType: string;
  message: string;
  spanId: string | null;
};

export type IncompleteInvocation = {
  tool: string;
  startedAtMs: number;
  spanId: string;
  /** The thread that called the tool, if resolvable. */
  threadId: string | null;
};

export type Metrics = {
  llmCalls: number;
  toolStarts: number;
  toolEnds: number;
  /** Distinct model strings observed, deduped and sorted ascending
   *  for diff-friendly snapshots. */
  models: string[];
  /** Sum of input tokens across all `promptCompletion` events,
   *  reading `data.usage.input_tokens` (zero if absent). */
  tokensInTotal: number;
  /** Sum of `data.usage.output_tokens` across all promptCompletion
   *  events (zero if absent). */
  tokensOutTotal: number;
  /** Sum of `data.cost` across all promptCompletion events. Treated
   *  as USD — `lib/runtime/prompt.ts` records cost in dollars. */
  costUsdTotal: number;
  /** Count of tool END events (`toolCall`) per tool name. Does NOT
   *  count incomplete `toolCallStart`s — those live in `incomplete`. */
  toolCounts: Record<string, number>;
};
```

**Cost / token mapping note.** The exact `usage` field names depend on the upstream provider library. Before implementing, confirm the shape by running:

```bash
jq -c 'select(.data.type=="promptCompletion") | .data.usage' statelog.log | head -5
```

If the keys are different (`prompt_tokens` / `completion_tokens`, etc.), update the doc comments and the extractor accordingly. Pick the field names ONCE and pin them with a constant so the metric stays consistent with `logs summary`.

- [ ] **Step 2: Field-presence matrix**

Run `jq` against both the legacy log and a fresh capture (post-Task 0) to record which fields are present where. Commit the resulting matrix as a comment block at the top of `lib/eval/types.ts`. Expected matrix:

| field                                      | legacy `statelog.log` | post-Task 0 fresh capture |
| ------------------------------------------ | --------------------- | ------------------------- |
| `threadCreated.label`                      | ✗                     | ✓                         |
| `threadCreated.session`                    | ✗                     | ✓                         |
| `threadCreated.hidden`                     | ✗                     | ✓                         |
| `toolCallStart` event type                 | ✗                     | ✓                         |
| `handlerDecision.interrupt`                | ✗                     | ✓                         |
| `interruptResolved.interrupt`              | ✗                     | ✓                         |
| `promptCompletion.threadId`                | ✗                     | ✓                         |
| `toolCall.threadId`                        | ✗                     | ✓                         |
| `toolCallStart.threadId`                   | ✗                     | ✓                         |

Use:

```bash
jq -c 'select(.data.type=="threadCreated") | .data | keys' statelog.log | sort -u
jq -c 'select(.data.type=="promptCompletion") | .data | keys' statelog.log | sort -u
jq -c 'select(.data.type=="toolCall") | .data | keys' statelog.log | sort -u
jq -c 'select(.data.type=="toolCallStart") | .data | keys' statelog.log | sort -u  # legacy: prints nothing
```

The legacy log is the **graceful-degradation fixture**: assertions over it must NOT require any of the ✗ fields. Fresh captures are the **happy-path fixture**: assertions can require all ✓ fields.

---

## Task 2: Shared wire types + streaming JSONL parser

**Files:**
- Create: `lib/statelog/wireTypes.ts`
- Modify: `lib/logsViewer/types.ts` (re-export from new location, or migrate imports)
- Create: `lib/eval/parseJsonl.ts`
- Create: `lib/eval/parseJsonl.test.ts`

We *could* reuse `lib/logsViewer/parse.ts`, but that module pulls in tree-building / event-shape assumptions specific to the viewer. The extract pipeline only needs a thin line-by-line JSONL → `EventEnvelope[]` parse. Reusing would couple the eval module to viewer internals.

- [ ] **Step 1: Move wire types to a shared module**

Move `EventEnvelope` and `EventData` from `lib/logsViewer/types.ts` into a new `lib/statelog/wireTypes.ts`. Either re-export them from the old location (cheapest, zero churn) or update every `logsViewer` consumer to import from the new location. Both `lib/eval/` and `lib/logsViewer/` then depend on the shared types.

- [ ] **Step 2: Write the parser**

```typescript
// lib/eval/parseJsonl.ts
import * as fs from "fs";
import * as readline from "readline";

import type { EventEnvelope } from "../statelog/wireTypes.js";

/** Read a `.statelog.jsonl` file line by line and yield each event.
 *  Skips blank lines. Throws on the first malformed JSON line — the
 *  CLI wrapper catches and reports the line number. Streaming so
 *  large traces don't load the whole file into memory.
 *
 *  Stdin is intentionally NOT supported: every realistic use case
 *  is "I have a captured trace on disk and want to extract it".
 *  Skipping stdin keeps the contract simple and the `source` field
 *  on the record always a real path. */
export async function* readEvents(file: string): AsyncIterable<EventEnvelope> {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    const line = raw.trim();
    if (line === "") continue;
    try {
      yield JSON.parse(line) as EventEnvelope;
    } catch (err) {
      throw new Error(`Malformed JSON on line ${lineNo}: ${(err as Error).message}`);
    }
  }
}

/** Convenience wrapper that materializes the whole stream. Most
 *  use cases need random access (span lookups, ordering), so we
 *  pay the memory cost. Streaming is preserved at the I/O boundary. */
export async function readAllEvents(file: string): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  for await (const ev of readEvents(file)) out.push(ev);
  return out;
}
```

- [ ] **Step 3: Write tests** covering: empty file, blank lines, malformed JSON line number, single event, many events. (No stdin tests — stdin is unsupported.)

---

## Task 2.5: Wire-format accessor layer

**Files:**
- Create: `lib/statelog/wireAccessors.ts`
- Create: `lib/statelog/wireAccessors.test.ts`

**Why:** every place we read `data.threadId`, `data.toolName`, `data.usage.input_tokens`, `data.cost`, `data.completion`, `data.messages`, `data.timestamp` is a leak of the wire format into the extractor. If the runtime renames `usage.input_tokens` → `usage.promptTokens` (provider libraries do this constantly), we don't want to chase the rename through six call sites. Confine wire-format knowledge to one named boundary.

- [ ] **Step 1: Write the accessor module**

```typescript
// lib/statelog/wireAccessors.ts
import type { EventEnvelope } from "./wireTypes.js";

/** Group events by their `data.type`. One pass; produces a plain
 *  object (per AGENTS.md: prefer objects over Maps). */
export function groupByType(
  events: EventEnvelope[],
): Record<string, EventEnvelope[]> {
  const out: Record<string, EventEnvelope[]> = {};
  for (const ev of events) {
    const k = ev.data.type;
    (out[k] ??= []).push(ev);
  }
  return out;
}

/** Convenience: filter to one event type. Prefer `groupByType` when
 *  you need multiple types in one pass. */
export function byType(events: EventEnvelope[], type: string): EventEnvelope[] {
  return events.filter(e => e.data.type === type);
}

/** Epoch milliseconds for an event's timestamp. Null-safe. */
export function timestampMs(ev: EventEnvelope): number {
  return new Date(ev.data.timestamp).getTime();
}

/** Thread id stamped on a promptCompletion / toolCall / toolCallStart
 *  by Task 0. Null for legacy traces (pre-prereq). */
export function threadIdOf(ev: EventEnvelope): string | null {
  const v = ev.data.threadId;
  return typeof v === "string" ? v : null;
}

/** Tool name on a toolCall / toolCallStart. */
export function toolNameOf(ev: EventEnvelope): string {
  return String(ev.data.toolName ?? "");
}

/** Input-token count from a promptCompletion's `data.usage`. Returns
 *  0 if absent. The key name (`input_tokens` vs `prompt_tokens` vs
 *  `inputTokens`) is locked here — confirm against a fresh capture
 *  in Task 1 Step 2 and update this one site if needed. */
export function tokensIn(ev: EventEnvelope): number {
  return Number(ev.data.usage?.input_tokens ?? 0);
}

export function tokensOut(ev: EventEnvelope): number {
  return Number(ev.data.usage?.output_tokens ?? 0);
}

/** USD cost on a promptCompletion. */
export function cost(ev: EventEnvelope): number {
  return Number(ev.data.cost ?? 0);
}

/** Model name on a promptCompletion. */
export function modelOf(ev: EventEnvelope): string {
  return String(ev.data.model ?? "");
}

/** Tools array advertised to the LLM on a promptCompletion. */
export function toolsOf(ev: EventEnvelope): string[] {
  const t = ev.data.tools;
  return Array.isArray(t) ? t.map((x: any) => String(x?.name ?? x)) : [];
}

/** Last user-role message content from a promptCompletion's
 *  `data.messages` array. Returns null if no user message exists. */
export function userMessageOf(promptCompletion: EventEnvelope): string | null {
  const msgs = promptCompletion.data.messages;
  if (!Array.isArray(msgs)) return null;
  const userMsgs = msgs.filter((m: any) => m?.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  return typeof last?.content === "string" ? last.content : null;
}

/** Assistant's reply text on a promptCompletion. Returns null when
 *  the completion is empty or absent. */
export function completionOf(promptCompletion: EventEnvelope): string | null {
  const c = promptCompletion.data.completion;
  return typeof c === "string" && c.length > 0 ? c : null;
}
```

- [ ] **Step 2: Tests** — round-trip each accessor over a handful of synthetic events, including the empty/missing-field cases. Every helper in later tasks reads through this module; the accessors themselves are the only place in the codebase that knows the wire-format key names.

**Rule for all later tasks:** no helper in `lib/eval/` may read `ev.data.foo` directly. Add an accessor first, then use it. Enforce in code review.

---

## Task 3: Normalize pass — envelopes → RawNormalizedEvent[]

**Files:**
- Create: `lib/eval/normalize.ts`
- Create: `lib/eval/normalize.test.ts`

**Why:** every helper that follows needs (a) timestamps relative to `t0`, (b) the active thread id, (c) a discriminated event kind. Computing those repeatedly across helpers leaks timing/thread concerns. Do it ONCE here, then helpers consume a clean intermediate form. The span/thread *index* builders go here too — they're pure data on the normalized stream.

- [ ] **Step 1: Define the intermediate shape**

```typescript
// lib/eval/normalize.ts
import type { EventEnvelope } from "../statelog/wireTypes.js";

/** Same envelope, with derived fields hoisted onto it so downstream
 *  helpers never re-read raw wire fields. */
export type NormalizedEnvelope = {
  /** Original envelope, preserved verbatim for downstream code that
   *  needs a field this layer didn't bother to hoist (rare). */
  raw: EventEnvelope;
  /** ms relative to the first event's timestamp. */
  tMs: number;
  /** Resolved thread id (from `data.threadId` if present, else null). */
  threadId: string | null;
  /** `ev.data.type` hoisted for terser switch/filter. */
  type: string;
  /** `ev.span_id` hoisted. */
  spanId: string | null;
  /** `ev.parent_span_id` hoisted. */
  parentSpanId: string | null;
};

export type Normalized = {
  events: NormalizedEnvelope[];
  /** span_id → normalized envelope, for parent_span_id lookups. */
  spanIndex: Record<string, NormalizedEnvelope>;
  /** Events grouped by `type` (one pass; reused by every helper). */
  byType: Record<string, NormalizedEnvelope[]>;
  /** Warnings produced during normalization (e.g. "no threadId on
   *  tool/LLM events — likely a pre-prereq trace"). */
  warnings: string[];
};

export function normalize(events: EventEnvelope[]): Normalized {
  if (events.length === 0) {
    return { events: [], spanIndex: {}, byType: {}, warnings: [] };
  }
  const t0 = timestampMs(events[0]);
  const normalized = events.map(raw => ({
    raw,
    tMs: timestampMs(raw) - t0,
    threadId: threadIdOf(raw),
    type: raw.data.type,
    spanId: raw.span_id,
    parentSpanId: raw.parent_span_id,
  }));
  const spanIndex: Record<string, NormalizedEnvelope> = {};
  for (const ev of normalized) {
    if (ev.spanId !== null) spanIndex[ev.spanId] = ev;
  }
  const byType: Record<string, NormalizedEnvelope[]> = {};
  for (const ev of normalized) {
    (byType[ev.type] ??= []).push(ev);
  }
  const warnings: string[] = [];
  const hasToolOrLlm = (byType.promptCompletion?.length ?? 0)
    + (byType.toolCall?.length ?? 0)
    + (byType.toolCallStart?.length ?? 0) > 0;
  const anyThreadId = normalized.some(e =>
    (e.type === "promptCompletion" || e.type === "toolCall" || e.type === "toolCallStart")
      && e.threadId !== null);
  if (hasToolOrLlm && !anyThreadId) {
    warnings.push(
      "no threadId field on tool/LLM events — likely a pre-prereq trace; " +
        "thread attribution will be null for all normalized events",
    );
  }
  return { events: normalized, spanIndex, byType, warnings };
}
```

`timestampMs` / `threadIdOf` come from `lib/statelog/wireAccessors.ts`.

- [ ] **Step 2: Thread entries**

Threads are the one piece of derived state that doesn't fit cleanly into the per-event shape above. Build them as a separate declarative pass over `byType.threadCreated`:

```typescript
import type { ThreadEntry } from "./types.js";

export function extractThreads(n: Normalized): ThreadEntry[] {
  const created = n.byType.threadCreated ?? [];
  return created.map(ev => ({
    threadId: String(ev.raw.data.threadId),
    threadType: ev.raw.data.threadType ?? "thread",
    parentThreadId: ev.raw.data.parentThreadId ?? null,
    label: ev.raw.data.label ?? null,
    session: ev.raw.data.session ?? null,
    hidden: Boolean(ev.raw.data.hidden),
    createdAtMs: ev.tMs,
  }));
}
```

(The `ev.raw.data.*` accesses here are the one place threads-specific wire fields live — add accessors for them in Task 2.5 if more than one helper ends up reading them.)

`threadResumed` events do NOT create entries.

---

## Task 4: Pure extractor — events[] → EvalRecord

**Files:**
- Create: `lib/eval/extract.ts`
- Create: `lib/eval/extract.test.ts`

This is the heart of the plan. Keep it a single pure function (`extractEvalRecord(events, source)`) composed of small named helpers. No I/O.

- [ ] **Step 1: Write the test file first** (TDD per CLAUDE.md skills). Hand-craft three event arrays as fixtures:

```typescript
// A: trivial — one threadCreated, one promptCompletion, one toolCall pair
// B: incomplete — toolCallStart with no matching toolCall (killed mid-tool)
// C: nested — main thread calls a subagent, subagent calls a tool
```

For each, assert against the resulting `EvalRecord`:
- A: `threads.length === 1`, `events.length === 3`, `metrics.toolEnds === 1`, `incomplete.length === 0`.
- B: `incomplete.length === 1`, `incomplete[0].tool === "..."`, warnings empty.
- C: thread `parentThreadId` set; tool_end events' `threadId` resolves to the subagent thread.

- [ ] **Step 2: Implement the extractor**

Outline. Note: every helper is pure, returns its warnings in its result tuple (no shared mutable `warnings: string[]`), and operates over the `Normalized` form built in Task 3 — not raw envelopes. No helper reads `ev.data.foo` directly; everything goes through `wireAccessors.ts`.

```typescript
import type { EventEnvelope } from "../statelog/wireTypes.js";
import type { EvalRecord } from "./types.js";
import { normalize, extractThreads } from "./normalize.js";

export type ExtractOptions = {
  previewChars?: number;
};

type WithWarnings<T> = { result: T; warnings: string[] };

export function extractEvalRecord(
  events: EventEnvelope[],
  source: string,
  opts: ExtractOptions = {},
): EvalRecord {
  // Empty input is almost always a mistake — surface it rather than
  // silently producing a hollow record. (See "useless special cases"
  // in docs/dev/anti-patterns.md: there's no clean "empty record"
  // shape that's distinguishable from a real bug.)
  if (events.length === 0) {
    throw new Error("extract: no events in input");
  }

  // Declarative multi-trace check. One pass over `trace_id`, dedupe
  // via Set (used as a one-shot collection, not a stored data
  // structure — per AGENTS.md), throw if more than one trace_id is
  // present.
  const traceIds = [...new Set(events.map(e => e.trace_id))];
  if (traceIds.length > 1) {
    throw new Error(
      `extract: multiple trace_ids in input (${traceIds.join(", ")}). ` +
        `Exactly one trace per file is supported.`,
    );
  }
  const [traceId] = traceIds;

  const n = normalize(events);
  const threads = extractThreads(n);

  // Each derivation is a pure function over the Normalized form,
  // returning its own warnings. No shared mutable state between
  // helpers, no t0 threading.
  const normalized      = normalizeEvents(n, opts);
  const interrupts      = extractInterrupts(n);
  const errors          = extractErrors(n);
  const incomplete      = findIncompleteInvocations(n);
  const metrics         = computeMetrics(n);
  const topThreadProms  = topLevelPromptCompletions(n, threads);
  const userMessage     = extractUserMessage(topThreadProms);
  const finalResponse   = extractFinalResponse(topThreadProms);

  const last = n.events[n.events.length - 1];

  return {
    traceId,
    recordVersion: 1,
    formatVersion: events[0].format_version,
    durationMs: last.tMs,
    source,
    userMessage: userMessage.result,
    finalResponse: finalResponse.result,
    threads,
    events: normalized.result,
    interrupts: interrupts.result,
    errors: errors.result,
    incomplete: incomplete.result,
    metrics: metrics.result,
    warnings: [
      ...n.warnings,
      ...normalized.warnings,
      ...interrupts.warnings,
      ...errors.warnings,
      ...incomplete.warnings,
      ...metrics.warnings,
      ...userMessage.warnings,
      ...finalResponse.warnings,
    ],
  };
}
```

Then implement each helper as a small, declarative, single-responsibility function. **Rule: every helper body must be expressible as filter/map/reduce composition, not a single switching loop over `n.events`.** If you find yourself writing `for (const ev of n.events) { switch (ev.type) { ... } }`, split into one helper per type and read from `n.byType[type]` instead.

- `normalizeEvents(n, opts): WithWarnings<NormalizedEvent[]>` — three declarative passes over `n.byType.promptCompletion`, `n.byType.toolCallStart`, `n.byType.toolCall`, mapped into `llm` / `tool_start` / `tool_end` shapes respectively, then merged and sorted by `tMs`. Reads through `modelOf`, `toolsOf`, `toolNameOf`, `cost`, `tokensIn`, `tokensOut` accessors. Applies preview truncation via `opts.previewChars`.
- `extractInterrupts(n): WithWarnings<InterruptEntry[]>` — `Object.groupBy(allInterruptEvents, e => e.raw.data.interruptId)` (where `allInterruptEvents` concatenates `byType.interruptThrown`, `byType.handlerDecision`, `byType.interruptResolved`), then `.map` each group into an `InterruptEntry` via a small `buildInterruptEntry(group)` helper. No imperative scan.
- `extractErrors(n): WithWarnings<ErrorEntry[]>` — `n.byType.error.map(...)`.
- `findIncompleteInvocations(n): WithWarnings<IncompleteInvocation[]>` — let `endedSpans = new Set((n.byType.toolCall ?? []).map(e => e.spanId))`, then `(n.byType.toolCallStart ?? []).filter(e => !endedSpans.has(e.spanId)).map(...)`. Reads `threadId` directly from the normalized envelope.
- `computeMetrics(n): WithWarnings<Metrics>` — declarative reductions: `llmCalls = (n.byType.promptCompletion ?? []).length`, `tokensInTotal = (n.byType.promptCompletion ?? []).reduce((s, e) => s + tokensIn(e.raw), 0)`, etc. `models = [...new Set((n.byType.promptCompletion ?? []).map(e => modelOf(e.raw)))].sort()`. `toolCounts = Object.fromEntries(Object.entries(Object.groupBy(n.byType.toolCall ?? [], e => toolNameOf(e.raw))).map(([k, v]) => [k, v.length]))`.
- `topLevelPromptCompletions(n, threads): NormalizedEnvelope[]` — shared helper for the two functions below. Returns the chronologically-ordered `promptCompletion` events for the top-level thread (the unique `ThreadEntry` whose `parentThreadId === null`). Fallback if no top-level thread is known: return all `promptCompletion` events in chronological order. This is the **one place** the fallback rule lives.
- `extractUserMessage(prompts): WithWarnings<string | null>` — `prompts.length === 0 ? null : userMessageOf(prompts[0].raw)`.
- `extractFinalResponse(prompts): WithWarnings<string | null>` — `prompts.length === 0 ? null : completionOf(prompts[prompts.length - 1].raw)`.

**Thread resolution:** already done in Task 3's `normalize()`. Helpers just read `ev.threadId` off the normalized envelope.

- [ ] **Step 3: Run tests, fix until green.**

- [ ] **Step 4: Integration test against a fresh fixture.** After Task 0 lands, capture a small deterministic agent run and check it into `lib/eval/fixtures/` as both `<name>.statelog.jsonl` and `<name>.expected.json`. Suggested fixture: a one-shot prompt that triggers exactly one subagent (e.g. asks the agency-agent to summarize a small file via the explorer subagent), so the expected record stays small enough to maintain by hand. Assert:
  - `traceId` equals the captured run's `trace_id`, **read from the fixture itself** rather than hard-coded in the test source — keeps the assertion stable if you recapture.
  - `threads` has at least 2 entries, including one whose `label === "main"` and one whose `label` matches the subagent's declared label.
  - Every `NormalizedEvent` of kind `tool_start` / `tool_end` / `llm` has `threadId !== null`.
  - `userMessage` is a non-empty string matching the user prompt the fixture was captured with (or substring-match a known phrase to stay stable across minor wording tweaks).
  - `finalResponse` is a non-empty string. Optionally substring-check a known phrase from the captured response, but be tolerant of LLM nondeterminism if the fixture was captured live.
  - `warnings` is empty.
  - Optionally also keep the legacy `statelog.log` as `lib/eval/fixtures/legacy.statelog.jsonl` for a graceful-degradation test: extract returns without throwing, `warnings` contains the "no threadId field" warning, `userMessage` and `finalResponse` are still populated (via the chronological fallback), and `interrupts[*].kind` and `incomplete` are tolerated as empty/null.

---

## Task 5: Truncation policy for `argsPreview` and `outputPreview`

Tool args and outputs can be enormous (full file contents, large LLM responses). Storing them verbatim makes eval records huge and judges slow.

- [ ] **Step 1: Pick a default and make it overridable**

```typescript
const DEFAULT_PREVIEW_CHARS = 200;

function preview(value: unknown, limit = DEFAULT_PREVIEW_CHARS): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= limit) return s;
  return s.slice(0, limit - 1) + "…";
}
```

Expose via CLI flag (`--preview-chars <n>`, default 200, `0` means full content). Pass through into `extractEvalRecord` options.

---

## Task 6: CLI wrapper

**Files:**
- Create: `lib/cli/evalExtract.ts`
- Modify: `scripts/agency.ts`

- [ ] **Step 1: Write the CLI wrapper**

```typescript
// lib/cli/evalExtract.ts
import * as fs from "fs";

import { readAllEvents } from "../eval/parseJsonl.js";
import { extractEvalRecord } from "../eval/extract.js";

export async function evalExtract(
  file: string,
  opts: { out?: string; previewChars?: number; pretty?: boolean },
): Promise<void> {
  const events = await readAllEvents(file);
  const record = extractEvalRecord(events, file, {
    previewChars: opts.previewChars,
  });
  const outPath = opts.out ?? defaultOutPath(file);
  // Pretty-print by default (humans read these); compact mode for
  // pipelines that diff or stream them.
  const pretty = opts.pretty !== false;
  fs.writeFileSync(outPath, JSON.stringify(record, null, pretty ? 2 : 0));
  console.log(
    `Wrote eval record to ${outPath} (${record.events.length} events, ` +
      `${record.threads.length} threads, ` +
      `${record.incomplete.length} incomplete)`,
  );
}

function defaultOutPath(input: string): string {
  return `${stripJsonlSuffix(input)}.eval.json`;
}

/** Strip `.statelog.jsonl` or `.jsonl` from the end of a path,
 *  returning the original path unchanged if neither suffix is
 *  present. Split out so `defaultOutPath` reads declaratively
 *  instead of nesting ternaries. */
function stripJsonlSuffix(input: string): string {
  for (const suffix of [".statelog.jsonl", ".jsonl"]) {
    if (input.endsWith(suffix)) return input.slice(0, -suffix.length);
  }
  return input;
}
```

- [ ] **Step 2: Register in `scripts/agency.ts`**

```typescript
import { evalExtract } from "@/cli/evalExtract.js";

// ... after the logs command block:

const evalCmd = program
  .command("eval")
  .description("Evaluate agent runs against task fixtures");

evalCmd
  .command("extract")
  .description(
    "Extract a structured eval record from a statelog file. " +
      "Use this on the trace of one agent run to produce a JSON " +
      "artifact you can grade with an LLM judge or compare against " +
      "another run."
  )
  .argument("<file>", "Path to a .statelog.jsonl file")
  .option(
    "-o, --out <path>",
    "Output JSON path (default: <file>.eval.json)",
  )
  .option(
    "--preview-chars <n>",
    "Max chars for tool args/output previews (default: 200, 0 for full)",
    (v) => parseInt(v, 10),
  )
  .option(
    "--compact",
    "Emit compact JSON instead of pretty-printed (pipelines / diffs)",
  )
  .action(async (file: string, opts: { out?: string; previewChars?: number; compact?: boolean }) => {
    await evalExtract(file, { ...opts, pretty: !opts.compact });
  });
```

Place this block in `scripts/agency.ts` directly after the `logsCmd` block for visual grouping. Verify the file uses Commander's chained `.command()` builder (it should — that's what `logsCmd` uses).

---

## Task 7: Docs

**Files:**
- Create: `docs/site/cli/eval.md`

- [ ] **Step 1: Write the doc**

Cover:
- What `agency eval` is for (and what it isn't — it's not running the agent, it's structuring an existing trace).
- The output shape with a worked example.
- The contract: extractor output is generic; semantic per-project queries belong in the consumer (or a future `eval check` command).
- A brief paragraph on the **downstream chain**: `userMessage` and `finalResponse` are hoisted to the top level specifically because the planned `agency eval compare` will feed them to an LLM judge for pairwise quality comparison across two runs. `threads[*].label` is what consumer behavioral queries grep on. Mention these connections so doc readers see why those fields exist where they do.
- A worked example showing the CLI on the in-tree fixture (fill in the real counts from the actual fixture before merge — don't ship the placeholder numbers):

```bash
agency eval extract lib/eval/fixtures/<fixture-name>.statelog.jsonl
# Wrote eval record to lib/eval/fixtures/<fixture-name>.eval.json
#   (<N> events, <M> threads, <K> incomplete)
```

- The behavioral-flag pattern as a recipe (not a built-in):

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

---

## Task 8: Smoke test against a fresh capture

The captured `statelog.log` in the repo root predates the runtime changes that landed thread labels, `toolCallStart`, and interrupt summaries. The unit tests in Task 4 exercise those code paths via hand-crafted fixtures, but a real end-to-end check is worth doing.

- [ ] **Step 1: Run the agency-agent on a small task** with `log.host: "stdout"` redirected to a file:

```bash
agency run lib/agents/agency-agent/agent.agency --log-file /tmp/fresh.statelog.jsonl
# (or however you currently capture logs — confirm the right invocation)
```

Drive it with one trivial prompt that triggers at least one subagent (e.g. "summarize types.md").

- [ ] **Step 2: Run the extractor on the output**

```bash
agency eval extract /tmp/fresh.statelog.jsonl
```

- [ ] **Step 3: Open the resulting `.eval.json` and verify:**
  - Threads have `label` populated (e.g. `"main"`, `"explorer"`).
  - At least one `tool_start` exists (the new event we just added).
  - Each `tool_start` has a matching `tool_end` (since the run completed cleanly).
  - `interrupts` entries have `kind`/`message` populated (not just `interruptId`).
  - `userMessage` matches the prompt you typed.
  - `finalResponse` matches (substring) the reply you saw in the terminal.
  - Every `NormalizedEvent` of kind `tool_start` / `tool_end` / `llm` has a non-null `threadId`.

Any field still empty here flags either a runtime bug (the logging didn't take) or a parser bug.

---

## Out of scope (future plans)

**Immediate next plan (build right after this one):**

- `agency eval compare <a> <b> --judge <prompt-file>` — pairwise judging across two EvalRecords. Combines a deterministic diff (tool count delta, error delta, behavioral flag delta, cost / latency delta) with an LLM-judge verdict on `userMessage` + `finalResponse`. Uses position-swap bias mitigation (run the judge twice with A/B order swapped, only count tasks where both runs agree) and anonymized inputs (judge sees "Response 1" / "Response 2", never the agent version). This is *the* command that turns "I tweaked a prompt — is it better?" from a vibes check into a measurable signal. The fields `userMessage` / `finalResponse` on EvalRecord are added specifically to make this command a thin layer over the extract step.

**Deferred (build later, when manual capture starts to hurt):**

- `agency eval run <task-file>` — drive the agent on a task definition and produce a statelog (optionally chaining `extract` automatically). Worth doing once iteration cadence is high enough that manual capture is a bottleneck — until then, you can run the agent by hand, save the statelog, and use `extract` + `compare`.
- `agency eval judge <record> --rubric <file>` — single-record absolute scoring. LLM judges are notoriously unreliable at absolute scores; pairwise via `compare` should be preferred. Only build this if a specific need emerges.
- A built-in "behavioral flags" layer encoding common rules (e.g. "called oracle before first write"). The README doc (Task 7) shows the pattern as a consumer recipe; promote it into an `eval check --rules` command later if a clear convention emerges.

---

## Order of work

1. Task 0 (runtime prereq — `threadId` on events) — 30–45 minutes. Hard prereq of Task 4.
2. Task 1 (types) — half an hour.
3. Task 2 (shared wire types + JSONL parser) — 45 minutes.
4. Task 2.5 (wire-format accessor layer) — 30 minutes. Hard prereq of Tasks 3 and 4 (helpers read through it).
5. Task 3 (normalize pass: envelopes → Normalized) — 45 minutes. Hard prereq of Task 4.
6. Task 4 (extractor + tests) — 1.5–2 hours. Mostly composing declarative helpers over the Normalized form built in Task 3.
7. Task 5 (preview policy) — 15 minutes.
8. Task 6 (CLI wiring) — 30 minutes.
9. Task 8 (smoke test on a fresh capture) — 30 minutes.
10. Task 7 (docs) — 30 minutes.

Total estimate: roughly half a day end-to-end. The extra Task 2.5 + Task 3 add ~75 minutes up front but remove the same amount (or more) from Task 4 because every helper becomes a one-liner over `n.byType.X`.
