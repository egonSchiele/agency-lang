# Statelog parser refactor — design

**Date:** 2026-06-14
**Status:** approved (design); pending implementation plan

## Goal

Extract the statelog parser from `lib/eval/` into a general-purpose data layer at
`lib/statelogParser.ts`, and refactor `agency logs view` to use it as its "model"
(MVC). The parser becomes the shared data layer for the logs viewer, the eval
pipeline, and future tooling that wants to query a statelog trace like a database.

Two outcomes:
- The logs viewer's tangled parse + tree-build logic is replaced by a thin
  adapter over a well-defined model.
- The parser gains a query API (`getNodeById`, `llmCalls()`,
  `trace(id).llmCalls()`, …) reusable across the codebase.

## Background

A statelog `.jsonl` file is one JSON event envelope (`EventEnvelope`, see
`lib/statelog/wireTypes.ts`) per line. Two parallel data layers exist today:

- **Eval** — `lib/eval/statelogParser.ts` (`StatelogParser`): a facade over
  `parseJsonl` → `normalize` → `extract`. Single-trace only (asserts exactly one
  `trace_id`). Produces an `EvalRecord` and exposes `evalInputs()`,
  `evalOutputs()`, `threads()`, `interrupts()`, `errors()`, `metrics()`, etc.
  Consumers: `lib/cli/evalExtract.ts`, `lib/cli/eval/run.ts`,
  `lib/stdlib/agencyEval.ts`, `lib/stdlib/statelog.ts`.
- **Logs viewer** — `lib/logsViewer/parse.ts` (`parseStatelogJsonl`, tolerant,
  collects parse errors) + `lib/logsViewer/tree.ts` (`buildForest`, multi-trace
  forest with parent re-resolution, chronological sort, metric roll-ups).

Both materialize the entire file into memory. See
`docs/dev/statelog-parser-memory-model.md` for the memory-model decision.

## Decisions

1. **Memory model — materialize now, streaming-ready API.** Implement an
   in-memory backend, but design the interface so nothing assumes payloads are
   resident: `getNodeById` is a lookup, `events()` is `Iterable` (not `Array`),
   node ids are offset-friendly, payloads are fetched through an accessor. A
   future indexed/lazy backend drops in behind the same interface. Full rationale
   and the deferred follow-up in `docs/dev/statelog-parser-memory-model.md`.

2. **Multi-trace with `.trace(id)` scoping.** The parser loads all traces.
   Top-level queries span every trace; `parser.trace(id)` returns a scoped
   `TraceView`; `parser.traces()` lists them; `parser.onlyTrace()` returns the
   single trace or throws if there is more than one.

3. **Parser owns the hierarchy.** The structural half of `buildForest`
   (trace→span→event tree, parent re-resolution, chronological ordering, metric
   roll-ups, `inferSpanLabel`) moves into the parser. The viewer becomes a thin
   adapter that decorates model nodes with view-only concerns.

4. **Eval is compat-first.** Keep the eval methods (`evalRecord`, `evalInputs`,
   `evalOutputs`, `finalEvalOutput`, …) on the parser, delegating internally to
   `onlyTrace()` so their single-trace guarantee holds. `extract.ts` /
   `normalize.ts` stay in `lib/eval/`, now fed by the parser. The 4 consumers
   change only their import path.

## The model — `lib/statelogParser.ts`

### Module layout

```
lib/statelog/
  wireTypes.ts        (unchanged — EventEnvelope, EventData)
  wireAccessors.ts    (unchanged — the parser uses these, never reads data.foo directly)
lib/statelogParser.ts (NEW — the general parser/model)
lib/eval/
  parseJsonl.ts       (stays — the raw line-reading I/O primitive)
  normalize.ts, extract.ts, types.ts   (stay — eval-specific, now fed by the parser)
```

### Core types

```ts
type NodeKind = "trace" | "span" | "event";

type StatelogNode = {
  id: string;                 // trace:<traceId> | <span_id> | evt:<lineNo>
  kind: NodeKind;
  traceId: string;
  parentId: string | null;
  children: StatelogNode[];
  descriptor: NodeDescriptor; // lightweight: type + key fields for a one-line summary
  metrics?: {                 // rolled up for spans/traces; from the event for leaves
    tokens?: number;
    cost?: number;
    durationMs?: number;
    firstTs?: number;
  };
  // NOTE: no full EventEnvelope here — payloads are fetched lazily (Tier 2).
};
```

### Two-tier rule (what makes "streaming-ready" real)

- **Tier 1 — descriptors + structure + metrics.** Held by every node. Cheap.
  Enough for the collapsed tree view, all metric roll-ups, and the typed-query
  one-line summaries.
- **Tier 2 — full payload** (`EventEnvelope`, message arrays, raw JSON). Fetched
  on demand via `parser.eventOf(id)` / `parser.getNodeById(id)`. Materialized
  backend: a hashmap hit. Future indexed backend: a byte-offset seek. Consumers
  never reach into a resident payload array.

### Node identity

- Spans: their `span_id`.
- Events: `evt:<lineNo>` (1-based source line) — stable across reloads and maps
  directly to a byte offset when the lazy backend lands.
- Traces: `trace:<traceId>`.

### API

```ts
class StatelogParser {
  constructor(filePath: string, opts?: StatelogParserOptions)
  static fromString(jsonl: string, opts?: StatelogParserOptions): StatelogParser

  // streaming / iteration
  events(): Iterable<EventEnvelope>          // Iterable, NOT Array
  *lines(): Iterable<{ lineNo: number; event: EventEnvelope }>
  parseErrors(): ParseError[]                // tolerant parse; viewer renders these

  // random access ("database" queries)
  getNodeById(id: string): StatelogNode | undefined
  eventOf(id: string): EventEnvelope | undefined   // Tier-2 payload fetch
  traces(): TraceView[]
  trace(id: string): TraceView
  onlyTrace(): TraceView                      // single-trace; throws if >1

  // general typed queries (whole file; also scoped on TraceView)
  llmCalls(): LlmCall[]
  toolCalls(): ToolCall[]

  // eval compat (EvalRecord-derived, single-trace — delegate to onlyTrace(),
  // unchanged for consumers)
  evalRecord(): EvalRecord
  evalInputs(): EvalValue[]
  evalOutputs(): EvalValue[]
  finalEvalOutput(): EvalValue | null
  errors(): ErrorEntry[]
  interrupts(): InterruptEntry[]
  threads(): ThreadEntry[]
  metrics(): Metrics
}

// A query scoped to one trace. A class (not a factory-returned object) so the
// fluent surface — parser.trace(id).llmCalls(), parser.onlyTrace().root(),
// parser.traces()[i].getNodeById(…) — is one well-defined type. Its query
// methods mirror the parser's so the scoped call reads the same as the global.
class TraceView {
  constructor(parser: StatelogParser, root: StatelogNode)
  get traceId(): string
  root(): StatelogNode
  getNodeById(id: string): StatelogNode | undefined
  llmCalls(): LlmCall[]
  toolCalls(): ToolCall[]
}
```

The eval-flavored aggregates (`errors`/`interrupts`/`threads`/`metrics`) stay
parser-level and single-trace (they are derived from `evalRecord()` →
`onlyTrace()`); they are intentionally NOT on `TraceView` until a consumer needs
per-trace versions (YAGNI). The general queries `llmCalls`/`toolCalls` exist in
both places with identical names and return types.

### Parse tolerance

The parser is tolerant: it collects `ParseError[]` (malformed JSON, unsupported
`format_version`, missing `trace_id`/`data.type`) via `parseErrors()` instead of
throwing, preserving the viewer's partial-render + "N parse error(s)" behavior.
The viewer's richer validation from `parse.ts` (version gate, field validation)
folds into the parser. The eval path preserves its current strict behavior:
`evalRecord()` / the eval extract throws if `parseErrors()` is non-empty.

### The model keeps all events

`graph` and other "noise" events stay queryable in the model — hiding them is a
*view* decision. `HIDDEN_EVENT_TYPES` moves into the viewer.

## The view — `lib/logsViewer/` refactor

Principle: the viewer stops parsing and stops building structure. It adapts the
model and decorates it. The render loop, the pure/impure split, scroll math, the
input reducer, and search match-logic stay.

### What moves out of the viewer

- `parse.ts` — **deleted**; folded into the parser.
- `tree.ts` `buildForest` structural logic — moves to the parser (incl.
  `inferSpanLabel`).
- `TreeNode.event: EventEnvelope` — **gone**; payloads fetched lazily.

### `TreeNode` is a class that hides the parser

`TreeNode` (the view node) becomes a class whose static entry points build the
model internally — callers never see `StatelogParser`:

```ts
class TreeNode {
  static forestFromLog(path: string): TreeNode[]      // creates StatelogParser.fromFile, builds tree
  static forestFromString(jsonl: string): TreeNode[]  // stdin path
  event(): EventEnvelope | undefined                  // lazy payload via the hidden parser
  parseErrors(): ParseError[]                          // file-level, via the hidden parser
}
```

`TreeNode.fromModel(StatelogNode, parser)` is the only bridge (copies id, kind,
label, summary, metrics; filters `HIDDEN_EVENT_TYPES` — a *view* concern). Each
node keeps a private parser reference; that is the "implementation detail" hidden
from consumers. View-only concerns stay in the viewer unchanged: `summary.ts`
builds the styled `(1.2s, 1500 tok)` strings from `node` metrics; `render.ts`
`colorFor` / `chooseGlyph` unchanged.

### Lazy payload — "go back to the model on expand"

Synthetic rows (`convoLine`, `jsonLine`, `rawDataToggle`) need the full payload.
Rather than every node hoarding it (or threading an accessor), each node fetches
on demand via `node.event()`, backed by the hidden `parser.eventOf(id)`:

- Materialized backend: hashmap hit. Future lazy backend: byte-offset seek. The
  viewer code is unchanged either way; payloads never live in the persistent forest.
- Purity preserved: `event()` is a pure read; the `input.ts` reducer stays pure.
  `flattenVisibleRows`/`findMatches` keep their signatures (no accessor to thread).
  The `rawDataToggle` delegates `event()` back to the leaf it was spawned from.

### Entry point + follow mode

```ts
// logsView.ts — never touches StatelogParser
const source = file === "-" ? { jsonl } : { path: file };
await runViewer({ source, input, output, viewport, initialFollow });
```

- `run.ts` builds its forest with `TreeNode.forestFromLog(path)` /
  `forestFromString(jsonl)` instead of `parseStatelogJsonl` + `buildForest`.
- Follow (`follow.ts`, the byte-offset poller) stays as-is; on append it re-calls
  the builder (fresh parse of the grown file) and preserves the cursor by id
  (line-derived ids stay stable for existing lines). No `parser.reload()` needed.
- Parse errors reach the error bar via `roots[0].parseErrors()`; the existing
  `roots.length === 0 → "No events found."` short-circuit is unchanged.

## Eval (compat-first)

`extract.ts` / `normalize.ts` stay in `lib/eval/`, now consuming the parser. The
4 consumers (`evalExtract.ts`, `eval/run.ts`, `agencyEval.ts`, `statelog.ts`)
switch from `new StatelogParser(path)` to `StatelogParser.fromFile(path)` (the
constructor is private; `fromFile`/`fromString` are the factories) and keep
calling `.evalRecord()` / `.evalInputs()`, which delegate to `onlyTrace()`.

## Testing

- **New `lib/statelogParser.test.ts`**: hierarchy build (port structural cases
  from `tree.test.ts`), `getNodeById`, trace scoping (`trace(id)`, `onlyTrace`),
  typed queries, parse-error tolerance, eval compat (move cases from
  `eval/statelogParser.test.ts`).
- **Viewer**: new `treeNode.test.ts` (`TreeNode.forestFromString` builds the
  tree, hides `graph`, lazy `event()`, `parseErrors()`). `render` / `search`
  tests build inputs via `TreeNode.forestFromString` (no stubs); `input.test.ts`
  unchanged. These stand as the behavior-parity safety net. `run.test.ts` passes
  a `source: { jsonl }`.

## Phased migration

1. **Build the model.** Create `lib/statelogParser.ts` = move eval's
   `StatelogParser` + fold in `parse.ts` validation + `buildForest` structural
   logic + add the query API and two-tier nodes. Migrate the 4 consumers to
   `StatelogParser.fromFile`. Parser tests green.
2. **Refactor the viewer.** Add the `TreeNode` class (`treeNode.ts`) with
   `forestFromLog`/`forestFromString` + lazy `event()`; `run.ts`/`logsView.ts`
   work in terms of `TreeNode` (parser hidden); follow re-calls the builder.
   Viewer tests green.
3. **Cleanup.** Delete `logsViewer/parse.ts`, slim `tree.ts`, relocate
   `inferSpanLabel`, update `docs/dev/`.

## Non-goals

- The indexed/lazy backend (deferred — see the memory-model doc).
- Unifying eval's `normalize` with the parser's hierarchy beyond what compat-
   first requires.
- Any change to the TUI rendering, render loop, scroll math, or input reducer
  behavior.
