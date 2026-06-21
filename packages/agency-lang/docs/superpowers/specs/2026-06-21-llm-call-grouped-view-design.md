# Grouped, flattened LLM-call view

**Date:** 2026-06-21
**Status:** Design — approved, pending spec review
**Branch:** `llm-call-grouped-view`

## Problem

In the logs viewer, a single `llm(prompt, { tools })` call that triggers a
tool renders confusingly. Two issues, reported from `foo.agency` (an LLM
call whose `getArea` tool makes its own LLM call):

1. **`llmCall` vs `promptCompletion` look redundant.** Each `llmCall`
   span wraps exactly one `promptCompletion` event, so the two nodes
   nest 1:1 with no added meaning.
2. **One `llm()` call shows as multiple top-level `llmCall` nodes.** A
   call with tools runs a multi-round tool loop, and today **each round
   opens its own `llmCall` span** (`lib/runtime/prompt.ts:594, 632,
   1080`). So an N-round call produces N sibling `llmCall` nodes under
   `nodeExecution`, none of which represents "the whole call."

### Current span shape (from `log.jsonl` for `foo.agency`)

```
agentRun
└─ nodeExecution
   ├─ llmCall #1            ← round 1
   │  ├─ promptCompletion   [user] + [assistant: tool call getArea]
   │  └─ toolExecution getArea
   │     ├─ toolCallStart
   │     ├─ threadCreated
   │     ├─ llmCall         getArea's nested call
   │     │  └─ promptCompletion  [user] + [assistant: "area is…"]
   │     └─ toolCall
   └─ llmCall #2            ← round 2
      └─ promptCompletion   [user, tool call, tool result, assistant final]
```

## Goal

One `llm()` call renders as **one** node showing a single, continuous
conversation, with tool executions spliced inline and nested `llm()`
calls shown as their own nodes:

```
nodeExecution
└─ ▼ llm · gpt-4o-mini  (286 tok, $0.000)
      [user] "Get the area of France…"
      [assistant] tool call: getArea({"country":"France"})
      └─ ▼ toolExecution getArea
         ├─ ▼ getArea's llm · gpt-4o-mini
         │     [user] "What is the area of France?"
         │     [assistant] "≈551,695 km²…"
         └─ toolCall "getArea"
      [tool: getArea] "≈551,695 km²…"
      [assistant] "The area of France is ≈551,695 km²…"
```

## Non-goals / out of scope

- **Backward compatibility.** Old logs (per-round `llmCall` spans) are
  not supported by the new rendering and will degrade to roughly the
  current multi-node look. No `STATELOG_FORMAT_VERSION` bump, no
  dual-mode rendering. Logs are regenerated.
- No change to what events are emitted (`promptCompletion`,
  `toolCall`, etc.) — only the **granularity of the `llmCall` span**.

## Design

Two changes: one runtime, one viewer.

### 1. Runtime — `llmCall` is one span per `llm()` call

**File:** `lib/runtime/prompt.ts` (`runPrompt`).

Today the span is opened and closed **per round**:
- `initialLlmCall` step opens it (line 594),
- the resume path reopens it (lines 631–633),
- each `round.N.nextLlmCall` step closes the previous and opens a new
  one (lines 1078–1080),
- `finally` closes the last (line 1123).

Change to **one span for the whole tool loop**:
- Open a single `llmCall` span once, before the `initialLlmCall` step.
- Remove the per-round close+reopen at `nextLlmCall` (the span stays
  open across rounds).
- Close it once in the existing `finally`.
- Preserve resume semantics: the span is opened at `runPrompt` entry
  (outside `pr.step`, as today), so a resumed execution opens its own
  span — consistent with the current per-round behavior. Spans are
  runtime-only and not serialized.

Result: all rounds' `promptCompletion` events and all `toolExecution`
spans nest under one `llmCall` span. No new `SpanType`. `llmCall` now
means exactly "one `llm()` call." Per-call duration/tokens/cost roll up
to the single span via the existing aggregation in
`lib/logsViewer/tree.ts` (`measuredDuration` sums every
`promptCompletion.timeTaken` under the span — now the call total).

### 2. Viewer — render an `llmCall` span as a flattened conversation

**Files:** `lib/logsViewer/render.ts` (primary), `summary.ts` (label).

The tree builder (`tree.ts`) is unchanged: an `llmCall` span still has
its `promptCompletion` leaves and `toolExecution` child spans. The
**flatten happens at display time** in `flattenVisibleRows`.

When an `llmCall` span is expanded, instead of listing its raw children,
produce synthetic expansion rows:

1. **Pick the transcript source.** Take the **last** `promptCompletion`
   leaf under the span (latest by timestamp). Its `messages` array is
   the complete request transcript of the final round; its
   `completion` is the final assistant turn. Assemble
   `[...messages, assistantMessage(completion)]` — reusing the existing
   message-assembly in `promptCompletionChildren` (the same logic that
   already renders a single `promptCompletion`, including the
   tool-call-aware completion turn from the earlier render.ts fix).
2. **Build conversation rows.** Run the assembled messages through
   `formatConversation` → one `convoLine` per line (with the existing
   width-wrapping).
3. **Splice tool executions inline.** Collect the span's
   `toolExecution` child spans in timestamp order. Walk the assembled
   messages; when a message is an assistant turn carrying `toolCalls`,
   emit its `convoLine`(s) and then emit the **next N** `toolExecution`
   span nodes (N = that message's tool-call count), in order. These are
   the real tree nodes, so they keep their normal expansion (and the
   nested `llmCall` inside each tool execution flattens recursively).
4. **Absorb the rest.** The intermediate `promptCompletion` leaves
   (earlier rounds) are not rendered as their own rows — their content
   is a prefix of the final transcript. A "raw data" affordance on the
   node still exposes the underlying envelope(s) for debugging.

Matching tool executions by greedy count + time order needs no
tool-call ids: across the whole call, the assistant tool-call messages
appear in order and the `toolExecution` spans were created in that same
order. Parallel tool calls in one round (one assistant message with
N>1 `toolCalls`) splice all N.

**Label.** Display the `llmCall` span as `llm` in the viewer (matches
how users think of the call). The internal `SpanType` stays `"llmCall"`
to avoid churn in `inferSpanLabel` / `colorFor` / tests; only the
rendered label changes.

## Edge cases

- **No-tool call.** One round, one `promptCompletion`, no
  `toolExecution`s → just the `[user]/[assistant]` conversation rows.
- **Parallel tool calls in a round.** Assistant message with N tool
  calls → splice the next N tool-execution spans.
- **Multi-round with tools in several rounds.** Greedy count consumes
  tool-execution spans in order across rounds; each round's assistant
  tool-call message gets its round's executions.
- **Error / cancelled round (no clean final `promptCompletion`).** Fall
  back to the last available `promptCompletion`; if none exists under
  the span, fall back to listing the raw children (current behavior).
- **Nested `llm()` (the `getArea` case).** Its own `llmCall` span,
  flattened by the same code path, rendered inside the spliced
  `toolExecution`.

## Testing

- **Runtime** (`tests/agency-js/`): a multi-round tool call emits
  exactly **one** `llmCall` span wrapping both rounds' `promptCompletion`
  events and the `toolExecution`. Assert span counts/parentage by
  reading `statelog.log` (same harness as
  `tool-call-no-phantom-thread`).
- **Viewer** (`lib/logsViewer/render.test.ts`, `tree.test.ts`):
  - single-round `llmCall` → conversation rows, no tool splice;
  - multi-round `llmCall` with one tool → flattened transcript with the
    `toolExecution` spliced after the assistant tool-call line;
  - parallel tool calls → two executions spliced after one assistant
    message;
  - recursive nested `llmCall` inside a tool execution renders flattened;
  - greedy splice order is correct across rounds.

## Risks

- **Per-round timing is no longer a separate span.** Only the per-call
  total shows on the node; individual round `timeTaken` remains in each
  `promptCompletion`'s raw data. Accepted.
- **Resume span semantics.** Opening one span at `runPrompt` entry must
  not break checkpoint/resume; verified against the existing per-entry
  span behavior (spans are not serialized). Covered by runtime tests.
- **Flatten correctness depends on the last `promptCompletion` holding
  the full transcript.** True for the tool loop (each round resends the
  growing thread). The error-path fallback covers the exception.
