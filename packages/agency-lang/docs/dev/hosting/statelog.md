# Statelog

## Overview

Statelog is Agency's observability and tracing system. The `StatelogClient`
(`lib/statelogClient.ts`) captures structured execution events, stamps each
with a span context, and fans them out to one or more sinks. The events cover
graph topology, node and hook lifecycle, LLM and tool calls, embeddings, image
generation, speech, interrupts, checkpoints, forks and races, threads,
subprocesses, memory operations, saveDraft salvage, structured errors and
warnings, and eval markers.

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
- **`requestTimeoutMs`** — per-request timeout for the remote POST (`DEFAULT_REQUEST_TIMEOUT_MS`,
  1500ms) so a slow or unreachable host can't wedge end-of-run cleanup.

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
blocks execution), but it is tracked in an `inFlight` set. Call `flush()` at
end-of-run to drain in-flight POSTs before the process exits.

## Redaction

`post()` is the single redaction chokepoint. Redaction is a `JSON.stringify`
replacer (`makeRedactReplacer`, `lib/runtime/redactForStatelog.ts`) applied to
the **`data` payload only**, so it can never blank out envelope infra fields
(`format_version`, `trace_id`, span ids). The replacer matches whole tagged
values and also scrubs redacted strings **contained inside** larger strings
(`GlobalStore.redactContainedStrings`), because a tagged string interpolated
into a new string would otherwise log verbatim. The pass is skipped entirely
when the caller's `GlobalStore.hasAnyTags()` is false, so the common case is
byte-identical to no redaction. Events posted outside an AsyncLocalStorage frame (e.g.
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

Run lifecycle: `runMetadata`, `agentStart`, `agentName`, `agentEnd`.
`agentEnd` posts its remote send with `noWait`.

### Code identity and input on `agentStart`

`agentStart` carries two fields that cannot be recovered after the fact and
that let a trace stand on its own as "a run":

- `code` — `{ entry, closureHash, closure: [{ file, sha256 }] }`, computed by
  `computeCodeIdentity(entryFile)` in `lib/runDirectory/codeIdentity.ts`.
  Paths are relative to the closure files' common ancestor (never the cwd),
  so the same code hashes the same wherever it was run from. It reaches the
  client as `StatelogConfig.code`, which every launcher fills through the
  `log.code` config override: `agency run` (`lib/cli/commands.ts`), the eval
  file runner (`lib/eval/run/runAgent.ts` hashes the *seeded* copy), and
  `agency agent` (`lib/cli/runBundledAgent.ts`; a precompiled agent shipped
  without its `.agency` source records nothing). Command agents under
  `--agent-cmd` get it from the `agency` CLI they invoke.
- `input` — what the entry node was given, when the caller named it. It is
  never derived from the node's parameters (a plain one-parameter call and an
  eval input look identical there). The generated node wrapper takes a hidden
  `invocationInput` option, named that way because `input` is a common
  parameter name. The subprocess bootstrap passes `RunInstruction.input`
  through it, so eval runs record their input and ordinary `agency run`
  invocations record none.

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

Embeddings, images, and speech: `embedCompletion`, `imageGeneration`,
`transcription` (speech-to-text), `speechSynthesis` (text-to-speech). Only a
short text preview is logged for each. Audio bytes, embedding vectors, and
generated image bytes never are.

Local models: `localModelLoaded` — the pinned model plus where the llama-cpp
provider package was resolved from (`entrySource`: override / local / global).
Emitted at bootstrap when config names the provider, and from
`registerLocalModel` inside a run.

Memory: `memoryRemember`, `memoryRecall`, `memoryForget`, `memoryCompaction`.

Interrupts: `interruptThrown`, `handlerDecision`, `interruptResolved`.
`interruptResolved.resolvedBy` is `"policy"` or `"user"` when the deciding
handler tagged its verdict (the CLI policy handler does), `"handler"` for a
plain handler function, `"ipc"` when a parent process took part, and null
on the chain-outcome event of an interrupt that surfaced to a person.
`handlerDecision.decidedBy` carries the same tag per handler, and
`handlerDecision.timeTaken` is how long that handler ran, which for the
CLI policy handler is how long the person took to answer.

Turns: `turnStart`, `turnEnd` (`timeTaken`), emitted by the agency
agent's turn loop around each user turn. The logs viewer sums them for a
session's working time instead of the session's wall clock.

Checkpoints: `checkpointCreated`, `checkpointRestored`.

Fork/race: `forkStart`, `forkBranchEnd`, `forkEnd`.

Threads: `threadCreated`, `threadResumed`, `threadRepaired`,
`threadEndHooksStart`, `threadEndHooksEnd`, `threadEndHookError`.
`threadRepaired` fires when a reopened thread was structurally invalid and
`repairAbandonedTurn` synthesized the missing tool results.

Subprocess: `subprocessStarted`, `subprocessEnd`.

Salvage: `abortSalvage` — records how a `saveDraft` partial is handled as an
abort unwinds (`action`: `carried | erased | delivered | clearedAtFork |
droppedAtArgPosition | droppedAtNodeBoundary`), nested inside an `abortUnwind`
span. The two terminal drops (`clearedAtFork`, `droppedAtNodeBoundary`) end
that span; `droppedAtArgPosition` does not, because the abort travels on.

Diagnostics: `error` (`errorType`: `toolError | llmError | runtimeError |
validationError | limitExceeded | structuredOutput | finalizeError`), `warn`
(`warnType`: `failurePropagation | toolSchemaSize`; its variable payload lives
under `data` so redaction scopes it), `debug`, `diff`.

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
- **CLI** — `lib/cli/eval/upload.ts` and the sealed upload client
  `lib/cli/statelog/uploadClient.ts`.

## Factory

`getStatelogClient(config)` builds a `StatelogClient`, reading `apiKey` from
`STATELOG_API_KEY`. It takes `{ host, traceId?, projectId, debugMode?,
observability?, logFile? }` and mints a `traceId` with `nanoid()` when none is
given.

## Key behaviors

- **Opt-in / graceful no-op** — disabled unless `observability` is true; with no
  host and no logFile, `post()` returns immediately.
- **Non-blocking** — remote posts are detached; `flush()` drains them at exit.
- **Format versioning** — bump `STATELOG_FORMAT_VERSION` when the wire format
  changes in a way a viewer must notice; viewers should reject a higher version.
