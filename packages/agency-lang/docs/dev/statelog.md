# Statelog

## Overview

Statelog is Agency's observability and tracing system. The `StatelogClient`
(`lib/statelogClient.ts`) captures structured execution events — graph
topology, node/hook lifecycle, LLM and tool calls, embeddings, image
generation, interrupts, checkpoints, forks/races, threads, subprocesses,
memory operations, saveDraft salvage, structured errors/warnings, and eval
markers — stamps each with a span context, and fans them out to one or more
sinks.

The current wire format is **`STATELOG_FORMAT_VERSION = 1`**.

## Configuration

Statelog is configured via `AgencyConfig.log` (a `StatelogConfig`), except for
the top-level `observability` master switch:

```json
{
  "observability": true,
  "log": {
    "host": "https://agency-lang.com",
    "projectId": "my-project",
    "apiKey": "...",
    "debugMode": false,
    "logFile": "./statelog.log",
    "requestTimeoutMs": 1500
  }
}
```

- **`observability`** — master switch, a **top-level** `AgencyConfig` field (NOT
  inside `log`). When falsy (the default), the entire client is a no-op: no
  events, no network, no file writes, and the span helpers short-circuit.
  Everything below only happens when this is `true`.
- **`host`** — remote Statelog server URL, or the literal `"stdout"` to print
  JSON events to the console. If unset (and no `logFile`), `post()` returns early.
- **`projectId`** — groups events by project in the dashboard.
- **`apiKey`** — bearer token for the remote sink. Also read from the
  `STATELOG_API_KEY` env var by `getStatelogClient`. A configured remote host
  with no key keeps local sinks working but skips the HTTP POST.
- **`logFile`** — append every event as one JSON line to this path (local dev
  and tests). Compatible with `host`/`stdout` — all configured sinks receive
  every event.
- **`debugMode`** — extra console diagnostics.
- **`requestTimeoutMs`** — per-request timeout for the remote POST (default
  1500ms) so a slow/unreachable host can't wedge end-of-run cleanup.

A `traceId` is auto-generated per execution via `nanoid()` so every event from
one run shares it.

## The envelope

Every event is serialized by `post()` into this envelope:

```json
{
  "format_version": 1,
  "trace_id": "...",
  "project_id": "...",
  "span_id": "... | null",
  "parent_span_id": "... | null",
  "data": { "type": "...", "timestamp": "<ISO>", "...": "event fields" }
}
```

`span_id`/`parent_span_id` come from the active span stack (see below).
`timestamp` is injected into `data` at post time.

## Sinks

`post()` writes to every configured sink independently:

- **File** — synchronous `appendFileSync`, one JSON object per line. Synchronous
  so a test can read the file immediately after an awaited event.
- **stdout** — `host: "stdout"` prints the envelope with `console.log`.
- **Remote** — `POST {host}/api/logs` with `Authorization: Bearer <apiKey>`,
  bounded by `AbortSignal.timeout(requestTimeoutMs)`. Requires an apiKey.

Remote sends are **fire-and-forget**: the fetch is not awaited (telemetry never
blocks execution) but is tracked in an `inFlight` set. Call `flush()` at
end-of-run to drain in-flight POSTs before the process exits.

## Redaction

`post()` is the single redaction chokepoint. Redaction is a `JSON.stringify`
replacer (`makeRedactReplacer`, `lib/runtime/redactForStatelog.ts`) applied to
the **`data` payload only**, so it can never blank out envelope infra fields
(`format_version`, `trace_id`, span ids). The pass is skipped entirely when the
caller's `GlobalStore.hasAnyTags()` is false — the common case is byte-identical
to no redaction. Events posted outside an AsyncLocalStorage frame (e.g.
`agentEnd`, resume-path finalization) fall back to the execution's top-level
store via `setFallbackGlobals`. Prompt/embed/image previews are capped at
`PROMPT_PREVIEW_MAX = 200` chars; embedding vectors and generated image bytes
are never logged.

## Span model

The client maintains a span stack to give every event a place in a
parent/child tree.

- `startSpan(type)` / `endSpan(spanId)` push/pop the active stack and return/
  consume a span id. `endSpan` tolerates a missing inner `endSpan` by dropping
  everything above the matched span.
- `snapshotStack()` / `runInBranchContext(parentStack, fn)` — concurrent
  fork/race branches each get a private, AsyncLocalStorage-backed stack seeded
  from the parent, so their spans never interleave with siblings or the parent.
- `adoptExternalParentSpan(spanId)` — a subprocess adopts the parent process's
  `subprocessRun` span as a synthetic, never-emitted root so its spans chain
  under the parent's tree.

`SpanType`: `agentRun`, `nodeExecution`, `llmCall`, `toolExecution`,
`threadEndHooks`, `forkAll`, `race`, `handlerChain`, `abortUnwind`,
`embedding`, `memoryRemember`, `memoryRecall`, `memoryForget`,
`memoryCompaction`, `subprocessRun`.

> A span only becomes visible to a log viewer once an event is posted carrying
> its `span_id`. Umbrella spans (memory ops, subprocess, abort unwind) therefore
> post a small marker event right after `startSpan` so the span materializes in
> the tree.

## Event catalog

Run lifecycle: `runMetadata`, `agentStart`, `agentEnd` (`agentEnd` posts its
remote send with `noWait`).

Graph & nodes: `graph`, `enterNode`, `exitNode`, `beforeHook`, `afterHook`,
`followEdge`.

LLM: `promptStart` (request shape, before dispatch) → terminated by exactly one
of `promptCompletion` (full redacted messages + completion + usage/cost),
an `error` with `errorType: "llmError"`, or `promptCancelled` (race loser /
Esc / timeout — deliberately not an error). Pairing is by span + order: the
nth start in an `llmCall` span pairs with the nth terminator; an unpaired start
is a hung/killed-mid-call run.

Tools: `toolCallStart` → `toolCall` (share the `toolExecution` span; OTEL
start+end mergeable).

Embeddings & images: `embedCompletion`, `imageGeneration`.

Memory: `memoryRemember`, `memoryRecall`, `memoryForget`, `memoryCompaction`.

Interrupts: `interruptThrown`, `handlerDecision`, `interruptResolved`.

Checkpoints: `checkpointCreated`, `checkpointRestored`.

Fork/race: `forkStart`, `forkBranchEnd`, `forkEnd`.

Threads: `threadCreated`, `threadResumed`, `threadEndHooksStart`,
`threadEndHooksEnd`, `threadEndHookError`.

Subprocess: `subprocessStarted`, `subprocessEnd`.

Salvage: `abortSalvage` — records how a `saveDraft` partial is handled as an
abort unwinds (`action`: `carried | erased | delivered | clearedAtFork |
droppedAtArgPosition`), nested inside an `abortUnwind` span.

Diagnostics: `error` (`errorType`: `toolError | llmError | runtimeError |
validationError | limitExceeded | structuredOutput`), `warn` (`warnType:
"failurePropagation"`; its variable payload lives under `data` so redaction
scopes it), `debug`, `diff`.

Eval: `evalValueRecorded`, `evalOutputRecorded` (emitted by the `std::statelog`
stdlib wrappers — `stdlib/statelog.agency` + `lib/stdlib/statelog.ts`).

## Integration points

- **RuntimeContext** (`lib/runtime/state/context.ts`) — holds one
  `StatelogClient` per execution; child contexts get a fresh client + traceId,
  and wire `setFallbackGlobals`.
- **SimpleMachine** (`lib/simplemachine/graph.ts`) — graph topology, node
  entry/exit, hook timing, edge transitions.
- **Runtime prompt** (`lib/runtime/prompt.ts`) — LLM `promptStart`/
  `promptCompletion` and tool `toolCallStart`/`toolCall`.
- **Log viewer** (`lib/logsViewer/`) — reconstructs the span tree from event
  lines (`tree.ts`, `render.ts`, `follow.ts`, `summary.ts`, `search.ts`).
- **Eval** (`lib/eval/statelogParser.ts`) — parses eval markers out of a trace.
- **CLI** — `lib/cli/upload.ts` (`upload()`), `lib/cli/remoteRun.ts`
  (`remoteRun()`).

## Factory

`getStatelogClient(config)` builds a `StatelogClient`, defaulting `apiKey` from
`STATELOG_API_KEY`. Used by CLI commands to construct clients from
`AgencyConfig.log`.

## Key behaviors

- **Opt-in / graceful no-op** — disabled unless `observability` is true; with no
  host and no logFile, `post()` returns immediately.
- **Non-blocking** — remote posts are detached; `flush()` drains them at exit.
- **Format versioning** — bump `STATELOG_FORMAT_VERSION` when the wire format
  changes in a way a viewer must notice; viewers should reject a higher version.
