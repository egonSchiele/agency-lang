# Statelog Parser Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the statelog parser out of `lib/eval/` into a general-purpose model at `lib/statelogParser.ts`, give it a query API (hierarchy, `getNodeById`, `llmCalls()`, `trace(id)` scoping), and refactor `agency logs view` to consume it as its MVC "model".

**Architecture:** The parser is the data layer ("model"): it parses the JSONL tolerantly, builds a trace→span→event node hierarchy with rolled-up metrics, and exposes typed queries. Payloads are fetched lazily through an accessor (`eventOf`) so a future indexed backend can drop in unchanged. The logs viewer works in terms of a `TreeNode` **class** that creates the parser internally (`TreeNode.forestFromLog(path)`) and exposes a lazy `node.event()` — the parser is hidden from the viewer. The render loop, input reducer, scroll math, and search logic are preserved.

**Tech Stack:** TypeScript, vitest (unit tests), the existing `lib/statelog/wireTypes.ts` + `wireAccessors.ts`, the existing `lib/tui/` toolkit.

**Reference docs:** `docs/superpowers/specs/2026-06-14-statelog-parser-refactor-design.md` (design), `docs/dev/statelog-parser-memory-model.md` (memory-model decision).

**Conventions:**
- Run a single vitest file with `pnpm test:run <path>` (e.g. `pnpm test:run lib/statelogParser.test.ts`). These are unit tests — NOT the agency execution suite.
- Per repo rules: objects not Maps, arrays not Sets, `type` not `interface`, no dynamic imports.
- Commit messages: write the message to a temp file and `git commit -F`, never inline (apostrophes break the shell). End with the Co-Authored-By trailer.
- We are on `main`. Before the first commit, create a branch (Task 0).

---

## File Structure

**New:**
- `lib/statelogParser.ts` — the general parser/model (moved from `lib/eval/statelogParser.ts`, then extended).
- `lib/statelogParser.test.ts` — parser unit tests.
- `lib/logsViewer/treeNode.ts` — the `TreeNode` **class**: view-tree node that owns a hidden `StatelogParser`, with static entry points `TreeNode.forestFromLog(path)` / `forestFromString(jsonl)` and a lazy `event()` accessor.
- `lib/logsViewer/treeNode.test.ts` — `TreeNode` unit tests.

**Modified:**
- `lib/cli/eval/run.ts`, `lib/cli/evalExtract.ts`, `lib/stdlib/agencyEval.ts`, `lib/stdlib/statelog.ts` — switch to `StatelogParser.fromFile(...)`.
- `lib/logsViewer/render.ts` — synthetic-row creation builds `TreeNode` instances; expansion reads payloads via `node.event()` (no more `TreeNode.event` field, no threaded accessor).
- `lib/logsViewer/search.ts` — `findMatches` walks synthetic rows via `node.event()`.
- `lib/logsViewer/input.ts` — unchanged signatures (no `getEvent` to thread).
- `lib/logsViewer/run.ts` — `runViewer` takes a `source` ({path}|{jsonl}); builds the forest via `TreeNode.forestFromLog`/`forestFromString`; follow re-calls the builder.
- `lib/cli/logsView.ts` — passes a `source` to `runViewer`; never touches `StatelogParser`.
- `lib/logsViewer/types.ts` — `ViewerState` imports `TreeNode` from `treeNode.ts`; old `TreeNode` type + `event` field removed.
- `docs/dev/` — note the new parser home.

**Deleted (Task 8):**
- `lib/logsViewer/parse.ts` + `lib/logsViewer/parse.test.ts` (folded into the parser).
- `buildForest` + helpers in `lib/logsViewer/tree.ts` (moved to the parser).
- `lib/eval/statelogParser.ts` + `lib/eval/statelogParser.test.ts` (moved).

---

## Task 0: Branch

- [ ] **Step 1: Create the working branch**

Run:
```bash
git checkout -b statelog-parser-refactor
```
Expected: `Switched to a new branch 'statelog-parser-refactor'`

---

## Task 1: Move the parser to `lib/statelogParser.ts`

Pure move + import-path fixes. No behavior change; the existing eval tests are the safety net.

**Files:**
- Move: `lib/eval/statelogParser.ts` → `lib/statelogParser.ts`
- Move: `lib/eval/statelogParser.test.ts` → `lib/statelogParser.test.ts`
- Modify: `lib/cli/eval/run.ts:11`, `lib/cli/evalExtract.ts:3`, `lib/stdlib/agencyEval.ts:10`, `lib/stdlib/statelog.ts:2`

- [ ] **Step 1: Move the files with git**

Run:
```bash
git mv lib/eval/statelogParser.ts lib/statelogParser.ts
git mv lib/eval/statelogParser.test.ts lib/statelogParser.test.ts
```

- [ ] **Step 2: Fix the moved file's internal imports**

In `lib/statelogParser.ts`, the imports were relative to `lib/eval/`. Update them to be relative to `lib/`:

```ts
import type { EventEnvelope } from "./statelog/wireTypes.js";
import { extractEvalRecord, type ExtractOptions } from "./eval/extract.js";
import { normalize, type Normalized } from "./eval/normalize.js";
import { readAllEventsSync } from "./eval/parseJsonl.js";
import type {
  ErrorEntry,
  EvalRecord,
  EvalValue,
  IncompleteInvocation,
  InterruptEntry,
  Metrics,
  NormalizedEvent,
  ThreadEntry,
} from "./eval/types.js";
```

- [ ] **Step 3: Fix the moved test's import**

In `lib/statelogParser.test.ts`, change:
```ts
import { StatelogParser } from "./statelogParser.js";
```
(It already imports from `./statelogParser.js`, which now resolves to the new location — confirm the relative path is still `./statelogParser.js` and any fixture paths still resolve. Fixtures are referenced by absolute/`__dirname`-relative paths; verify they still point at the right files.)

- [ ] **Step 4: Update the four consumer imports**

`lib/cli/eval/run.ts:11`:
```ts
import { StatelogParser } from "@/statelogParser.js";
```
`lib/cli/evalExtract.ts:3`:
```ts
import { StatelogParser } from "../statelogParser.js";
```
`lib/stdlib/agencyEval.ts:10`:
```ts
import { StatelogParser } from "../statelogParser.js";
```
`lib/stdlib/statelog.ts:2`:
```ts
import { StatelogParser } from "../statelogParser.js";
```

- [ ] **Step 5: Run the moved parser tests**

Run: `pnpm test:run lib/statelogParser.test.ts`
Expected: PASS (same tests as before, new location).

- [ ] **Step 6: Run the consumer-adjacent tests to confirm imports resolve**

Run: `pnpm test:run lib/cli/evalExtract`
Expected: PASS (or "no test found" for files without tests — in that case run `pnpm test:run lib/eval` to confirm the eval suite still compiles and passes).

- [ ] **Step 7: Commit**

```bash
printf '%s\n' "refactor: move StatelogParser to lib/statelogParser.ts" "" "Pure move + import-path fixes; no behavior change." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/commit-msg.txt
git add -A
git commit -F /tmp/commit-msg.txt
```

---

## Task 2: Tolerant parsing — `parseErrors()` and `fromString()`

Fold the logs viewer's tolerant validation (`lib/logsViewer/parse.ts`) into the parser so it collects errors instead of throwing, and add a string constructor for the stdin path.

**Files:**
- Modify: `lib/statelogParser.ts`
- Test: `lib/statelogParser.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/statelogParser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { StatelogParser } from "./statelogParser.js";

describe("StatelogParser tolerant parsing", () => {
  const line = (o: object) => JSON.stringify(o);
  const good = (over: object = {}) =>
    line({ format_version: 1, trace_id: "t1", project_id: "p", span_id: null,
           parent_span_id: null, data: { type: "agentStart", timestamp: "2026-06-14T00:00:00Z" }, ...over });

  it("fromString parses well-formed lines with no errors", () => {
    const p = StatelogParser.fromString([good(), good()].join("\n"));
    expect([...p.events()]).toHaveLength(2);
    expect(p.parseErrors()).toHaveLength(0);
  });

  it("collects malformed-JSON errors instead of throwing", () => {
    const p = StatelogParser.fromString([good(), "{ not json", good()].join("\n"));
    expect([...p.events()]).toHaveLength(2);
    expect(p.parseErrors()).toHaveLength(1);
    expect(p.parseErrors()[0]).toMatchObject({ line: 2, kind: "invalid_json" });
  });

  it("rejects unsupported format_version as an error", () => {
    const p = StatelogParser.fromString(line({ format_version: 2, trace_id: "t", project_id: "p",
      span_id: null, parent_span_id: null, data: { type: "x", timestamp: "" } }));
    expect([...p.events()]).toHaveLength(0);
    expect(p.parseErrors()[0]).toMatchObject({ kind: "unsupported_version" });
  });

  it("rejects rows missing trace_id or data.type", () => {
    const p = StatelogParser.fromString(line({ format_version: 1, project_id: "p",
      span_id: null, parent_span_id: null, data: { timestamp: "" } }));
    expect(p.parseErrors()[0]).toMatchObject({ kind: "missing_fields" });
  });

  it("treats missing format_version as legacy v1", () => {
    const p = StatelogParser.fromString(line({ trace_id: "t", project_id: "p", span_id: null,
      parent_span_id: null, data: { type: "agentStart", timestamp: "" } }));
    expect([...p.events()]).toHaveLength(1);
    expect(p.parseErrors()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/statelogParser.test.ts`
Expected: FAIL — `StatelogParser.fromString is not a function` / `p.parseErrors is not a function`.

- [ ] **Step 3: Add the tolerant parse + new entry points**

In `lib/statelogParser.ts`, add the `ParseError` type and a tolerant parse function (ported from `lib/logsViewer/parse.ts`), and wire it into the class. The parser now stores events + errors instead of calling `readAllEventsSync` directly:

```ts
const SUPPORTED_VERSION = 1;

export type ParseError = {
  line: number;
  kind: "invalid_json" | "missing_fields" | "unsupported_version";
  detail: string;
};

type ParsedEvent = { event: EventEnvelope; lineNo: number };
type ParseResult = { events: ParsedEvent[]; errors: ParseError[] };

function parseStatelogText(text: string): ParseResult {
  const events: EventEnvelope[] = [];
  const errors: ParseError[] = [];
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (raw.trim() === "") continue;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      errors.push({ line: i + 1, kind: "invalid_json", detail: (e as Error).message });
      continue;
    }
    const rawVersion = obj.format_version;
    if (rawVersion !== undefined && typeof rawVersion !== "number") {
      errors.push({ line: i + 1, kind: "unsupported_version",
        detail: `format_version must be a number, got ${typeof rawVersion}` });
      continue;
    }
    const version: number = rawVersion ?? 1;
    if (version > SUPPORTED_VERSION) {
      errors.push({ line: i + 1, kind: "unsupported_version",
        detail: `format_version ${version} > ${SUPPORTED_VERSION}` });
      continue;
    }
    if (!obj.trace_id || !obj.data || typeof obj.data.type !== "string") {
      errors.push({ line: i + 1, kind: "missing_fields", detail: "missing trace_id or data.type" });
      continue;
    }
    events.push({
      event: {
        format_version: version,
        trace_id: obj.trace_id,
        project_id: obj.project_id ?? "",
        span_id: obj.span_id ?? null,
        parent_span_id: obj.parent_span_id ?? null,
        data: obj.data,
      },
      lineNo: i + 1,
    });
  }
  return { events, errors };
}
```

The `lineNo` is captured here once (1-based source line) — it is the stable
identity for event nodes (`evt:<lineNo>`) and is what `lines()` yields. No later
task re-shapes `ParseResult`.

Replace the lazy `readAllEventsSync` cache with eager parsing. Use **one**
construction path — a single private constructor that takes already-loaded text,
plus two named factories. This is the only place file-vs-string source is
decided; no field is set out of band.

```ts
export class StatelogParser {
  private readonly parsed: ParseResult;
  private normalizedCache?: Normalized;
  private evalRecordCache?: EvalRecord;

  // The ONLY constructor. Both factories funnel through it, so there is a
  // single place where `text`/`filePath`/`parsed` are established together.
  private constructor(
    private text: string,
    private readonly filePath: string | null,
    private readonly options: StatelogParserOptions = {},
  ) {
    this.parsed = parseStatelogText(text);
  }

  static fromFile(filePath: string, options: StatelogParserOptions = {}): StatelogParser {
    return new StatelogParser(fs.readFileSync(filePath, "utf-8"), filePath, options);
  }

  static fromString(jsonl: string, options: StatelogParserOptions = {}): StatelogParser {
    return new StatelogParser(jsonl, null, options);
  }

  *events(): Iterable<EventEnvelope> {
    for (const p of this.parsed.events) yield p.event;
  }

  parseErrors(): ParseError[] {
    return this.parsed.errors;
  }
  // ... normalized()/evalRecord()/eval methods below; internal code that needs
  //     an array uses `[...this.events()]` or `this.parsed.events.map(p => p.event)`.
}
```

Add `import * as fs from "fs";` at the top, and **remove the now-unused
`readAllEventsSync` import** (Task 1's import list) — `parseStatelogText` replaces
it as the parser's JSONL reader. Update `normalized()` to feed
`this.parsed.events.map((p) => p.event)`. Preserve eval's strict contract: in
`evalRecord()`, before extracting, throw if there were any parse errors:

```ts
evalRecord(): EvalRecord {
  if (this.parseErrors().length > 0) {
    const first = this.parseErrors()[0];
    throw new Error(`Malformed statelog on line ${first.line}: ${first.detail}`);
  }
  if (!this.evalRecordCache) {
    const events = this.parsed.events.map((p) => p.event);
    assertSingleTrace(events);
    this.evalRecordCache = extractEvalRecord(events, this.filePath ?? "<string>", this.options);
  }
  return this.evalRecordCache;
}
```

- [ ] **Step 4: Migrate the four consumers to `StatelogParser.fromFile(...)`**

The constructor is now private, so the 4 consumers switch from
`new StatelogParser(path)` to `StatelogParser.fromFile(path)` (a one-line change
each — explicit and consistent, no construction back-door):

- `lib/cli/eval/run.ts:210` → `StatelogParser.fromFile(statelogPath).evalRecord()`
- `lib/cli/evalExtract.ts:17` → `StatelogParser.fromFile(file, { ... })`
- `lib/stdlib/agencyEval.ts:110, 150` → `StatelogParser.fromFile(...)`
- `lib/stdlib/statelog.ts:64, 72, 80, 88` → `StatelogParser.fromFile(...)`

The existing parser tests that do `new StatelogParser(path)` also switch to
`StatelogParser.fromFile(path)`.

- [ ] **Step 5: Run the parser tests**

Run: `pnpm test:run lib/statelogParser.test.ts`
Expected: PASS (new tolerant tests + the original eval-facade tests).

- [ ] **Step 6: Commit**

```bash
printf '%s\n' "feat(statelogParser): tolerant parsing + fromString()" "" "Folds the logs viewer parse validation into the parser; collects ParseError[] instead of throwing. Eval methods still throw on malformed input." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/commit-msg.txt
git add -A
git commit -F /tmp/commit-msg.txt
```

---

## Task 3: Build the node hierarchy

Move the structural half of `buildForest` into the parser, producing `StatelogNode` (no view fields), with `getNodeById`, `traces()`, `trace()`, `onlyTrace()`. Leaf `summary` is computed here as plain text (grep-able, lightweight) so the view never needs the payload to render a collapsed row.

**Files:**
- Modify: `lib/statelogParser.ts`
- Test: `lib/statelogParser.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/statelogParser.test.ts`:

```ts
describe("StatelogParser hierarchy", () => {
  const env = (over: Partial<EventEnvelope>): EventEnvelope => ({
    format_version: 1, trace_id: "t1", project_id: "p", span_id: null,
    parent_span_id: null, data: { type: "debug", timestamp: "2026-06-14T00:00:00Z" }, ...over,
  });
  const toJsonl = (evts: EventEnvelope[]) => evts.map((e) => JSON.stringify(e)).join("\n");

  it("returns one trace per trace_id", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ trace_id: "a" }), env({ trace_id: "b" }), env({ trace_id: "a" }),
    ]));
    expect(p.traces().map((t) => t.traceId).sort()).toEqual(["a", "b"]);
  });

  it("nests span children under their parent span (order-independent)", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ span_id: "s2", parent_span_id: "s1", data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:01Z" } }),
      env({ span_id: "s1", parent_span_id: null, data: { type: "agentStart", timestamp: "2026-06-14T00:00:00Z" } }),
    ]));
    const root = p.onlyTrace().root();
    const s1 = root.children.find((c) => c.id === "s1")!;
    expect(s1.kind).toBe("span");
    expect(s1.children.some((c) => c.id === "s2")).toBe(true);
  });

  it("getNodeById finds spans and events", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ span_id: "s1", data: { type: "toolCall", timestamp: "2026-06-14T00:00:00Z", toolName: "grep", timeTaken: 1200 } }),
    ]));
    expect(p.getNodeById("s1")?.kind).toBe("span");
    // event id is line-derived
    const evtNode = p.getNodeById("evt:1");
    expect(evtNode?.kind).toBe("event");
    expect(evtNode?.summary).toContain("grep");
  });

  it("rolls tokens/cost up onto spans", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ span_id: "s1", data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:00Z",
        timeTaken: 1000, usage: { inputTokens: 100, outputTokens: 50 }, cost: { totalCost: 0.01 } } }),
    ]));
    const s1 = p.getNodeById("s1")!;
    expect(s1.metrics?.tokens).toBe(150);
    expect(s1.metrics?.cost).toBeCloseTo(0.01);
  });

  it("onlyTrace throws when multiple traces present", () => {
    const p = StatelogParser.fromString(toJsonl([env({ trace_id: "a" }), env({ trace_id: "b" })]));
    expect(() => p.onlyTrace()).toThrow(/multiple trace/i);
  });
});
```

Add `import type { EventEnvelope } from "./statelog/wireTypes.js";` to the test imports if not present.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/statelogParser.test.ts`
Expected: FAIL — `p.traces is not a function`.

- [ ] **Step 3: Add the node types + builder**

In `lib/statelogParser.ts`, add the model types and a `buildNodes` function adapted from `lib/logsViewer/tree.ts`. Reuse `wireAccessors` where possible. Key differences from `buildForest`: produce `StatelogNode` (no glyphs/colors), assign event ids as `evt:<lineNo>`, store a plain-text `summary`, store `metrics` as an object, and keep an `id → node` index plus `id → EventEnvelope` index.

```ts
import { summarizeEvent, spanLabelOf, summarizeSpanText, summarizeTraceText } from "./statelog/summarize.js";

export type NodeKind = "trace" | "span" | "event";

export type NodeMetrics = {
  tokens?: number; cost?: number; durationMs?: number; firstTs?: number;
};

export type StatelogNode = {
  id: string;                 // trace:<traceId> | <span_id> | evt:<lineNo>
  kind: NodeKind;
  traceId: string;
  parentId: string | null;
  children: StatelogNode[];
  label: string;              // span type / event type / trace id
  summary: string;            // plain-text one-liner (grep-able)
  metrics?: NodeMetrics;
  lineNo?: number;            // events only — used by eventOf()
};
```

Port the four `buildForest` passes into `buildNodes(events: ParsedEvent[]): { roots; byId; eventByLine }`. Each `ParsedEvent` already carries its 1-based `lineNo` (captured in Task 2), so event ids are stable with no extra bookkeeping.

Adjust `StatelogNode` event creation: `id: \`evt:${lineNo}\``, `lineNo`, `summary: summarizeEvent(event)`, `label: event.data.type`. Spans: `id: span_id`, `label: spanLabelOf(introEvent)`, `summary` set after metric roll-up via `summarizeSpanText(node)`. Traces: `id: \`trace:${traceId}\``, `summary: summarizeTraceText(node)`. Metric roll-up reuses the `aggregateMetrics` logic from `tree.ts` but writes into `node.metrics`.

> NOTE: `summarizeEvent`/`spanLabelOf`/`summarizeSpanText`/`summarizeTraceText` are the **plain-text** functions. In Task 8 we move them from `lib/logsViewer/summary.ts` + `tree.ts` into a new `lib/statelog/summarize.ts`. For THIS task, create `lib/statelog/summarize.ts` now and move the plain `summarize`, `summarizeSpan`, `summarizeTrace`, and `inferSpanLabel` bodies there (renamed: `summarizeEvent`, `summarizeSpanText`, `summarizeTraceText`, `spanLabelOf`). Leave the **styled** variants (`summarizeSpanStyled`, `summarizeTraceStyled`) in `lib/logsViewer/summary.ts`; re-point them to import the shared text helpers. The viewer's `tree.ts` keeps importing `summarize` from `summary.ts` until Task 6/8 — re-export it from `summary.ts` to avoid breaking it mid-refactor.

Add the class methods + `TraceView`:

```ts
private nodesCache?: { roots: StatelogNode[]; byId: Record<string, StatelogNode>; eventByLine: Record<number, EventEnvelope> };

private nodes() {
  if (!this.nodesCache) this.nodesCache = buildNodes(this.parsed.events);
  return this.nodesCache;
}

getNodeById(id: string): StatelogNode | undefined {
  return this.nodes().byId[id];
}

eventOf(id: string): EventEnvelope | undefined {
  const node = this.getNodeById(id);
  if (!node || node.lineNo === undefined) return undefined;
  return this.nodes().eventByLine[node.lineNo];
}

traces(): TraceView[] {
  return this.nodes().roots.map((r) => new TraceView(this, r));
}

trace(traceId: string): TraceView {
  const root = this.nodes().roots.find((r) => r.traceId === traceId);
  if (!root) throw new Error(`No trace with id ${traceId}`);
  return new TraceView(this, root);
}

onlyTrace(): TraceView {
  const roots = this.nodes().roots;
  if (roots.length > 1) {
    throw new Error(`multiple traces in input (${roots.map((r) => r.traceId).join(", ")}). Exactly one supported.`);
  }
  if (roots.length === 0) throw new Error("no traces in input");
  return new TraceView(this, roots[0]);
}
```

`TraceView` is a **class** — a query scoped to one trace, mirroring the parser's
query methods so `parser.trace(id).llmCalls()` reads the same as `parser.llmCalls()`:

```ts
export class TraceView {
  constructor(
    private readonly parser: StatelogParser,
    private readonly rootNode: StatelogNode,
  ) {}

  get traceId(): string {
    return this.rootNode.traceId;
  }

  root(): StatelogNode {
    return this.rootNode;
  }

  getNodeById(id: string): StatelogNode | undefined {
    const n = this.parser.getNodeById(id);
    return n && n.traceId === this.rootNode.traceId ? n : undefined;
  }

  llmCalls(): LlmCall[] {     // added in Task 4
    return this.parser.llmCalls().filter((c) => c.traceId === this.rootNode.traceId);
  }

  toolCalls(): ToolCall[] {   // added in Task 4
    return this.parser.toolCalls().filter((c) => c.traceId === this.rootNode.traceId);
  }
}
```

(`llmCalls`/`toolCalls` lean on `parser.llmCalls()`/`parser.toolCalls()`, added in
Task 4. If implementing strictly task-by-task, define the class with only
`traceId`/`root`/`getNodeById` in this task and add the two query methods in
Task 4. The plan shows the final shape.)

- [ ] **Step 4: Run the hierarchy tests**

Run: `pnpm test:run lib/statelogParser.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the viewer still builds (it still uses its own tree.ts)**

Run: `pnpm test:run lib/logsViewer/tree.test.ts`
Expected: PASS (unchanged — `tree.ts` still has `buildForest` and imports `summarize` re-exported from `summary.ts`).

- [ ] **Step 6: Commit**

```bash
printf '%s\n' "feat(statelogParser): trace/span/event hierarchy + getNodeById" "" "Adds StatelogNode tree, metric roll-ups, traces()/trace()/onlyTrace(). Plain-text summary helpers moved to lib/statelog/summarize.ts." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/commit-msg.txt
git add -A
git commit -F /tmp/commit-msg.txt
```

---

## Task 4: Typed queries + iteration accessors

Add `llmCalls()`, `toolCalls()`, `lines()`, and finalize the `events()` Iterable contract. These read through `wireAccessors` (never `data.foo` directly).

**Files:**
- Modify: `lib/statelogParser.ts`
- Test: `lib/statelogParser.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("StatelogParser typed queries", () => {
  const env = (over: Partial<EventEnvelope>): EventEnvelope => ({
    format_version: 1, trace_id: "t1", project_id: "p", span_id: null,
    parent_span_id: null, data: { type: "debug", timestamp: "2026-06-14T00:00:00Z" }, ...over,
  });
  const toJsonl = (e: EventEnvelope[]) => e.map((x) => JSON.stringify(x)).join("\n");

  it("llmCalls returns model/tokens/cost for promptCompletion events", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:00Z",
        model: '"gpt-x"', usage: { inputTokens: 10, outputTokens: 5 }, cost: { totalCost: 0.002 } } }),
    ]));
    const calls = p.llmCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "gpt-x", tokensIn: 10, tokensOut: 5, cost: 0.002 });
  });

  it("toolCalls returns the tool name", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ data: { type: "toolCall", timestamp: "2026-06-14T00:00:00Z", toolName: "grep", timeTaken: 30 } }),
    ]));
    expect(p.toolCalls().map((t) => t.toolName)).toEqual(["grep"]);
  });

  it("trace(id).llmCalls() scopes to that trace", () => {
    const p = StatelogParser.fromString(toJsonl([
      env({ trace_id: "a", data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:00Z", model: '"m"' } }),
      env({ trace_id: "b", data: { type: "promptCompletion", timestamp: "2026-06-14T00:00:00Z", model: '"m"' } }),
    ]));
    expect(p.trace("a").llmCalls()).toHaveLength(1);
    expect(p.llmCalls()).toHaveLength(2);
  });

  it("lines() yields each parsed event with its source line number", () => {
    const p = StatelogParser.fromString(toJsonl([env({}), env({})]));
    expect([...p.lines()].map((l) => l.lineNo)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/statelogParser.test.ts`
Expected: FAIL — `p.llmCalls is not a function`.

- [ ] **Step 3: Implement the queries**

In `lib/statelogParser.ts`, using `wireAccessors`:

```ts
import { byType, modelOf, tokensIn, tokensOut, cost, toolNameOf, timestampMs } from "./statelog/wireAccessors.js";

export type LlmCall = {
  traceId: string; spanId: string | null; model: string;
  tokensIn: number; tokensOut: number; cost: number; tMs: number;
};
export type ToolCall = {
  traceId: string; spanId: string | null; toolName: string; tMs: number;
};

// in the class:
llmCalls(): LlmCall[] {
  return byType([...this.events()], "promptCompletion").map((e) => ({
    traceId: e.trace_id, spanId: e.span_id, model: modelOf(e),
    tokensIn: tokensIn(e), tokensOut: tokensOut(e), cost: cost(e), tMs: timestampMs(e),
  }));
}

toolCalls(): ToolCall[] {
  return byType([...this.events()], "toolCall").map((e) => ({
    traceId: e.trace_id, spanId: e.span_id, toolName: toolNameOf(e), tMs: timestampMs(e),
  }));
}

*lines(): Iterable<{ lineNo: number; event: EventEnvelope }> {
  for (const p of this.parsed.events) yield { lineNo: p.lineNo, event: p.event };
}
```

(`events()` is already defined as a generator in Task 2; `lines()` is its
line-numbered sibling. Both honor the streaming-ready `Iterable` contract.)

Fill in the `TraceView` `llmCalls`/`toolCalls` from Task 3 Step 3.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:run lib/statelogParser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
printf '%s\n' "feat(statelogParser): llmCalls/toolCalls/lines typed queries" "" "Typed queries read through wireAccessors; scoped variants on TraceView." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/commit-msg.txt
git add -A
git commit -F /tmp/commit-msg.txt
```

---

## Task 5: `TreeNode` class with a hidden parser + lazy `event()`

`TreeNode` becomes a class. Its static entry points (`forestFromLog`/`forestFromString`) create a `StatelogParser` **internally** — the parser is an implementation detail, hidden from callers. Each node carries a (private) reference to that parser and exposes a lazy `event()` accessor, which **replaces** the previously-threaded `getEvent` parameter. Payloads still never live in the persistent forest (lazy fetch via the owned parser).

**Files:**
- Create: `lib/logsViewer/treeNode.ts`, `lib/logsViewer/treeNode.test.ts`
- Modify: `lib/logsViewer/types.ts`, `lib/logsViewer/render.ts`, `lib/logsViewer/search.ts`

- [ ] **Step 1: Write the failing test**

`lib/logsViewer/treeNode.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { TreeNode } from "./treeNode.js";

const env = (o: object) => JSON.stringify({ format_version: 1, trace_id: "t1", project_id: "p",
  span_id: null, parent_span_id: null, data: { type: "agentStart", timestamp: "2026-06-14T00:00:00Z" }, ...o });

describe("TreeNode.forestFromString", () => {
  it("builds a tree, hides graph events, and lazily fetches payloads", () => {
    const roots = TreeNode.forestFromString([
      env({ span_id: "s1", data: { type: "toolCall", timestamp: "2026-06-14T00:00:00Z", toolName: "grep", timeTaken: 12 } }),
      env({ span_id: "s1", data: { type: "graph", timestamp: "2026-06-14T00:00:00Z", nodes: [], edges: {}, startNode: "x" } }),
    ].join("\n"));
    expect(roots).toHaveLength(1);

    const labels: string[] = [];
    const walk = (n: TreeNode) => { labels.push(n.label); n.children.forEach(walk); };
    roots.forEach(walk);
    expect(labels).not.toContain("graph");      // graph hidden
    expect(labels).toContain("toolCall");

    // event() lazily returns the underlying payload; never stored on the node.
    const findKind = (n: TreeNode, k: string): TreeNode | undefined =>
      n.nodeKind === k ? n : n.children.map((c) => findKind(c, k)).find(Boolean);
    const leaf = roots.map((r) => findKind(r, "event")).find(Boolean)!;
    expect(leaf.event()?.data.type).toBe("toolCall");
  });

  it("exposes file-level parse errors via any node", () => {
    const roots = TreeNode.forestFromString([env({}), "{ bad json"].join("\n"));
    expect(roots[0].parseErrors()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/logsViewer/treeNode.test.ts`
Expected: FAIL — cannot find `./treeNode.js`.

- [ ] **Step 3: Write the `TreeNode` class**

`lib/logsViewer/treeNode.ts`:
```ts
import { StatelogParser } from "../statelogParser.js";
import type { StatelogNode } from "../statelogParser.js";
import type { EventEnvelope } from "../statelog/wireTypes.js";
import type { ParseError } from "../statelogParser.js";

export type NodeKind = "trace" | "span" | "event" | "jsonLine" | "convoLine" | "rawDataToggle";

// Event types the viewer hides (a VIEW concern; the model keeps them).
const HIDDEN_EVENT_TYPES = new Set<string>(["graph"]);

export class TreeNode {
  id!: string;
  traceId!: string;
  parentId!: string | null;
  children: TreeNode[] = [];
  nodeKind!: NodeKind;
  label = "";
  summary = "";
  duration?: number;
  tokens?: number;
  cost?: number;
  firstTs?: number;
  lineNo?: number;
  // Hidden model handle — powers event()/parseErrors(). Absent on synthetic
  // rows; `source` lets a rawDataToggle delegate event() back to its leaf.
  private parser?: StatelogParser;
  private source?: TreeNode;

  constructor(init: Partial<TreeNode> & { parser?: StatelogParser; source?: TreeNode }) {
    Object.assign(this, init);
    this.children ??= [];
  }

  // ── public entry points (parser hidden) ───────────────────────────────
  static forestFromLog(path: string): TreeNode[] {
    return TreeNode.forestFrom(StatelogParser.fromFile(path));
  }

  static forestFromString(jsonl: string): TreeNode[] {
    return TreeNode.forestFrom(StatelogParser.fromString(jsonl));
  }

  private static forestFrom(parser: StatelogParser): TreeNode[] {
    return parser.traces().map((t) => TreeNode.fromModel(t.root(), parser));
  }

  private static fromModel(node: StatelogNode, parser: StatelogParser): TreeNode {
    const tn = new TreeNode({
      id: node.id, traceId: node.traceId, parentId: node.parentId,
      nodeKind: node.kind, label: node.label, summary: node.summary,
      duration: node.metrics?.durationMs, tokens: node.metrics?.tokens,
      cost: node.metrics?.cost, firstTs: node.metrics?.firstTs, lineNo: node.lineNo,
      parser,
    });
    tn.children = node.children
      .filter((c) => !(c.kind === "event" && HIDDEN_EVENT_TYPES.has(c.label)))
      .map((c) => TreeNode.fromModel(c, parser));
    return tn;
  }

  // Synthetic view rows (no model payload of their own).
  static syntheticLine(parent: TreeNode, id: string, nodeKind: NodeKind, summary: string): TreeNode {
    return new TreeNode({ id, traceId: parent.traceId, parentId: parent.id, nodeKind, summary });
  }

  // The "raw data" toggle delegates event() back to the leaf it was spawned from.
  static rawDataToggle(leaf: TreeNode): TreeNode {
    return new TreeNode({ id: `${leaf.id}:raw`, traceId: leaf.traceId, parentId: leaf.id,
      nodeKind: "rawDataToggle", label: "raw data", summary: "raw data", source: leaf });
  }

  // ── lazy model access (parser stays hidden) ───────────────────────────
  event(): EventEnvelope | undefined {
    if (this.source) return this.source.event();
    return this.parser?.eventOf(this.id);
  }

  parseErrors(): ParseError[] {
    return this.parser?.parseErrors() ?? [];
  }
}
```

(Export `ParseError` from `lib/statelogParser.ts` if not already — it was defined there in Task 2.)

- [ ] **Step 4: Point `types.ts` at the class**

In `lib/logsViewer/types.ts`: delete the old `TreeNode` type (and its `event?: EventEnvelope` field), and `import { TreeNode } from "./treeNode.js";` for `ViewerState` to reference. Re-export it (`export type { TreeNode } from "./treeNode.js";`) so existing `import { TreeNode } from "./types.js"` sites keep working.

- [ ] **Step 5: Build synthetic rows as `TreeNode` instances; read payloads via `event()`**

In `lib/logsViewer/render.ts`:
- `flattenVisibleRows(state)` keeps its single-argument signature (no `getEvent`). Where it expands an event leaf, fetch the payload once: `const ev = node.event(); if (ev) { ...build convo/json children... }`.
- `promptCompletionChildren(leaf, ev, depth, cols)` and `jsonLineChildren(parent, ev)` take the `EventEnvelope` explicitly. Construct their rows with `TreeNode.syntheticLine(...)`; build the toggle with `TreeNode.rawDataToggle(leaf)`.
- When an expanded `rawDataToggle` is encountered, get its payload via `toggle.event()` (delegates to the source leaf) and build json children.
- `renderRowText` is unchanged (uses `node.summary` + styled metrics; no payload).

- [ ] **Step 6: Update search to use `event()`**

In `lib/logsViewer/search.ts`, `findMatches(roots, query, cols?)` (no `getEvent` param): where it walks an event leaf's synthetic children, fetch `node.event()`; skip expansion when it returns undefined. The toggle's json rows come from `toggle.event()`.

- [ ] **Step 7: Update the render/search tests to build real nodes**

In `render.test.ts` and `search.test.ts`, build inputs with `TreeNode.forestFromString(jsonl)` instead of hand-rolled node literals + stubs. `input.test.ts` is unaffected (no signature change). Keep all existing assertions.

- [ ] **Step 8: Run the viewer unit tests**

Run: `pnpm test:run lib/logsViewer/treeNode.test.ts lib/logsViewer/render.test.ts lib/logsViewer/search.test.ts lib/logsViewer/input.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
printf '%s\n' "refactor(logsViewer): TreeNode class hides the parser" "" "TreeNode.forestFromLog/forestFromString create the parser internally; lazy node.event() replaces the threaded getEvent accessor. Payloads stay out of the persistent forest." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/commit-msg.txt
git add -A
git commit -F /tmp/commit-msg.txt
```

---

## Task 6: Wire `TreeNode.forestFromLog` into `runViewer` + `logsView`

Replace `parseStatelogJsonl` + `buildForest` in `run.ts` with `TreeNode.forestFromLog`/`forestFromString`. The viewer never sees `StatelogParser` — it works in terms of `TreeNode`. Follow mode re-calls the builder (no `parser.reload()`).

**Files:**
- Modify: `lib/logsViewer/run.ts`, `lib/cli/logsView.ts`
- Test: `lib/logsViewer/run.test.ts`

- [ ] **Step 1: Update `RunViewerOpts` and `runViewer`**

In `lib/logsViewer/run.ts`:
```ts
import { TreeNode } from "./treeNode.js";

export type ViewerSource = { path: string } | { jsonl: string };

export type RunViewerOpts = {
  source: ViewerSource;
  input: InputSource;
  output: OutputTarget;
  viewport: { rows: number; cols: number };
  initialFollow?: boolean;
  thresholds?: ViewerThresholds;
};

export async function runViewer(opts: RunViewerOpts): Promise<void> {
  const buildForest = (): TreeNode[] =>
    "path" in opts.source
      ? TreeNode.forestFromLog(opts.source.path)
      : TreeNode.forestFromString(opts.source.jsonl);
  const followPath = "path" in opts.source ? opts.source.path : undefined;

  let roots = buildForest();
  const parseErrors = (): ParseError[] => roots[0]?.parseErrors() ?? [];
  // ... rest as before. flatten/search take no accessor (nodes carry event()).
  //     `renderState` reads `parseErrors()`; the roots.length === 0 short-circuit
  //     ("No events found.") is unchanged.
}
```
`runCopy` previously read `node.event` — change to `node.event() ?? { label, traceId, metrics }` for the node at `state.cursorId`. `flattenVisibleRows(state)` / `findMatches(state.roots, query, cols)` lose their `getEvent` argument (nodes self-serve via `event()`).

- [ ] **Step 2: Follow mode re-calls the builder**

`startFollow`'s `onAppend` rebuilds the forest from the (grown) file — no string concat, no `parser.reload()`:
```ts
onAppend: () => {
  roots = buildForest();                       // fresh parse of the grown file
  state = onFollowAppend(state, roots, opts.viewport);
  screen.render(renderState(state, parseErrors(), opts.viewport, thresholds));
},
```
`onFollowAppend(state, roots, viewport)` swaps in the new `roots` and preserves `cursorId` if a node with that id still exists (line-derived ids stay stable for existing lines). Follow is only wired when `followPath` is defined.

- [ ] **Step 3: Update `logsView.ts` to pass a `source` (no parser)**

In `lib/cli/logsView.ts`, the CLI no longer reads the file or builds a parser — it hands `runViewer` a `source`:
```ts
const source = file === "-" ? { jsonl } : { path: file };
await runViewer({ source, input, output, viewport,
  initialFollow: file === "-" ? false : (cliOpts.follow ?? false) });
```
Keep the stdin drain (to get `jsonl` for the `-` case) and the stdin/TTY swap logic. The viewer owns all parsing now.

- [ ] **Step 4: Update `run.test.ts`**

`run.test.ts` currently passes `jsonl` to `runViewer`. Change it to pass `source: { jsonl }`. Keep all behavior assertions (navigation, expand, search, copy, follow).

- [ ] **Step 5: Run the viewer integration tests**

Run: `pnpm test:run lib/logsViewer/run.test.ts`
Expected: PASS.

- [ ] **Step 6: Smoke-test the real command against the example log**

Run: `printf 'q' | pnpm run agency logs view statelog.log`
Expected: the viewer renders the trace tree and exits on `q` with no error. (If `statelog.log` is multi-trace, it shows multiple roots.)

- [ ] **Step 7: Commit**

```bash
printf '%s\n' "refactor(logsViewer): build the tree via TreeNode.forestFromLog" "" "runViewer/logsView work in terms of TreeNode (parser hidden); follow re-calls the builder. Replaces parse.ts+buildForest usage." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/commit-msg.txt
git add -A
git commit -F /tmp/commit-msg.txt
```

---

## Task 7: Delete dead code + relocate summaries

Remove the now-unused viewer parse/structure code and finish moving the plain-text summary helpers.

**Files:**
- Delete: `lib/logsViewer/parse.ts`, `lib/logsViewer/parse.test.ts`
- Modify: `lib/logsViewer/tree.ts` (remove `buildForest` + structural helpers; keep nothing if unused → delete the file and `tree.test.ts` too), `lib/logsViewer/summary.ts`, `lib/logsViewer/types.ts`

- [ ] **Step 1: Confirm `buildForest`/`parseStatelogJsonl` have no remaining importers**

Run:
```bash
grep -rn "buildForest\|parseStatelogJsonl" lib --include=*.ts | grep -v ".test.ts"
```
Expected: no non-test hits (the viewer now builds the tree via `TreeNode.forestFromLog`). If `tree.test.ts` is the only remaining importer of `buildForest`, the structural cases it covered were ported to `lib/statelogParser.test.ts` in Task 3 — delete `tree.test.ts`.

- [ ] **Step 2: Delete the dead files**

Run:
```bash
git rm lib/logsViewer/parse.ts lib/logsViewer/parse.test.ts
git rm lib/logsViewer/tree.ts lib/logsViewer/tree.test.ts
```
(If `tree.ts` still holds a helper used elsewhere, keep the file and remove only `buildForest` + its private helpers + `HIDDEN_EVENT_TYPES`/`inferSpanLabel`, which now live in the parser / `treeNode.ts` / `summarize.ts`.)

- [ ] **Step 3: Remove the now-dead `readAllEventsSync`**

`readAllEventsSync` (`lib/eval/parseJsonl.ts`) had exactly one caller — the old
parser — which now uses `parseStatelogText`. Confirm it is dead, then delete it
(keep `readEvents`/`readAllEvents`, still used elsewhere):

Run:
```bash
grep -rn "readAllEventsSync" lib --include=*.ts | grep -v ".test.ts"
```
Expected: no hits. Then remove the `readAllEventsSync` function from
`lib/eval/parseJsonl.ts`. Leaving it would be a second JSONL reader competing
with `parseStatelogText` (duplicated-code anti-pattern).

- [ ] **Step 4: Confirm `summary.ts` only holds styled variants**

`lib/logsViewer/summary.ts` should now import the plain-text helpers from `lib/statelog/summarize.ts` and keep only `summarizeSpanStyled`/`summarizeTraceStyled` + the styling helpers. Remove the temporary `summarize` re-export added in Task 3.

- [ ] **Step 5: Run the full viewer + parser test set**

Run: `pnpm test:run lib/logsViewer lib/statelogParser.test.ts lib/statelog`
Expected: PASS.

- [ ] **Step 6: Run the eval test set (consumers + extract)**

Run: `pnpm test:run lib/eval`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
printf '%s\n' "chore(logsViewer): delete parse.ts/buildForest now in the parser" "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/commit-msg.txt
git add -A
git commit -F /tmp/commit-msg.txt
```

---

## Task 8: Docs + final verification

**Files:**
- Modify: `docs/dev/statelog.md` (or add a short `docs/dev/statelogparser.md` pointer)

- [ ] **Step 1: Document the parser**

Add a section to `docs/dev/statelog.md` noting that `lib/statelogParser.ts` is the shared model for reading statelog files (used by the logs viewer and eval), summarizing the API (`getNodeById`, `traces()`/`trace()`/`onlyTrace()`, `llmCalls()`/`toolCalls()`, `eventOf()`, `parseErrors()`, `lines()`), and linking to `docs/dev/statelog-parser-memory-model.md`.

- [ ] **Step 2: Full unit-test sweep**

Run: `pnpm test:run lib/statelogParser.test.ts lib/logsViewer lib/eval lib/statelog`
Expected: PASS.

- [ ] **Step 3: Final manual smoke test**

Run: `printf 'jjlq' | pnpm run agency logs view statelog.log`
Expected: cursor moves, a node expands, exits cleanly.

- [ ] **Step 4: Commit**

```bash
printf '%s\n' "docs: document the shared StatelogParser model" "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/commit-msg.txt
git add -A
git commit -F /tmp/commit-msg.txt
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** memory model (Iterable `events()`, lazy `eventOf`, line-derived ids) → Tasks 2–4; multi-trace + `.trace()`/`onlyTrace()` → Task 3; parser owns hierarchy → Task 3; eval compat (kept methods, `fromFile` migration) → Tasks 1–2; `TreeNode` class hiding the parser + lazy `event()` + follow via re-build → Tasks 5–6; deletions → Task 7; docs → Task 8.
- **Parity safety net:** the existing `render`/`input`/`search`/`run` tests are preserved (rebuilt to construct nodes via `TreeNode.forestFromString`) — they prove the TUI behavior is unchanged.
- **Type consistency:** `StatelogNode` (model) vs `TreeNode` (view class) are distinct on purpose; `TreeNode.fromModel` is the only bridge. The parser is reached only through `TreeNode` (lazy `event()` / `parseErrors()`) on the viewer side, and directly by eval/query consumers.
