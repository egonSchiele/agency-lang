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
  JSON events to the console. There is no default: if unset (and no
  `logFile`), `post()` returns early.
- **`projectId`** — the project the events belong to. There is no default,
  and the remote sink needs one.
- **`apiKey`** — bearer token for the remote sink. Also read from the
  `STATELOG_API_KEY` env var by `getStatelogClient`.
- **`logFile`** — append every event as one JSON line to this path (local dev
  and tests). Compatible with `host`/`stdout` — all configured sinks receive
  every event.
- **`debugMode`** — extra console diagnostics.
- **`requestTimeoutMs`** — per-request timeout for the remote POST (`DEFAULT_REQUEST_TIMEOUT_MS`,
  1500ms) so a slow or unreachable host can't wedge end-of-run cleanup.

The remote sink turns on only when `host`, `projectId`, and `apiKey` are all
set. Missing any one keeps local sinks working but skips the HTTP POST. This
is deliberate: a `STATELOG_API_KEY` exported for some other project must not
turn on remote logging by itself.

This package's own `agency.json` names no host and no project. That file is
compiled into everything the package ships (the agents, the standard
library), so a host there would be a default host for every user.
`agency.local.json` is merged over it at compile time too, so do not publish
from a checkout whose local file names a host. A test in
`lib/backends/statelog.codegen.test.ts` checks the checked-in file. Commands
that need a host (`agency eval upload`, `agency remote`, `agency deploy`)
read it from `agency.local.json` or `--host`.

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

Remote sends are **fire-and-forget**: the fetch is not awaited, and nothing
during a run waits for it. A node returning does not wait either. That wait
used to add 600 ms or more to every node run.

One module sends every request, `lib/statelogSender.ts`. A client lives for
one run, and a request it started can outlive that run, so the list of
requests still on their way belongs to the process. `sendStatelogPost()` adds
to the list and `flushPendingStatelogPosts()` waits for everything on it.

### Exiting

A process that ends on its own needs no flush, because Node keeps running
until open requests finish. `process.exit()` kills them. Code in
`lib/runtime`, `lib/serve`, and `lib/stdlib` exits through
`lib/runtime/exitProcess.ts`, and a lint rule in `eslint.config.js` refuses a
bare `process.exit()` in those directories. The module has two functions:

- `exitProcess(code)` waits for the pending requests, then exits. The
  per-request timeout bounds the wait. Print any message for the user before
  calling it, so the message does not wait on the uploads.
- `exitProcessNow(code)` exits at once and loses the pending requests. Each
  call site says why it cannot wait.

| Exit | Function |
|---|---|
| Budget trip (`reportBudgetExceededAndExit`) | `exitProcess` |
| Unhandled interrupt (`reportUnhandledInterrupts`) | `exitProcess` |
| Subprocess bootstrap, after its result is sent to the parent | `exitProcess` |
| Stdlib `exit()` (`_exit`) | `exitProcess` |
| MCP stdio server's `exit` method | `exitProcess` |
| The agent's own exits, which call `_exit` | `exitProcess` |
| Ctrl+C and signal handlers in `std::ui/cli` | `exitProcessNow` |
| Subprocess bootstrap, parent disconnected or no node run yet | `exitProcessNow` |
| `std::args` help, version, and usage errors (a synchronous parse) | `exitProcessNow` |
| A served program told to stop by SIGTERM or SIGINT (`lib/serve/shutdown.ts`) | `exitProcess` |
| Entry node name not found (`cliEntry.ts`) | `exitProcessNow` |

The generated entry point has one more case. A crash ends with an uncaught
throw, which also kills open requests. The generated code prints the crash
message, awaits `flushPendingStatelogPosts()`, and then throws.

A TypeScript program that imports a compiled module, runs a node, and then
calls `process.exit()` itself must await `flushPendingStatelogPosts()` first.
It is exported from `agency-lang/runtime`.

A served program does not end on its own. A hosting platform stops it with
SIGTERM, and Node's default for that signal is to die at once. `agency serve`
and the standalone server scripts call `exitOnShutdownSignal(server)`, which
stops accepting connections, waits for the pending log requests, and exits 0.
Requests still running at that moment are cut off, as they were before.

The hosted server needs none of this. It runs programs inside its own
long-lived process (`how-hosted-serving-works.md`), so requests finish in the
background. The debugger (`lib/debugger/ui.ts`) and the language tools MCP
server (`lib/mcp/server.ts`) are outside the lint rule. The first exits when
the user quits, and the second never runs an Agency program.

## Redaction

`post()` is the one place an event is serialized, so it is where the event is
scrubbed. `lib/runtime/redactForStatelog.ts` holds the scrub rules. A rule
takes a value and the object holding it, and returns the text to log in its
place, or undefined to leave the value to the next rule.
`statelogScrubRules(globals)` lists them in order:

1. `redactRule(globals)` swaps a value tagged `redact` for its marker. It also
   scrubs a redacted string **contained inside** a larger string
   (`GlobalStore.redactContainedStrings`), because a tagged string
   interpolated into a new string would otherwise log verbatim. When the
   store holds no tags, the rule is a no-op chosen once per event.
2. `omitBinaryRule` replaces picture bytes, and any other binary data sent as
   base64, with a marker such as `[image/png: 6000 bytes omitted]`. It matches
   a string over 4,096 characters that is a base64 `data:` URI, or that is
   all base64 or base64url characters with both upper- and lowercase letters
   among them. The two-case test keeps hex, long numbers, and one-letter
   filler. The mime type comes from the `data:` header, or from a string
   `mimeType` on the object holding the bytes, which is where Agency's
   attachment shape `{ kind: "base64", base64, mimeType }` keeps it.

`stringifyStatelogEvent` serializes the envelope in one `JSON.stringify`
with `makeScrubReplacer(rules)`. The replacer returns the envelope's own
fields unchanged, so a pathological redaction such as a tag on the number 1
can never blank `format_version` or the ids. The rules run on every event,
tags or not, because pictures arrive without tags. Any replacer takes
`JSON.stringify` off V8's fast path: a 1.9 MB event takes about 6 ms, against
2.1 ms with no replacer. Node events no longer carry the runtime and prompt
events no longer carry tool schemas, so events stay small and the cost does
too. The biggest event in a BMO run is about 0.65 MB.

`safeStatelogValue` (`lib/runtime/runner.ts`) runs the same rules while it
clones a fork branch's value, before it truncates an oversized one into a
string that `post()` cannot look inside.

Prompt messages reach the client already redacted: `redactMessagesForLog`
runs smoltalk's `redactAttachments` over them, which writes its own marker,
`[redacted N base64 chars]`. Events posted outside an AsyncLocalStorage frame
(e.g. `agentEnd`, resume-path finalization) fall back to the execution's
top-level store via `setFallbackGlobals`. Prompt/embed/image previews are
capped at `PROMPT_PREVIEW_MAX = 200` chars; embedding vectors and generated
image bytes are never logged.

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

### Span ids across a resume

Span ids are random and are not part of a checkpoint on their own. A resumed
run builds a new execution context, so every span it reopens would get a new
id, and a span whose events were all logged before the pause would never
appear in the resumed run's log at all. The `toolCall` that ends a paused
tool would then sit in a span with no `toolCallStart`, under an `llmCall`
span missing from the log, and a viewer would show the resumed work as a
second, separate call.

Two sites can be open when a checkpoint is taken and reuse their id on
resume, through `reopenSpan(type, slot)` on the client:

| Site | Span | Where the id is saved |
|---|---|---|
| `runPrompt` (`lib/runtime/prompt.ts`) | `llmCall` | the runPrompt frame's locals, key `__span_llmCall` |
| the tool loop in `runPrompt` | `toolExecution` | the frame's `runnerState`, key `__span_round.<round>.tool.<call>`, dropped when the tool is done |

A slot is a key under `__span_` in a record the checkpoint serializes (see
`lib/statelog/spanSlot.ts`). The slot's lifetime is the id's lifetime: the
runPrompt frame is popped on completion and on a throw but not on a pause,
so the id is kept across a pause and forgotten afterwards with no clearing
code at either site, the same way `messagesJSON` and `toolTimings` are kept.

A saved id is reused only inside the trace that minted it. The slot holds
the trace id beside the span id, and `reopenSpan` opens a fresh span when
they differ. So a rewind (`rewindFrom`), which runs in a new trace, gets
new spans without anything being cleared, and a `restore()` in the same
trace continues the same spans. That second case is deliberate: the step
log skips the completed `toolCallStart` step on replay, so keeping the id
is what keeps the tool's start and end in one span. A retried tool then
logs one `toolCallStart` and two `toolCall` events in that span; the eval
extractor pairs by span and counts the tool complete, and the viewer's tool
row reads the first `toolCall` it finds.

The tool slot lives in the runPrompt frame's `runnerState`, beside
`toolTimings`, and is forgotten once the tool is done (anything but a
pause), so a long tool loop does not carry every old id in every checkpoint. The saved id is also
checked for shape (twelve characters of the nanoid alphabet) before it goes
into any event, because the checkpoint is the program and could have been
edited.

`agentRun` and `nodeExecution` keep fresh ids. Each resume is its own
invocation, and folding them into one span would make its duration cover
the pause. The reopened `llmCall` events name the resumed run's fresh
`nodeExecution` as their parent, and that span is in the log because the
graph logs `enterNode` on every run, resumes included. A viewer keeps the
parent it saw first for each span, so the resumed events land under the
original call tree. Keep `enterNode` unconditional, or the parent goes
missing.

The remaining spans that can be open at a pause, `forkAll`/`race` and
`subprocessRun`, still get fresh ids on resume.

`tests/agency-js/span-ids-survive-resume` covers a pause inside a tool, in
a handoff, twice in one loop, in a loop body, a same-trace `restore()`, and
a rewind.

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

The graph logs a node's state on `enterNode`, `exitNode`, and `followEdge`.
Agency hands every node this state:

```ts
{ messages, data, ctx, isResume, run }
```

`nodeStateForLog` in the client drops `ctx` and `run` before posting. Both
hold the whole state stack: `run` carries `ctx` again and the same stack as
`run.stack`. Logging them wrote the stack three times per event, and no
reader uses them.

LLM: `promptStart` (request shape, before dispatch) → terminated by exactly one
of `promptCompletion` (full redacted messages + completion + usage/cost),
an `error` with `errorType: "llmError"`, or `promptCancelled` (race loser /
Esc / timeout — deliberately not an error). Pairing is by span + order: the
nth start in an `llmCall` span pairs with the nth terminator; an unpaired start
is a hung/killed-mid-call run.

`promptCompletion.tools` lists the offered tools by name. Every call offers
the whole tool list, so its descriptions and schemas were most of each event:
251 MB of a 591 MB log from BMO. Readers use only the names (`toolsOf` in
`lib/statelog/wireAccessors.ts`). An `llmError` still logs the full
definitions, since a bad schema can be the reason a request failed.

Both prompt events carry `usageKind`: `"completion"` for a text model and
`"decision"` for a decision model such as Jev or Laya (the
`ProviderUsageKind` names from `lib/runtime/invocationUsage.ts`). A
`promptCompletion` from a decision model also carries `decision`, with what
the model was actually sent and what it answered, because `messages` holds
the chat thread and a decision model never sees a chat:

- `state`: the thread as the model read it, role and text only;
- `questions`: what the response type became, keyed by question name;
- `answers`: the model's reply, with each answer's confidence and
  probabilities, before it was turned back into the value.

The state is text only by construction (`messagesToState` reads the content
getter, which joins text parts and drops attachments), so it needs no
redaction of its own. The echoed `completion` on a decision call leaves out
`rawData`, which would repeat the answers. The `decisionOf` and `usageKindOf` accessors in
`lib/statelog/wireAccessors.ts` read the fields; both are absent on logs
from before they were recorded.

A completion records three thread fields:

- `threadId` is the local registry key, such as `"0"`. Fresh tool stores can
  reuse this key for different conversations.
- `threadIdentity` is the serialized `MessageThread.id`. Interrupt resume,
  named sessions, and `thread(continue:)` preserve it. Handoff calls also use
  the caller's identity. New threads and subthreads have separate identities.
- `threadLabel` is the optional label from `thread(label:)`.

The ids returned by `std::thread` use the registry key with a `t` prefix.
`threadIdentity` is an observability field, not an argument to `getThread`
or `thread(continue:)`. See the [cross-thread context guide](../../site/guide/cross-thread-context.md).
Older logs lack `threadIdentity`; the rounds viewer keeps their conversations
separate across spans because registry keys alone cannot establish identity.

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

Checkpoints: `checkpointCreated`, `checkpointRestored`. When the prompt runner's step bailout, a batch (tool calls, fork, race), or the guard gate takes a checkpoint for interrupts, the event lists them in `interrupts`: each one's `interruptId`, `origin`, and the same `effect`, `message`, and `data` summary the interrupt events carry, with `debugger: true` on a debugger stop. The handler chain logs every interrupt raised through it (`handlerDecision`, `interruptResolved`, and `interruptThrown` for one that goes to a person). Two kinds are made outside the chain and appear only here: a debugger stop, and a guard question re-asked on a resume (`guardTripInterrupt.ts`). The checkpoint an `interrupt` statement takes for itself (`agencyInterrupt.ts`, and the `interruptReturn` and `interruptAssignment` templates) logs no `checkpointCreated` event yet.

### A resumed run opens its span before it restores

A resume (an interrupt response, `resumeFromCheckpoint`, or the `agency
resume` command) runs in a fresh execution context. It opens its `agentRun`
span and logs `agentStart` first, and only then restores the checkpoint. So
`checkpointRestored` and the user's `interruptResolved` are the second and
third events in that span, not span-less events at the trace root. Restoring
replaces the state stack and globals but never the span stack, which is why
the span can be opened first. `tests/agency-js/resume-events-in-span` pins
this order. A rewind (`rewindFrom`) is the one restore path that opens no
`agentRun` span at all: it is a replay in a fresh trace with no run
lifecycle, so its `checkpointRestored` sits at the trace root.

Fork/race: `forkStart`, `forkBranchEnd`, `forkEnd`.

Threads: `threadCreated`, `threadResumed`, `threadRepaired`,
`threadEndHooksStart`, `threadEndHooksEnd`, `threadEndHookError`.
`threadRepaired` fires when a reopened thread was structurally invalid and
`repairAbandonedTurn` synthesized the missing tool results.

Turns: `turnStart` (`message`): a person sent the program a message. The
`repl` functions log one per submitted line that is not a slash command, and
`turnStart` in `std::statelog` logs one from anywhere else. The logs viewer
splits a session into turns at these and reports the time between a turn's
last event and the next `turnStart` as waiting for the person; a
`threadResumed` is not a turn, since the runtime logs it whenever a named
session thread is re-entered, with no person involved.

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
- **Non-blocking** — remote posts are detached; `exitProcess` waits for them
  once, before the process exits.
- **Format versioning** — bump `STATELOG_FORMAT_VERSION` when the wire format
  changes in a way a viewer must notice; viewers should reject a higher version.
