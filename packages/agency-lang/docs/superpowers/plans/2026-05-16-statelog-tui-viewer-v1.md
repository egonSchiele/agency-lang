# StateLog TUI Viewer — v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an `agency logs view <file>` command that renders a statelog JSONL file as an interactive, collapsible span tree in the terminal.

**Architecture:** Pure read-only viewer. Parse JSONL → group events into per-trace span trees using `span_id` / `parent_span_id` → render with the in-tree TUI library (`lib/tui`) → handle keyboard input for expand/collapse/navigate. No file watching, no search, no JSON leaf expansion in v1 — those are explicitly deferred to v2.

**Tech Stack:** TypeScript, `lib/tui` (Screen, TerminalInput, TerminalOutput, frame, render), `commander` (already used by [scripts/agency.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/scripts/agency.ts)), Vitest, Node `fs` (sync reads only — no `fs.watch`).

**Design spec:** [docs/superpowers/specs/2026-05-16-statelog-tui-viewer-design.md](file:///Users/adityabhargava/agency-lang-statelog-enhancement/packages/agency-lang/docs/superpowers/specs/2026-05-16-statelog-tui-viewer-design.md)

---

## Background

### What we have today

- A complete StateLog event model: every event is one JSON object per line in the `logFile`, with envelope `{ trace_id, project_id, span_id, parent_span_id, data: { type, timestamp, ... } }`.
- A span hierarchy: `agentRun > nodeExecution > llmCall > toolExecution`, plus `forkAll` / `race` / `handlerChain` spans. Branch span stacks are now isolated via AsyncLocalStorage (see commit `0e1b7b4c`), so events inside fork branches carry the correct branch-local parent span — tree reconstruction will Just Work.
- `agentStart` + `agentEnd` are both emitted ([lib/runtime/node.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/node.ts) lines 159, 193, 257; [lib/runtime/interrupts.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/interrupts.ts) line 304), so per-agent metrics aggregate without inference.
- [lib/tui](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui) provides everything we need: `Screen`, `TerminalInput`, `TerminalOutput`, `frame`, `render`, `colors`. Used by the debugger today.

### What's missing

- A `format_version` field on the envelope so the viewer can refuse to render incompatible schemas with a clear message.
- Any CLI surface for reading the logfile back.
- A tree-reconstruction routine and a renderer.

### Why this v1 scope

Per the spec discussion: ship the smallest viewer that's actually useful. Static read, render once, navigate, expand/collapse, quit. Defer follow mode, search, JSON-leaf collapsible expansion, color-by-magnitude polish, copy-to-clipboard, bookmarks, timeline view. Each of those is its own non-trivial sub-project and we don't need them to validate the core value.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| [packages/agency-lang/lib/logsViewer/types.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/types.ts) | `EventEnvelope`, `TreeNode`, `ViewerState` shapes |
| [packages/agency-lang/lib/logsViewer/parse.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/parse.ts) | Stream-parse JSONL into `EventEnvelope[]` |
| [packages/agency-lang/lib/logsViewer/tree.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/tree.ts) | Build per-trace `TreeNode` from flat events |
| [packages/agency-lang/lib/logsViewer/summary.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/summary.ts) | One-line summary string per event/span type |
| [packages/agency-lang/lib/logsViewer/render.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/render.ts) | Tree + state → `lib/tui` frame |
| [packages/agency-lang/lib/logsViewer/input.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/input.ts) | Keyboard handler — keystroke + state → next state |
| [packages/agency-lang/lib/logsViewer/run.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts) | Entry point: wire parse → tree → Screen + input loop |
| [packages/agency-lang/lib/cli/logsView.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/cli/logsView.ts) | Tiny CLI wrapper |
| Tests: each non-trivial file gets a co-located `.test.ts`. |

### Modified files

| File | Change |
|---|---|
| [packages/agency-lang/lib/statelogClient.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/statelogClient.ts) | Add `format_version: 1` to the event envelope written by `post()` |
| [packages/agency-lang/lib/statelogClient.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/statelogClient.test.ts) | Assert `format_version` is set on emitted events |
| [packages/agency-lang/scripts/agency.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/scripts/agency.ts) | Register `logs view` subcommand |

---

## Task Decomposition

### Task 1 — Add `format_version` to the event envelope

**Files:**
- Modify: [packages/agency-lang/lib/statelogClient.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/statelogClient.ts) around line 716
- Test: [packages/agency-lang/lib/statelogClient.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/statelogClient.test.ts)

- [ ] **Step 1: Add a failing test in [statelogClient.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/statelogClient.test.ts)**

In the existing `describe("sinks", ...)` block, add:

```ts
it("emits format_version: 1 on every event envelope", async () => {
  const file = newLogFile("format-version");
  const client = fileClient(file);
  await client.debug("hi", {});
  await client.agentStart({ entryNode: "main" });
  const events = readEvents(file);
  for (const evt of events) {
    expect(evt.format_version).toBe(1);
  }
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm vitest run lib/statelogClient.test.ts -t "format_version"
```

Expected: FAIL — `expected undefined to be 1`.

- [ ] **Step 3: Add the field in `post()`**

In `post()` ([lib/statelogClient.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/statelogClient.ts) around line 716), add `format_version: STATELOG_FORMAT_VERSION,` as the first key of the envelope. At the top of the file (near the other constants), add:

```ts
// Bump this when the wire format changes in a way the viewer needs
// to notice. The viewer rejects files with a higher version.
export const STATELOG_FORMAT_VERSION = 1;
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
pnpm vitest run lib/statelogClient.test.ts
```

Expected: all 35+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agency-lang/lib/statelogClient.ts packages/agency-lang/lib/statelogClient.test.ts
git commit -F /tmp/task1-commit.txt
```

Commit message body:

```
statelog: add format_version: 1 to event envelope

So the upcoming `agency logs view` viewer can refuse to render
schemas it doesn't understand with a clear error, instead of
mis-rendering or crashing.
```

---

### Task 2 — `types.ts`: data shapes only

**Files:**
- Create: [packages/agency-lang/lib/logsViewer/types.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/types.ts)

No tests — pure type declarations.

- [ ] **Step 1: Create the file**

```ts
// Wire format produced by StatelogClient.post(). Mirrors the envelope
// shape we read from the JSONL file; do NOT depend on the runtime
// SpanContext type here — the viewer must compile and run from any
// JSONL without the runtime loaded.
export type EventEnvelope = {
  format_version: number;
  trace_id: string;
  project_id: string;
  span_id: string | null;
  parent_span_id: string | null;
  data: EventData;
};

export type EventData = {
  type: string;
  timestamp: string;
  [key: string]: any;
};

// One node in the visible tree. Spans (have children) and leaf events
// (no children) share this shape — `nodeKind` discriminates.
export type TreeNode = {
  id: string;            // span_id for spans; "evt-<index>" for leaves
  traceId: string;
  parentId: string | null;
  children: TreeNode[];
  nodeKind: "trace" | "span" | "event";
  // For "trace": the trace_id; for "span": the span type (agentRun,
  // llmCall, ...); for "event": the data.type.
  label: string;
  // Pre-computed display summary, e.g. `llmCall (1.2s, 1500 tok, $0.007)`.
  summary: string;
  // For spans, aggregated from descendants; for events, drawn from
  // the event payload.
  duration?: number;
  tokens?: number;
  cost?: number;
  // The raw event for leaf nodes. Spans don't carry one (multiple
  // events share a span).
  event?: EventEnvelope;
};

export type ViewerState = {
  // The full forest (one root per trace_id) plus pre-computed flat
  // view ordering so renderer & input can index into it cheaply.
  roots: TreeNode[];
  // ids of every node currently expanded.
  expanded: Set<string>;
  // Currently-focused node id (cursor position).
  cursorId: string;
  // Vertical scroll offset (line of the first visible row).
  scrollTop: number;
  // Set by the input layer; consumed by the run loop.
  quit: boolean;
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/agency-lang/lib/logsViewer/types.ts
git commit -m "logsViewer: add type shapes (EventEnvelope, TreeNode, ViewerState)"
```

---

### Task 3 — `parse.ts`: stream-parse JSONL

**Files:**
- Create: [packages/agency-lang/lib/logsViewer/parse.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/parse.ts)
- Test: [packages/agency-lang/lib/logsViewer/parse.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/parse.test.ts)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseStatelogJsonl, ParseResult } from "./parse.js";

const v1 = (data: object, extra: object = {}) =>
  JSON.stringify({
    format_version: 1,
    trace_id: "t1",
    project_id: "p1",
    span_id: null,
    parent_span_id: null,
    data: { type: "debug", timestamp: "2026-05-16T00:00:00Z", ...data },
    ...extra,
  });

describe("parseStatelogJsonl", () => {
  it("parses well-formed JSONL into events", () => {
    const input = [v1({ message: "a" }), v1({ message: "b" })].join("\n") + "\n";
    const result = parseStatelogJsonl(input);
    expect(result.events).toHaveLength(2);
    expect(result.errors).toEqual([]);
    expect(result.events[0].data.message).toBe("a");
  });

  it("skips blank lines silently", () => {
    const input = v1({}) + "\n\n\n" + v1({}) + "\n";
    const result = parseStatelogJsonl(input);
    expect(result.events).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  it("records parse errors with line numbers but keeps going", () => {
    const input = [v1({}), "this is not json", v1({})].join("\n");
    const result = parseStatelogJsonl(input);
    expect(result.events).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
  });

  it("rejects future format versions with one fatal error", () => {
    const future = JSON.stringify({
      format_version: 999,
      trace_id: "t", project_id: "p", span_id: null, parent_span_id: null,
      data: { type: "x", timestamp: "" },
    });
    const result = parseStatelogJsonl(future);
    expect(result.events).toHaveLength(0);
    expect(result.errors[0].kind).toBe("unsupported_version");
  });

  it("tolerates missing format_version (legacy files)", () => {
    const legacy = JSON.stringify({
      trace_id: "t", project_id: "p", span_id: null, parent_span_id: null,
      data: { type: "debug", timestamp: "" },
    });
    const result = parseStatelogJsonl(legacy);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].format_version).toBe(1);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

```bash
pnpm vitest run lib/logsViewer/parse.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement [parse.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/parse.ts)**

```ts
import { EventEnvelope } from "./types.js";

const SUPPORTED_VERSION = 1;

export type ParseError = {
  line: number;
  kind: "invalid_json" | "missing_fields" | "unsupported_version";
  detail: string;
};

export type ParseResult = {
  events: EventEnvelope[];
  errors: ParseError[];
};

export function parseStatelogJsonl(text: string): ParseResult {
  const events: EventEnvelope[] = [];
  const errors: ParseError[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      errors.push({
        line: i + 1,
        kind: "invalid_json",
        detail: (e as Error).message,
      });
      continue;
    }
    const version = obj.format_version ?? 1;
    if (typeof version === "number" && version > SUPPORTED_VERSION) {
      errors.push({
        line: i + 1,
        kind: "unsupported_version",
        detail: `format_version ${version} > ${SUPPORTED_VERSION}`,
      });
      continue;
    }
    if (!obj.trace_id || !obj.data || typeof obj.data.type !== "string") {
      errors.push({
        line: i + 1,
        kind: "missing_fields",
        detail: "missing trace_id or data.type",
      });
      continue;
    }
    events.push({
      format_version: version,
      trace_id: obj.trace_id,
      project_id: obj.project_id ?? "",
      span_id: obj.span_id ?? null,
      parent_span_id: obj.parent_span_id ?? null,
      data: obj.data,
    });
  }
  return { events, errors };
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
pnpm vitest run lib/logsViewer/parse.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/agency-lang/lib/logsViewer/parse.ts packages/agency-lang/lib/logsViewer/parse.test.ts
git commit -m "logsViewer: stream-parse JSONL with error recovery and version gating"
```

---

### Task 4 — `tree.ts`: flat events → per-trace tree

**Files:**
- Create: [packages/agency-lang/lib/logsViewer/tree.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/tree.ts)
- Test: [packages/agency-lang/lib/logsViewer/tree.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/tree.test.ts)

This is the heart of the viewer. It must:

- Group events by `trace_id` into one root per trace.
- For each event with a `span_id`, find-or-create a span node keyed by that id, attach the event as a child (leaf), attach the span node under its parent span (by `parent_span_id`) or under the trace root.
- The span's "label" comes from the **first** event that introduced that `span_id` — use the heuristic that span-introducing events are `agentStart`, `enterNode`, plus any event whose span_id has never been seen before (in arrival order).
- Aggregate `duration` / `tokens` / `cost` for each span from the events under it: duration from the last - first `timestamp`; tokens & cost from `promptCompletion` events' `usage` and `cost`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildForest } from "./tree.js";
import { EventEnvelope } from "./types.js";

const evt = (over: Partial<EventEnvelope>): EventEnvelope => ({
  format_version: 1,
  trace_id: "t1",
  project_id: "p",
  span_id: null,
  parent_span_id: null,
  data: { type: "debug", timestamp: "2026-05-16T00:00:00Z" },
  ...over,
});

describe("buildForest", () => {
  it("returns one root per trace_id", () => {
    const forest = buildForest([
      evt({ trace_id: "a" }),
      evt({ trace_id: "b" }),
      evt({ trace_id: "a" }),
    ]);
    expect(forest).toHaveLength(2);
    expect(forest.map((r) => r.label).sort()).toEqual(["a", "b"]);
  });

  it("nests span children under their parent span", () => {
    const forest = buildForest([
      evt({ span_id: "s1", parent_span_id: null, data: { type: "agentStart", timestamp: "" } }),
      evt({ span_id: "s2", parent_span_id: "s1", data: { type: "enterNode", timestamp: "", nodeId: "main" } }),
      evt({ span_id: "s2", parent_span_id: "s1", data: { type: "promptCompletion", timestamp: "" } }),
    ]);
    const trace = forest[0];
    const s1 = trace.children[0];
    expect(s1.nodeKind).toBe("span");
    const s2 = s1.children[0];
    expect(s2.nodeKind).toBe("span");
    expect(s2.children).toHaveLength(2); // enterNode + promptCompletion as leaves
  });

  it("attaches events with no span_id directly under the trace root", () => {
    const forest = buildForest([
      evt({ data: { type: "debug", timestamp: "", message: "rootless" } }),
    ]);
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].nodeKind).toBe("event");
  });

  it("aggregates tokens and cost from promptCompletion children", () => {
    const forest = buildForest([
      evt({
        span_id: "s1", parent_span_id: null,
        data: {
          type: "promptCompletion", timestamp: "",
          usage: { inputTokens: 100, outputTokens: 200 },
          cost: { totalCost: 0.0042 },
        },
      }),
      evt({
        span_id: "s1", parent_span_id: null,
        data: {
          type: "promptCompletion", timestamp: "",
          usage: { inputTokens: 50, outputTokens: 50 },
          cost: { totalCost: 0.001 },
        },
      }),
    ]);
    const s1 = forest[0].children[0];
    expect(s1.tokens).toBe(400);
    expect(s1.cost).toBeCloseTo(0.0052, 5);
  });

  it("computes duration from first to last event timestamp", () => {
    const forest = buildForest([
      evt({ span_id: "s1", parent_span_id: null, data: { type: "agentStart", timestamp: "2026-05-16T00:00:00.000Z" } }),
      evt({ span_id: "s1", parent_span_id: null, data: { type: "agentEnd", timestamp: "2026-05-16T00:00:04.200Z" } }),
    ]);
    const s1 = forest[0].children[0];
    expect(s1.duration).toBeCloseTo(4200, 0);
  });

  it("preserves event arrival order within a span", () => {
    const forest = buildForest([
      evt({ span_id: "s1", data: { type: "debug", timestamp: "", message: "first" } }),
      evt({ span_id: "s1", data: { type: "debug", timestamp: "", message: "second" } }),
    ]);
    const events = forest[0].children[0].children;
    expect(events[0].event!.data.message).toBe("first");
    expect(events[1].event!.data.message).toBe("second");
  });

  it("orphaned parent_span_id attaches to the trace root", () => {
    const forest = buildForest([
      evt({ span_id: "s2", parent_span_id: "s1-never-seen", data: { type: "debug", timestamp: "" } }),
    ]);
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].id).toBe("s2");
    expect(forest[0].children[0].parentId).toBe(forest[0].id);
  });
});
```

- [ ] **Step 2: Run, confirm failing**

```bash
pnpm vitest run lib/logsViewer/tree.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement [tree.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/tree.ts)**

```ts
import { EventEnvelope, TreeNode } from "./types.js";
import { summarize } from "./summary.js";

export function buildForest(events: EventEnvelope[]): TreeNode[] {
  // traceId → trace root
  const traces = new Map<string, TreeNode>();
  // span_id → span node (lookup across all traces; span_ids are globally unique per nanoid)
  const spans = new Map<string, TreeNode>();

  let leafCounter = 0;

  for (const evt of events) {
    const traceRoot = ensureTrace(traces, evt.trace_id);
    const spanNode = evt.span_id
      ? ensureSpan(spans, traces, evt)
      : null;
    const parent = spanNode ?? traceRoot;
    const leaf: TreeNode = {
      id: `evt-${leafCounter++}`,
      traceId: evt.trace_id,
      parentId: parent.id,
      children: [],
      nodeKind: "event",
      label: evt.data.type,
      summary: summarize(evt),
      event: evt,
    };
    parent.children.push(leaf);
  }

  // Second pass: aggregate metrics on each span.
  for (const span of spans.values()) {
    aggregateMetrics(span);
  }
  // Aggregate trace-level metrics from immediate span children too.
  for (const trace of traces.values()) {
    aggregateMetrics(trace);
    trace.summary = summarizeTrace(trace);
  }

  return [...traces.values()];
}

function ensureTrace(map: Map<string, TreeNode>, traceId: string): TreeNode {
  const existing = map.get(traceId);
  if (existing) return existing;
  const root: TreeNode = {
    id: `trace-${traceId}`,
    traceId,
    parentId: null,
    children: [],
    nodeKind: "trace",
    label: traceId,
    summary: "", // filled in by aggregateMetrics later
  };
  map.set(traceId, root);
  return root;
}

function ensureSpan(
  spans: Map<string, TreeNode>,
  traces: Map<string, TreeNode>,
  evt: EventEnvelope,
): TreeNode {
  const existing = spans.get(evt.span_id!);
  if (existing) return existing;
  const node: TreeNode = {
    id: evt.span_id!,
    traceId: evt.trace_id,
    parentId: evt.parent_span_id ?? null,
    children: [],
    nodeKind: "span",
    // Use the introducing event's type as a hint for the span type;
    // refined when we know more (e.g. agentStart → agentRun).
    label: inferSpanLabel(evt),
    summary: "", // filled in by aggregateMetrics
  };
  spans.set(evt.span_id!, node);

  // Attach to parent span (if known) or to the trace root.
  const parent = evt.parent_span_id
    ? spans.get(evt.parent_span_id) ?? ensureTrace(traces, evt.trace_id)
    : ensureTrace(traces, evt.trace_id);
  node.parentId = parent.id;
  parent.children.push(node);
  return node;
}

function inferSpanLabel(evt: EventEnvelope): string {
  switch (evt.data.type) {
    case "agentStart":
    case "agentEnd":
      return "agentRun";
    case "enterNode":
      return "nodeExecution";
    case "promptCompletion":
      return "llmCall";
    case "toolCall":
      return "toolExecution";
    case "forkStart":
    case "forkEnd":
      return evt.data.mode === "race" ? "race" : "forkAll";
    case "handlerDecision":
      return "handlerChain";
    default:
      return evt.data.type;
  }
}

function aggregateMetrics(node: TreeNode): void {
  const leaves: TreeNode[] = [];
  walk(node, (n) => { if (n.event) leaves.push(n); });

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const tokens = sum(
    leaves
      .filter((l) => l.event!.data.type === "promptCompletion")
      .map((l) => {
        const u = l.event!.data.usage ?? {};
        return (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      }),
  );

  const cost = sum(
    leaves
      .filter((l) => l.event!.data.type === "promptCompletion")
      .map((l) => l.event!.data.cost?.totalCost ?? 0),
  );

  const timestamps = leaves
    .map((l) => Date.parse(l.event!.data.timestamp))
    .filter(Number.isFinite);

  if (tokens > 0) node.tokens = tokens;
  if (cost > 0) node.cost = cost;
  if (timestamps.length >= 2) {
    node.duration = Math.max(...timestamps) - Math.min(...timestamps);
  }

  if (node.nodeKind === "span") {
    node.summary = summarizeSpan(node);
  }
}

function walk(node: TreeNode, visit: (n: TreeNode) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

// Placeholders — implemented in summary.ts, but stubbed here until that
// lands so this file compiles in isolation. Replace with real impls
// after Task 5.
function summarizeSpan(node: TreeNode): string { return node.label; }
function summarizeTrace(node: TreeNode): string { return node.label; }
```

(Note: `summarize`, `summarizeSpan`, `summarizeTrace` are stubbed here so this file compiles. Task 5 replaces them.)

- [ ] **Step 4: Run tests, confirm pass**

```bash
pnpm vitest run lib/logsViewer/tree.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/agency-lang/lib/logsViewer/tree.ts packages/agency-lang/lib/logsViewer/tree.test.ts
git commit -m "logsViewer: build per-trace span forest with metric aggregation"
```

---

### Task 5 — `summary.ts`: per-event-type summary strings

**Files:**
- Create: [packages/agency-lang/lib/logsViewer/summary.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/summary.ts)
- Test: [packages/agency-lang/lib/logsViewer/summary.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/summary.test.ts)
- Modify: [packages/agency-lang/lib/logsViewer/tree.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/tree.ts) to delegate to the real implementations

Format matches the spec's summary-line table.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { summarize, summarizeSpan, summarizeTrace } from "./summary.js";
import { TreeNode } from "./types.js";

describe("summarize (leaf events)", () => {
  it("promptCompletion shows model and duration", () => {
    const s = summarize({
      format_version: 1, trace_id: "", project_id: "",
      span_id: null, parent_span_id: null,
      data: { type: "promptCompletion", timestamp: "", model: "\"gpt-4o\"", timeTaken: 1234 },
    });
    expect(s).toMatch(/gpt-4o/);
    expect(s).toMatch(/1\.2s|1234ms/);
  });

  it("error shows errorType and message prefix", () => {
    const s = summarize({
      format_version: 1, trace_id: "", project_id: "",
      span_id: null, parent_span_id: null,
      data: { type: "error", timestamp: "", errorType: "ToolFailure", message: "tool blew up because the API rate-limited us" },
    });
    expect(s).toContain("ToolFailure");
    expect(s).toContain("tool blew up");
  });

  it("toolCall shows the tool name", () => {
    const s = summarize({
      format_version: 1, trace_id: "", project_id: "",
      span_id: null, parent_span_id: null,
      data: { type: "toolCall", timestamp: "", toolName: "searchDB" },
    });
    expect(s).toContain("searchDB");
  });

  it("falls back to event type when no specific format applies", () => {
    const s = summarize({
      format_version: 1, trace_id: "", project_id: "",
      span_id: null, parent_span_id: null,
      data: { type: "unknownEvent", timestamp: "" },
    });
    expect(s).toBe("unknownEvent");
  });
});

describe("summarizeSpan", () => {
  it("llmCall shows duration + tokens + cost", () => {
    const node: TreeNode = {
      id: "s", traceId: "", parentId: null, children: [],
      nodeKind: "span", label: "llmCall", summary: "",
      duration: 1200, tokens: 1500, cost: 0.007,
    };
    const s = summarizeSpan(node);
    expect(s).toMatch(/llmCall/);
    expect(s).toMatch(/1\.2s/);
    expect(s).toMatch(/1500\s*tok/);
    expect(s).toMatch(/\$0\.007/);
  });
});

describe("summarizeTrace", () => {
  it("trace summary trims id and shows aggregate metrics", () => {
    const node: TreeNode = {
      id: "trace-abc123def456", traceId: "abc123def456",
      parentId: null, children: [], nodeKind: "trace",
      label: "abc123def456", summary: "",
      duration: 4200, tokens: 2300, cost: 0.010,
    };
    const s = summarizeTrace(node);
    expect(s).toMatch(/trace abc123/);
    expect(s).toMatch(/4\.2s/);
    expect(s).toMatch(/2300\s*tok/);
    expect(s).toMatch(/\$0\.010/);
  });
});
```

- [ ] **Step 2: Run, confirm failing**

- [ ] **Step 3: Implement [summary.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/summary.ts)**

```ts
import { EventEnvelope, TreeNode } from "./types.js";

export function summarize(evt: EventEnvelope): string {
  const d = evt.data;
  switch (d.type) {
    case "promptCompletion":
      return `promptCompletion ${stripQuotes(d.model)} (${fmtDuration(d.timeTaken)})`;
    case "toolCall":
      return `toolCall "${d.toolName}" (${fmtDuration(d.timeTaken)})`;
    case "error":
      return `error: ${d.errorType ?? "Error"} "${truncate(d.message ?? "", 60)}"`;
    case "interruptThrown":
      return `interruptThrown "${(d.interruptId ?? "").slice(0, 8)}"`;
    case "interruptResolved":
      return `interruptResolved ${d.outcome ?? "?"} by ${d.resolvedBy ?? "?"}`;
    case "handlerDecision":
      return `handlerDecision #${d.handlerIndex ?? "?"}: ${d.decision ?? "?"}`;
    case "checkpointCreated":
      return `checkpointCreated #${shortId(d.checkpointId)} (${d.reason ?? "?"})`;
    case "checkpointRestored":
      return `checkpointRestored #${shortId(d.checkpointId)} (attempt ${d.restoreCount ?? "?"})`;
    case "forkStart":
      return `forkStart ${d.mode} (${d.branchCount} branches)`;
    case "forkBranchEnd":
      return `forkBranchEnd #${d.branchIndex} (${d.outcome}, ${fmtDuration(d.timeTaken)})`;
    case "forkEnd":
      return `forkEnd ${d.mode} (${fmtDuration(d.timeTaken)})`;
    case "threadCreated":
      return `threadCreated ${d.threadType ?? "?"} #${shortId(d.threadId)}`;
    case "agentStart":
      return `agentStart "${d.entryNode ?? "?"}"`;
    case "agentEnd":
      return `agentEnd (${fmtDuration(d.timeTaken)})`;
    case "enterNode":
      return `enterNode "${d.nodeId ?? "?"}"`;
    case "runMetadata":
      return `runMetadata ${d.tags ? `tags=${JSON.stringify(d.tags)}` : ""}`;
    default:
      return d.type;
  }
}

export function summarizeSpan(node: TreeNode): string {
  const parts = [node.label];
  const metrics: string[] = [];
  if (node.duration !== undefined) metrics.push(fmtDuration(node.duration));
  if (node.tokens !== undefined) metrics.push(`${node.tokens} tok`);
  if (node.cost !== undefined) metrics.push(fmtCost(node.cost));
  if (metrics.length) parts.push(`(${metrics.join(", ")})`);
  return parts.join(" ");
}

export function summarizeTrace(node: TreeNode): string {
  const shortTraceId = node.traceId.slice(0, 6);
  const metrics: string[] = [];
  if (node.duration !== undefined) metrics.push(fmtDuration(node.duration));
  if (node.tokens !== undefined) metrics.push(`${node.tokens} tok`);
  if (node.cost !== undefined) metrics.push(fmtCost(node.cost));
  const tail = metrics.length ? ` (${metrics.join(", ")})` : "";
  return `trace ${shortTraceId}${tail}`;
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(c?: number): string {
  if (c === undefined) return "?";
  return `$${c.toFixed(3)}`;
}

function shortId(id?: string): string {
  return (id ?? "").slice(0, 6);
}

function stripQuotes(s?: string): string {
  if (!s) return "?";
  return s.replace(/^"+|"+$/g, "");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
```

- [ ] **Step 4: Wire up the real implementations in [tree.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/tree.ts)**

Replace the bottom stubs with:

```ts
import { summarize, summarizeSpan, summarizeTrace } from "./summary.js";
```

— and delete the local placeholder functions. The existing `import { summarize } from "./summary.js";` at the top should already cover it; just remove the stubs.

- [ ] **Step 5: Run all logsViewer tests, confirm pass**

```bash
pnpm vitest run lib/logsViewer/
```

- [ ] **Step 6: Commit**

```bash
git add packages/agency-lang/lib/logsViewer/summary.ts packages/agency-lang/lib/logsViewer/summary.test.ts packages/agency-lang/lib/logsViewer/tree.ts
git commit -m "logsViewer: per-event-type summary strings and span/trace metric formatting"
```

---

### Task 6 — `render.ts`: ViewerState → frame

**Files:**
- Create: [packages/agency-lang/lib/logsViewer/render.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/render.ts)
- Test: [packages/agency-lang/lib/logsViewer/render.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/render.test.ts)

The renderer is purely functional: `(state, viewport) → string[]` (lines). The Screen layer turns lines into a frame.

Key responsibilities:
- Flatten the visible tree into an ordered list of `{ depth, node }` according to `state.expanded`.
- For each row, format: `${indent} ${glyph} ${summary}`. `glyph` is `▶` (collapsed), `▼` (expanded), or `●` (leaf event).
- Mark the cursor row by prepending `>` (or applying a visual selection).
- Clip to `viewport.rows`, starting at `state.scrollTop`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { renderViewerLines, flattenVisibleRows } from "./render.js";
import { TreeNode, ViewerState } from "./types.js";

function span(id: string, label: string, children: TreeNode[] = []): TreeNode {
  return {
    id, traceId: "t", parentId: null, children,
    nodeKind: "span", label, summary: `${label} (?)`,
  };
}

function trace(children: TreeNode[]): TreeNode {
  return {
    id: "trace-t", traceId: "t", parentId: null, children,
    nodeKind: "trace", label: "t", summary: "trace t",
  };
}

const baseState = (roots: TreeNode[], expanded: string[] = [], cursorId = roots[0].id): ViewerState => ({
  roots, expanded: new Set(expanded), cursorId, scrollTop: 0, quit: false,
});

describe("flattenVisibleRows", () => {
  it("returns only roots when nothing is expanded", () => {
    const t = trace([span("a", "agentRun")]);
    const rows = flattenVisibleRows(baseState([t]));
    expect(rows).toHaveLength(1);
    expect(rows[0].node.id).toBe("trace-t");
  });

  it("includes children of expanded nodes", () => {
    const a = span("a", "agentRun", [span("b", "nodeExecution")]);
    const t = trace([a]);
    const rows = flattenVisibleRows(baseState([t], ["trace-t", "a"]));
    expect(rows.map((r) => r.node.id)).toEqual(["trace-t", "a", "b"]);
  });
});

describe("renderViewerLines", () => {
  it("uses ▶ for collapsed parents and ▼ for expanded", () => {
    const a = span("a", "agentRun", [span("b", "nodeExecution")]);
    const t = trace([a]);
    const lines = renderViewerLines(baseState([t], ["trace-t"]), { rows: 10, cols: 80 });
    expect(lines[0]).toMatch(/▼/); // expanded trace
    expect(lines[1]).toMatch(/▶/); // collapsed agentRun
  });

  it("uses ● for leaf events", () => {
    const t: TreeNode = {
      id: "trace-t", traceId: "t", parentId: null,
      children: [
        { id: "evt-0", traceId: "t", parentId: "trace-t", children: [],
          nodeKind: "event", label: "debug", summary: "debug" },
      ],
      nodeKind: "trace", label: "t", summary: "trace t",
    };
    const lines = renderViewerLines(baseState([t], ["trace-t"]), { rows: 10, cols: 80 });
    expect(lines[1]).toMatch(/●/);
  });

  it("indents children by depth", () => {
    const a = span("a", "agentRun", [span("b", "nodeExecution")]);
    const t = trace([a]);
    const lines = renderViewerLines(baseState([t], ["trace-t", "a"]), { rows: 10, cols: 80 });
    // Strip ANSI/cursor markers; check leading-space depth.
    expect(lines[1].search(/▶|▼|●/)).toBeGreaterThan(lines[0].search(/▶|▼|●/));
    expect(lines[2].search(/▶|▼|●/)).toBeGreaterThan(lines[1].search(/▶|▼|●/));
  });

  it("marks the cursor row distinctly", () => {
    const t = trace([span("a", "agentRun")]);
    const state = baseState([t], ["trace-t"], "a");
    const lines = renderViewerLines(state, { rows: 10, cols: 80 });
    // Row 1 ("a") is the cursor; row 0 ("trace-t") is not.
    expect(lines[1]).not.toBe(lines[0]);
  });

  it("clips to viewport.rows starting at scrollTop", () => {
    const roots = Array.from({ length: 20 }, (_, i) =>
      trace([span(`s${i}`, "agentRun")]),
    );
    const state: ViewerState = {
      roots, expanded: new Set(), cursorId: "trace-t",
      scrollTop: 5, quit: false,
    };
    const lines = renderViewerLines(state, { rows: 3, cols: 80 });
    expect(lines).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run, confirm failing**

- [ ] **Step 3: Implement [render.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/render.ts)**

```ts
import { TreeNode, ViewerState } from "./types.js";

export type Viewport = { rows: number; cols: number };
export type VisibleRow = { node: TreeNode; depth: number };

export function flattenVisibleRows(state: ViewerState): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    out.push({ node, depth });
    if (state.expanded.has(node.id)) {
      for (const c of node.children) walk(c, depth + 1);
    }
  };
  for (const r of state.roots) walk(r, 0);
  return out;
}

export function renderViewerLines(
  state: ViewerState,
  viewport: Viewport,
): string[] {
  const rows = flattenVisibleRows(state);
  const slice = rows.slice(state.scrollTop, state.scrollTop + viewport.rows);
  return slice.map((row) =>
    renderRow(
      row,
      state.cursorId === row.node.id,
      state.expanded.has(row.node.id),
      viewport.cols,
    ),
  );
}

function renderRow(row: VisibleRow, isCursor: boolean, isExpanded: boolean, cols: number): string {
  const indent = "  ".repeat(row.depth);
  const glyph = chooseGlyph(row.node, isExpanded);
  const marker = isCursor ? "> " : "  ";
  const line = `${marker}${indent}${glyph} ${row.node.summary}`;
  return line.length > cols ? line.slice(0, cols - 1) + "…" : line;
}

function chooseGlyph(node: TreeNode, isExpanded: boolean): string {
  if (node.nodeKind === "event" || node.children.length === 0) return "●";
  return isExpanded ? "▼" : "▶";
}
```

- [ ] **Step 4: Run tests, confirm pass**

- [ ] **Step 5: Commit**

```bash
git add packages/agency-lang/lib/logsViewer/render.ts packages/agency-lang/lib/logsViewer/render.test.ts
git commit -m "logsViewer: render frame from ViewerState (depth indent, glyphs, cursor, clipping)"
```

---

### Task 7 — `input.ts`: keyboard → state transitions

**Files:**
- Create: [packages/agency-lang/lib/logsViewer/input.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/input.ts)
- Test: [packages/agency-lang/lib/logsViewer/input.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/input.test.ts)

The handler is a pure function: `(state, keystroke) → state`. No I/O. The Screen layer adapts terminal events into keystrokes.

Keybindings for v1 (subset of the spec):

| Key | Action |
|---|---|
| `j`, `Down`, `Ctrl+N` | Cursor down |
| `k`, `Up`, `Ctrl+P` | Cursor up |
| `l`, `Right`, `Enter` | Expand node (or move to first child if already expanded) |
| `h`, `Left` | Collapse node (or move to parent if already collapsed) |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `q`, `Ctrl+C` | Quit |

Defer to v2: `e`, `E`, `f`, `/`, `n`, `N`, `y`, `Tab`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { handleKey } from "./input.js";
import { ViewerState, TreeNode } from "./types.js";

const child = (id: string): TreeNode => ({
  id, traceId: "t", parentId: "trace-t", children: [], nodeKind: "span",
  label: id, summary: id,
});

const initial = (cursorId = "trace-t"): ViewerState => ({
  roots: [{
    id: "trace-t", traceId: "t", parentId: null,
    children: [child("a"), child("b")],
    nodeKind: "trace", label: "t", summary: "trace t",
  }],
  expanded: new Set(["trace-t"]),
  cursorId, scrollTop: 0, quit: false,
});

describe("handleKey", () => {
  it("j moves cursor down", () => {
    const next = handleKey(initial("trace-t"), "j");
    expect(next.cursorId).toBe("a");
  });

  it("k moves cursor up", () => {
    const next = handleKey(initial("a"), "k");
    expect(next.cursorId).toBe("trace-t");
  });

  it("q sets quit", () => {
    const next = handleKey(initial(), "q");
    expect(next.quit).toBe(true);
  });

  it("l expands a collapsed node", () => {
    const state = initial("a");
    state.expanded.delete("trace-t");
    state.expanded.delete("a");
    const next = handleKey(state, "l");
    expect(next.expanded.has("a")).toBe(true);
  });

  it("h collapses an expanded node", () => {
    const state = initial("trace-t");
    expect(state.expanded.has("trace-t")).toBe(true);
    const next = handleKey(state, "h");
    expect(next.expanded.has("trace-t")).toBe(false);
  });

  it("h on a collapsed node moves cursor to parent", () => {
    const state = initial("a");
    expect(state.expanded.has("a")).toBe(false);
    const next = handleKey(state, "h");
    expect(next.cursorId).toBe("trace-t");
  });

  it("g jumps to the first visible row", () => {
    const next = handleKey(initial("a"), "g");
    expect(next.cursorId).toBe("trace-t");
    expect(next.scrollTop).toBe(0);
  });

  it("G jumps to the last visible row", () => {
    const next = handleKey(initial("trace-t"), "G");
    expect(next.cursorId).toBe("b");
  });
});
```

- [ ] **Step 2: Run, confirm failing**

- [ ] **Step 3: Implement [input.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/input.ts)**

```ts
import { TreeNode, ViewerState } from "./types.js";
import { flattenVisibleRows } from "./render.js";

export type Key =
  | "j" | "k" | "h" | "l" | "g" | "G" | "q" | "Enter"
  | "Up" | "Down" | "Left" | "Right" | "Ctrl+N" | "Ctrl+P" | "Ctrl+C"
  | string;

export function handleKey(state: ViewerState, key: Key): ViewerState {
  const rows = flattenVisibleRows(state);
  const idx = rows.findIndex((r) => r.node.id === state.cursorId);
  switch (key) {
    case "j": case "Down": case "Ctrl+N":
      return moveCursor(state, rows, Math.min(idx + 1, rows.length - 1));
    case "k": case "Up": case "Ctrl+P":
      return moveCursor(state, rows, Math.max(idx - 1, 0));
    case "g":
      return { ...state, cursorId: rows[0].node.id, scrollTop: 0 };
    case "G":
      return moveCursor(state, rows, rows.length - 1);
    case "l": case "Right": case "Enter":
      return expand(state, rows, idx);
    case "h": case "Left":
      return collapseOrParent(state, rows, idx);
    case "q": case "Ctrl+C":
      return { ...state, quit: true };
    default:
      return state;
  }
}

function moveCursor(
  state: ViewerState,
  rows: ReturnType<typeof flattenVisibleRows>,
  newIdx: number,
): ViewerState {
  return { ...state, cursorId: rows[newIdx].node.id };
}

function expand(
  state: ViewerState,
  rows: ReturnType<typeof flattenVisibleRows>,
  idx: number,
): ViewerState {
  const node = rows[idx].node;
  if (node.children.length === 0) return state;
  const next = new Set(state.expanded);
  next.add(node.id);
  return { ...state, expanded: next };
}

function collapseOrParent(
  state: ViewerState,
  rows: ReturnType<typeof flattenVisibleRows>,
  idx: number,
): ViewerState {
  const node = rows[idx].node;
  if (state.expanded.has(node.id)) {
    const next = new Set(state.expanded);
    next.delete(node.id);
    return { ...state, expanded: next };
  }
  if (node.parentId) {
    return { ...state, cursorId: node.parentId };
  }
  return state;
}
```

- [ ] **Step 4: Run tests, confirm pass**

- [ ] **Step 5: Commit**

```bash
git add packages/agency-lang/lib/logsViewer/input.ts packages/agency-lang/lib/logsViewer/input.test.ts
git commit -m "logsViewer: keyboard handler (j/k navigation, h/l expand/collapse, g/G/q)"
```

---

### Task 8 — `run.ts`: wire everything into a Screen loop

**Files:**
- Create: [packages/agency-lang/lib/logsViewer/run.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts)
- Test: [packages/agency-lang/lib/logsViewer/run.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.test.ts) (integration — uses `ScriptedInput` and `FrameRecorder`)

This is where the viewer becomes interactive. Test it with the scriptable TUI plumbing already in [lib/tui](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui).

- [ ] **Step 1: Look at an existing scripted test to crib the harness**

```bash
cat packages/agency-lang/lib/tui/test/scripted.test.ts
```

Use it as a template — same input/output adapters.

- [ ] **Step 2: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { runViewer } from "./run.js";
import { ScriptedInput, FrameRecorder } from "../tui/index.js";

const sample = [
  {
    format_version: 1, trace_id: "abc", project_id: "p",
    span_id: "s1", parent_span_id: null,
    data: { type: "agentStart", timestamp: "2026-05-16T00:00:00.000Z", entryNode: "main" },
  },
  {
    format_version: 1, trace_id: "abc", project_id: "p",
    span_id: "s1", parent_span_id: null,
    data: { type: "agentEnd", timestamp: "2026-05-16T00:00:01.000Z", timeTaken: 1000 },
  },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("runViewer", () => {
  it("renders, navigates with j, expands with l, quits with q", async () => {
    const input = new ScriptedInput(["j", "l", "q"]);
    const out = new FrameRecorder();
    await runViewer({ jsonl: sample, input, output: out, viewport: { rows: 10, cols: 80 } });
    const frames = out.frames();
    expect(frames.length).toBeGreaterThan(0);
    const lastFrame = frames[frames.length - 1];
    // After expanding the trace, we should see "agentRun" somewhere.
    expect(lastFrame.join("\n")).toMatch(/agentRun/);
  });

  it("shows a helpful message when the file is empty", async () => {
    const input = new ScriptedInput(["q"]);
    const out = new FrameRecorder();
    await runViewer({ jsonl: "", input, output: out, viewport: { rows: 5, cols: 40 } });
    expect(out.frames()[0].join("\n")).toMatch(/no events/i);
  });

  it("shows parse errors as a footer line", async () => {
    const input = new ScriptedInput(["q"]);
    const out = new FrameRecorder();
    const bad = sample + "this is not json\n";
    await runViewer({ jsonl: bad, input, output: out, viewport: { rows: 10, cols: 80 } });
    const frame = out.frames()[0].join("\n");
    expect(frame).toMatch(/1 parse error/);
  });
});
```

(Adjust to whatever the actual `ScriptedInput` / `FrameRecorder` APIs are — read `lib/tui/test/scripted.test.ts` first.)

- [ ] **Step 3: Run, confirm failing**

- [ ] **Step 4: Implement [run.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts)**

Structure:

```ts
import { parseStatelogJsonl } from "./parse.js";
import { buildForest } from "./tree.js";
import { renderViewerLines } from "./render.js";
import { handleKey } from "./input.js";
import { ViewerState } from "./types.js";
import type { Input, Output } from "../tui/index.js"; // exact types per lib/tui

export type RunViewerOpts = {
  jsonl: string;
  input: Input;
  output: Output;
  viewport: { rows: number; cols: number };
};

export async function runViewer(opts: RunViewerOpts): Promise<void> {
  const parsed = parseStatelogJsonl(opts.jsonl);
  const roots = buildForest(parsed.events);
  if (roots.length === 0) {
    opts.output.writeFrame(["No events found."]);
    // Wait for one keystroke so the user can read the message.
    await opts.input.next();
    return;
  }

  let state: ViewerState = {
    roots,
    // Default-expand the only trace if there is exactly one.
    expanded: new Set(roots.length === 1 ? [roots[0].id] : []),
    cursorId: roots[0].id,
    scrollTop: 0,
    quit: false,
  };

  const draw = () => {
    const lines = renderViewerLines(state, opts.viewport);
    if (parsed.errors.length > 0) {
      lines.push(""); // separator
      lines.push(`${parsed.errors.length} parse error(s) — first: line ${parsed.errors[0].line}`);
    }
    opts.output.writeFrame(lines);
  };

  draw();
  while (!state.quit) {
    const key = await opts.input.next();
    state = handleKey(state, key);
    draw();
  }
}
```

(Adjust the `Input` / `Output` interfaces to match what `lib/tui` actually exports; read `lib/tui/index.ts` first.)

- [ ] **Step 5: Run tests, confirm pass**

- [ ] **Step 6: Commit**

```bash
git add packages/agency-lang/lib/logsViewer/run.ts packages/agency-lang/lib/logsViewer/run.test.ts
git commit -m "logsViewer: interactive Screen loop tying parse/build/render/input together"
```

---

### Task 9 — CLI wiring in `agency.ts`

**Files:**
- Create: [packages/agency-lang/lib/cli/logsView.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/cli/logsView.ts)
- Modify: [packages/agency-lang/scripts/agency.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/scripts/agency.ts)
- Test: smoke test — run against a real captured statelog file

- [ ] **Step 1: Implement [lib/cli/logsView.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/cli/logsView.ts)**

```ts
import * as fs from "fs";
import { runViewer } from "../logsViewer/run.js";
import { TerminalInput, TerminalOutput } from "../tui/index.js";

export async function logsView(file: string): Promise<void> {
  if (file === "-") {
    // Read from stdin until EOF, then render.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const jsonl = Buffer.concat(chunks).toString("utf8");
    await runWith(jsonl);
    return;
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  const jsonl = fs.readFileSync(file, "utf8");
  await runWith(jsonl);
}

async function runWith(jsonl: string): Promise<void> {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  const viewport = {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  };
  try {
    await runViewer({ jsonl, input, output, viewport });
  } finally {
    output.close?.();
    input.close?.();
  }
}
```

(Adjust to the actual TerminalInput/TerminalOutput interfaces.)

- [ ] **Step 2: Register the subcommand in [scripts/agency.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/scripts/agency.ts)**

Add the import at the top of the file alongside the other CLI imports:

```ts
import { logsView } from "../lib/cli/logsView.js";
```

Then near line 177 (where `traceCmd` is registered), add a sibling block:

```ts
const logsCmd = program
  .command("logs")
  .description("Inspect StateLog output");

logsCmd
  .command("view")
  .description("Open an interactive TUI viewer for a statelog JSONL file")
  .argument("<file>", "Path to a .statelog.jsonl file, or '-' for stdin")
  .action(async (file: string) => {
    await logsView(file);
  });
```

(Per the project's AGENTS.md, dynamic imports are forbidden — keep the import static at the top of the file.)

- [ ] **Step 3: Build**

```bash
make
```

Expected: clean build, no warnings related to the new command.

- [ ] **Step 4: Smoke test against a real statelog file**

Generate one quickly:

```bash
mkdir -p /tmp/logs-view-smoke
cat > /tmp/logs-view-smoke/agency.json <<'EOF'
{
  "observability": true,
  "log": { "host": "stdout", "logFile": "/tmp/logs-view-smoke/run.jsonl" }
}
EOF
cat > /tmp/logs-view-smoke/main.agency <<'EOF'
node main() {
  return "hello"
}
EOF
pnpm run agency /tmp/logs-view-smoke/main.agency
pnpm run agency logs view /tmp/logs-view-smoke/run.jsonl
```

Manually verify: the viewer opens, shows one trace, `l` expands it, `j`/`k` moves the cursor, `q` quits cleanly.

- [ ] **Step 5: Commit**

```bash
git add packages/agency-lang/lib/cli/logsView.ts packages/agency-lang/scripts/agency.ts
git commit -m "cli: add `agency logs view` for interactive statelog inspection"
```

---

### Task 10 — Documentation

**Files:**
- Create: [packages/agency-lang/docs/site/guide/observability.md](file:///Users/adityabhargava/agency-lang/packages/agency-lang/docs/site/guide/observability.md) (or update an existing one if statelog docs already exist; check first)
- Modify: top-level [README.md](file:///Users/adityabhargava/agency-lang/packages/agency-lang/README.md) if it lists CLI commands

- [ ] **Step 1: Check whether observability docs already exist**

```bash
rg -l "statelog|observability" packages/agency-lang/docs/site/
```

If a relevant file exists, edit it. Otherwise create `observability.md`.

- [ ] **Step 2: Write a short section**

Cover: enabling observability in `agency.json`, where logs go (`logFile`, `host: stdout`), and how to open the viewer:

````markdown
## Inspecting logs

Once you have a `.jsonl` log file, view it interactively:

```bash
agency logs view path/to/run.jsonl
```

Use `j`/`k` to move, `h`/`l` (or arrow keys / Enter) to collapse / expand,
`g`/`G` to jump to top / bottom, and `q` to quit.
````

- [ ] **Step 3: Commit**

```bash
git add packages/agency-lang/docs/...
git commit -m "docs: document `agency logs view` and the statelog viewer keybindings"
```

---

### Task 11 — Final validation

- [ ] **Step 1: Run the full suite**

```bash
make
pnpm test:run 2>&1 | tail -10
node packages/agency-lang/tests/integration/statelog/test.mjs 2>&1 | tail -12
pnpm run lint:structure 2>&1 | tail -10
```

Expected: build clean, all tests pass, structural lint passes (the `lib/lsp/hover.ts` pre-existing error doesn't count).

- [ ] **Step 2: Open the resulting branch as a PR**

```bash
git push -u origin <branch>
gh pr create --base main --head <branch> --title "agency logs view — interactive statelog TUI viewer (v1)" --body-file /tmp/pr-body.md
```

PR body should describe v1 scope (no follow, no search, no JSON-leaf expansion), reference the spec, and link the design discussion.

---

## Validation checklist

Before opening the PR, verify all of:

- [ ] `make` succeeds with no new warnings.
- [ ] `pnpm test:run` shows the previously-known passing count + the new logsViewer tests (≈ 30 new tests across the suite).
- [ ] `pnpm run agency logs view <real-file>` opens, navigates, expands/collapses, and exits cleanly via `q` and `Ctrl+C`.
- [ ] `pnpm run agency logs view -` reads from stdin and renders.
- [ ] `pnpm run agency logs view nonexistent.jsonl` exits with a non-zero code and a useful error message.
- [ ] Files with parse errors render the valid events plus a footer indicating the error count.
- [ ] Single-trace files default-expand the only trace; multi-trace files start with everything collapsed.

## Out of scope for v1 (deferred to v2)

- `--follow` / tail mode (file watcher, byte-offset tracking, auto-scroll).
- `/`-search + `n`/`N` jumping.
- `e` / `E` (expand-all / collapse-all).
- JSON-leaf collapsible payload renderer (fx-style). Leaves currently show only the summary line; the v2 work expands the leaf into a nested object/array tree.
- `y` (copy node JSON to clipboard).
- `Tab` (cycle traces).
- Color coding by magnitude (durations, costs).
- Timeline / Gantt view.
- Bookmarks, diff mode, filter panel.

Each of these is a self-contained follow-up PR.
