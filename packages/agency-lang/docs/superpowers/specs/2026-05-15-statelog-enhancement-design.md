# StateLog Enhancement Design Spec

## Problem Statement

Agency's StateLog observability system captures graph structure, node lifecycle, LLM calls, tool calls, and edge transitions. But several critical categories of execution events are invisible:

1. **Token usage and cost** — the runtime already computes `completion.usage` and `completion.cost` per LLM call, and accumulates them in `__tokenStats`, but StateLog never receives this data. There is no way to build cost dashboards or token usage charts.

2. **Interrupt lifecycle** — interrupts and handlers are Agency's core safety feature, but StateLog captures nothing about them. When an interrupt fires, which handlers ran, what they decided, and the final outcome are all invisible.

3. **Checkpoint and restore** — checkpoint creation and restore events are invisible. There's no way to see retry behavior, rewind events, or how often checkpoints are used.

4. **Fork and race** — parallel execution branches are invisible. There's no way to see which branches ran, how long each took, which branch won a race, or which branches interrupted.

5. **Thread lifecycle** — thread and subthread creation is invisible. There's no way to see conversation isolation patterns.

6. **Structured errors** — errors and failures are logged as generic debug messages. There's no way to filter by error type, see retry counts, or identify which tools fail most.

7. **Run-level metadata** — there's no way to attach tags, environment, user ID, or agent version to a trace. This makes it impossible to filter or group runs in a dashboard.

8. **Span nesting** — events are flat (no parent-child relationships). There's no way to see that a tool call happened inside an LLM call, which happened inside a node.

## Goals

- Enrich StateLog to capture all significant execution events
- Add span IDs and parent span IDs for hierarchical nesting
- Add token usage and cost to LLM call events
- Add run-level metadata (tags, environment, user-defined key-value pairs)
- Maintain the existing zero-overhead opt-in model (no logging unless configured)
- Keep events lightweight (fire-and-forget JSON posts, not full state snapshots)
- Align event semantics with OpenTelemetry GenAI conventions where natural, to simplify a future OTel export adapter

## Non-Goals

- Building the observability UI (separate project)
- Building the OTel export adapter (separate project, consumes these events)
- Changing the trace system (TraceWriter captures full checkpoints; StateLog captures lightweight structured events — they are complementary)
- Adding sampling or batching (can be added later)

## Design

### Span model

Every event belongs to a **span**. A span has a start time, end time, type, and optional parent. This gives events hierarchical structure.

```
Trace (one per agent run, identified by traceId)
├── Span: agentRun
│   ├── Span: nodeExecution "main"
│   │   ├── Span: llmCall
│   │   │   ├── Event: llmCallStart
│   │   │   ├── Event: llmCallEnd (tokens, cost, latency)
│   │   │   ├── Span: toolExecution "searchDB"
│   │   │   │   ├── Event: toolStart
│   │   │   │   ├── Event: interruptThrown
│   │   │   │   ├── Event: handlerDecision (handler 1: approve)
│   │   │   │   ├── Event: handlerDecision (handler 2: reject)
│   │   │   │   ├── Event: interruptResolved (rejected)
│   │   │   │   └── Event: toolEnd (failure)
│   │   │   └── Span: toolExecution "formatResults"
│   │   │       ├── Event: toolStart
│   │   │       └── Event: toolEnd (success)
│   │   └── Span: llmCall (follow-up round)
│   │       ├── Event: llmCallStart
│   │       └── Event: llmCallEnd
│   ├── Event: nodeTransition "main" → "categorize"
│   └── Span: nodeExecution "categorize"
│       └── ...
```

### SpanContext

A new lightweight object that tracks the current span hierarchy. Stored on `RuntimeContext`.

```typescript
type SpanContext = {
  spanId: string;       // nanoid, 12 chars
  parentSpanId: string | null;
  spanType: SpanType;
  startTime: number;    // performance.now()
};

type SpanType =
  | "agentRun"
  | "nodeExecution"
  | "llmCall"
  | "toolExecution"
  | "forkAll"
  | "forkBranch"
  | "race"
  | "raceBranch"
  | "handlerChain";
```

`RuntimeContext` gets two new methods:

```typescript
// Push a new child span, returns the spanId
startSpan(type: SpanType): string;

// Pop the current span, logs the span end event
endSpan(): void;

// Read the current span context (for attaching to events)
get currentSpan(): SpanContext;
```

The span stack is a simple array on `RuntimeContext`. `startSpan` pushes, `endSpan` pops. The current span's `spanId` is automatically attached to every event sent via `post()`.

### Enhanced StatelogClient API

The existing methods stay as-is for backward compatibility. New methods are added alongside them.

#### New fields on every event

Every event posted via `post()` gains these fields automatically:

```typescript
{
  trace_id: string;      // existing
  project_id: string;    // existing
  span_id: string;       // NEW — from currentSpan
  parent_span_id: string | null; // NEW — from currentSpan
  timestamp: string;     // existing (ISO 8601)
  data: { ... }          // existing
}
```

#### Run-level metadata

A new method sets metadata once per run. This metadata is attached to the root `agentRun` span and can be used for filtering/grouping.

```typescript
async runMetadata(metadata: {
  tags?: string[];
  environment?: string;
  userId?: string;
  agentVersion?: string;
  moduleName?: string;
  entryNode?: string;
  custom?: Record<string, string>;
}): Promise<void>;
```

Emits event type: `"runMetadata"`.

#### Enhanced promptCompletion

Add token usage and cost to the existing `promptCompletion` method. This is a non-breaking change — the new fields are optional.

```typescript
async promptCompletion({
  messages,
  completion,
  model,
  timeTaken,
  tools,
  responseFormat,
  // NEW fields:
  usage,
  cost,
  finishReason,
  stream,
}: {
  messages: any[];
  completion: any;
  model?: ModelName | string;
  timeTaken?: number;
  tools?: { name: string; description?: string; schema: any }[];
  responseFormat?: any;
  // NEW:
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    totalTokens: number;
  };
  cost?: {
    inputCost: number;
    outputCost: number;
    totalCost: number;
  };
  finishReason?: string;
  stream?: boolean;
}): Promise<void>;
```

#### New event methods

```typescript
// === Interrupt lifecycle ===

async interruptThrown({
  interruptId,
  interruptData,
  functionName,
  sourceLocation,
}: {
  interruptId: string;
  interruptData: any;
  functionName?: string;
  sourceLocation?: { moduleId: string; line?: number };
}): Promise<void>;

async handlerDecision({
  interruptId,
  handlerIndex,
  decision,
  value,
}: {
  interruptId: string;
  handlerIndex: number;
  decision: "approve" | "reject" | "propagate" | "none";
  value?: any;
}): Promise<void>;

async interruptResolved({
  interruptId,
  outcome,
  resolvedBy,
  timeTaken,
}: {
  interruptId: string;
  outcome: "approved" | "rejected" | "propagated";
  resolvedBy: "handler" | "user" | "policy" | "ipc";
  timeTaken?: number;
}): Promise<void>;

// === Checkpoint lifecycle ===

async checkpointCreated({
  checkpointId,
  reason,
  sourceLocation,
}: {
  checkpointId: number;
  reason: "interrupt" | "explicit" | "failure" | "fork" | "race" | "trace";
  sourceLocation?: { moduleId: string; scopeName: string; stepPath: string };
}): Promise<void>;

async checkpointRestored({
  checkpointId,
  restoreCount,
  maxRestores,
  overrides,
}: {
  checkpointId: number;
  restoreCount: number;
  maxRestores?: number;
  overrides?: { args?: boolean; globals?: boolean; locals?: boolean };
}): Promise<void>;

// === Fork/Race lifecycle ===

async forkStart({
  forkId,
  mode,
  branchCount,
}: {
  forkId: string;
  mode: "all" | "race";
  branchCount: number;
}): Promise<void>;

async forkBranchEnd({
  forkId,
  branchIndex,
  outcome,
  timeTaken,
}: {
  forkId: string;
  branchIndex: number;
  outcome: "success" | "failure" | "interrupted" | "aborted";
  timeTaken: number;
}): Promise<void>;

async forkEnd({
  forkId,
  mode,
  timeTaken,
  winnerIndex,
}: {
  forkId: string;
  mode: "all" | "race";
  timeTaken: number;
  winnerIndex?: number; // race only
}): Promise<void>;

// === Thread lifecycle ===

async threadCreated({
  threadId,
  threadType,
  parentThreadId,
}: {
  threadId: string;
  threadType: "thread" | "subthread";
  parentThreadId?: string;
}): Promise<void>;

// === Structured errors ===

async error({
  errorType,
  message,
  functionName,
  retryable,
  sourceLocation,
}: {
  errorType: "toolError" | "llmError" | "runtimeError" | "validationError" | "limitExceeded";
  message: string;
  functionName?: string;
  retryable?: boolean;
  sourceLocation?: { moduleId: string; line?: number };
}): Promise<void>;

// === Agent lifecycle ===

async agentStart({
  entryNode,
  args,
}: {
  entryNode: string;
  args?: any;
}): Promise<void>;

async agentEnd({
  entryNode,
  result,
  timeTaken,
  tokenStats,
}: {
  entryNode: string;
  result?: any;
  timeTaken: number;
  tokenStats?: {
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    cost: { inputCost: number; outputCost: number; totalCost: number };
  };
}): Promise<void>;
```

### Configuration changes

The existing `StatelogConfig` is extended:

```typescript
type StatelogConfig = {
  host: string;
  traceId?: string;
  apiKey: string;
  projectId: string;
  debugMode: boolean;
  observability?: boolean;
  // NEW:
  metadata?: {
    tags?: string[];
    environment?: string;
    userId?: string;
    agentVersion?: string;
    custom?: Record<string, string>;
  };
};
```

The `agency.json` config section becomes:

```json
{
  "observability": true,
  "log": {
    "host": "https://agency-lang.com",
    "projectId": "my-project",
    "apiKey": "...",
    "metadata": {
      "tags": ["production", "v2"],
      "environment": "production",
      "agentVersion": "1.2.0"
    }
  }
}
```

Users can also set metadata at runtime from TypeScript when calling a node:

```typescript
const result = await main("input", {
  metadata: {
    userId: "user-123",
    tags: ["premium-user"],
  },
});
```

This merges with the static `agency.json` metadata (runtime overrides win on conflicts).

## Integration points

This section lists every file that needs changes and what events to emit at each site.

### lib/statelogClient.ts

- Add `SpanContext` type and span stack management
- Add all new event methods listed above
- Add `span_id` and `parent_span_id` to the `post()` method's envelope
- Add `metadata` to the constructor config

### lib/runtime/state/context.ts (RuntimeContext)

- Add `startSpan()`, `endSpan()`, `currentSpan` to RuntimeContext
- Initialize span stack with a root `agentRun` span on context creation
- Copy `currentSpan` reference when creating child execution contexts

### lib/runtime/node.ts

- **Agent start**: In `runNode()`, after context setup (~line 155), call `ctx.statelogClient.agentStart()` and `ctx.statelogClient.runMetadata()`.
- **Agent end**: At the end of `runNode()`, call `ctx.statelogClient.agentEnd()` with final `tokenStats`.
- **Node execution span**: `ctx.startSpan("nodeExecution")` at entry, `ctx.endSpan()` at exit.
- **Restore event**: In the `RestoreSignal` catch block (~line 202), call `ctx.statelogClient.checkpointRestored()`.

### lib/runtime/prompt.ts

- **LLM call span**: `ctx.startSpan("llmCall")` before `_runPrompt()`, `ctx.endSpan()` after the full prompt loop completes.
- **Token usage and cost**: Add `usage: completion.usage` and `cost: completion.cost` and `finishReason` to the existing `promptCompletion()` call at line 120. The data is already available from the `completion` object.
- **Tool execution span**: `ctx.startSpan("toolExecution")` before `handler.invoke()` at line 447, `ctx.endSpan()` after.
- **Tool errors**: Call `ctx.statelogClient.error()` in the catch block at line 455 and in the `isFailure` path at line 475. Set `errorType: "toolError"`, include `retryable` status.
- **Interrupt from tool**: In the `hasInterrupts` block at line 527, call `ctx.statelogClient.interruptThrown()` for each interrupt.
- **Checkpoint from tool interrupts**: After `ctx.checkpoints.create()` at line 587, call `ctx.statelogClient.checkpointCreated()` with `reason: "interrupt"`.

### lib/runtime/interrupts.ts

- **Handler decisions**: In the `interruptWithHandlers()` loop (lines 137–192), after each handler returns, call `ctx.statelogClient.handlerDecision()` with the handler index and decision.
- **Interrupt resolved**: At each exit point of `interruptWithHandlers()` (rejection at line 164, approval at line 180, propagation at lines 187/192), call `ctx.statelogClient.interruptResolved()`.

`interruptWithHandlers` currently takes `ctx` as a parameter, so `statelogClient` is already accessible.

### lib/runtime/runner.ts

- **Fork start**: In `fork()` at line 548, call `ctx.statelogClient.forkStart()` with the mode and branch count.
- **Fork span**: `ctx.startSpan("forkAll")` or `ctx.startSpan("race")` in `fork()`.
- **Branch spans**: In `runForkAll()` and `runRace()`, wrap each branch's execution in `ctx.startSpan("forkBranch")` / `ctx.endSpan()`.
- **Branch end events**: After each branch in `runForkAll()` settles (line ~640), call `ctx.statelogClient.forkBranchEnd()`.
- **Fork end**: After `runForkAll()` or `runRace()` completes, call `ctx.statelogClient.forkEnd()`.
- **Race winner**: In `runRace()`, include `winnerIndex` in the `forkEnd` event.
- **Checkpoint from fork**: After `ctx.checkpoints.create()` at lines 659/752/815, call `ctx.statelogClient.checkpointCreated()` with `reason: "fork"` or `reason: "race"`.

### lib/runtime/state/threadStore.ts

- **Thread creation**: In `create()` and `createSubthread()`, call `ctx.statelogClient.threadCreated()`.
- This requires threading `statelogClient` into `ThreadStore`. The simplest approach: `ThreadStore` already lives on `RuntimeContext`, so add a method `ThreadStore.setStatelogClient(client)` that's called once during context setup. The `create` and `createSubthread` methods then fire the event if a client is set.

### lib/runtime/state/checkpointStore.ts

- **Checkpoint created**: After the checkpoint is stored in `create()` at line 241, call `ctx.statelogClient.checkpointCreated()`.
- This requires passing `statelogClient` into the checkpoint store, or having the caller (which already has `ctx`) emit the event. Recommendation: have the caller emit it, since all callers already have `ctx`. This avoids changing `CheckpointStore`'s constructor.

### lib/runtime/ipc.ts

- **Limit exceeded error**: In `makeLimitFailure()` at line 74, call `ctx.statelogClient.error()` with `errorType: "limitExceeded"`.
- **IPC interrupt resolution**: After the parent process receives and resolves an interrupt (lines 310–325), call `ctx.statelogClient.interruptResolved()` with `resolvedBy: "ipc"`.

### lib/simplemachine/graph.ts

- **Span wrapping**: Wrap the existing `enterNode`/`exitNode` calls with `startSpan("nodeExecution")` / `endSpan()` so they get span IDs. The SimpleMachine already has access to `statelogClient` — it just needs a reference to the span stack (or a thin wrapper).

### lib/runtime/schema.ts

- **Validation errors**: In the failure paths at lines 21 and 42, call `ctx.statelogClient.error()` with `errorType: "validationError"`.
- This requires `statelogClient` to be accessible. Since schema validation is called from generated code, the simplest approach is to have the generated code's caller emit the event. Alternatively, pass `statelogClient` via a module-level setter.

## OTel alignment

The new event types are designed to map naturally to OTel GenAI semantic conventions. The future `@agency-lang/otel` adapter would map:

| StateLog event | OTel span/attribute |
|---|---|
| `agentStart` / `agentEnd` | `invoke_agent` span |
| `nodeExecution` span | Child span of `invoke_agent` |
| `llmCall` span | `gen_ai.client` span, `gen_ai.request.model` attribute |
| `promptCompletion.usage` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| `promptCompletion.cost` | `gen_ai.client.token.usage` metric |
| `promptCompletion.finishReason` | `gen_ai.response.finish_reasons` |
| `toolExecution` span | `execute_tool` span |
| `error` events | Span status ERROR + exception event |
| `interruptThrown` / `handlerDecision` / `interruptResolved` | Custom span events with `agency.*` attribute prefix |
| `forkAll` / `race` spans | Child spans (parallel) |
| `threadCreated` | Custom event with `agency.thread.*` attributes |
| `runMetadata.tags` | Resource attributes |

Agency-specific concepts (interrupts, handlers, checkpoints, fork/race) use the `agency.*` attribute namespace. Generic backends will display them as raw key-value pairs; an Agency-aware UI can render them richly.

## Event type summary

For reference, here is the complete list of event types after enhancement:

| Event type | Status | Source file |
|---|---|---|
| `graph` | Existing | `simplemachine/graph.ts` |
| `enterNode` | Existing | `simplemachine/graph.ts` |
| `exitNode` | Existing | `simplemachine/graph.ts` |
| `beforeHook` | Existing | `simplemachine/graph.ts` |
| `afterHook` | Existing | `simplemachine/graph.ts` |
| `followEdge` | Existing | `simplemachine/graph.ts` |
| `promptCompletion` | Enhanced (add usage, cost, finishReason) | `runtime/prompt.ts` |
| `toolCall` | Existing | `runtime/prompt.ts` |
| `debug` | Existing | various |
| `diff` | Existing (unused) | none |
| `runMetadata` | **New** | `runtime/node.ts` |
| `agentStart` | **New** | `runtime/node.ts` |
| `agentEnd` | **New** | `runtime/node.ts` |
| `interruptThrown` | **New** | `runtime/prompt.ts`, `runtime/interrupts.ts` |
| `handlerDecision` | **New** | `runtime/interrupts.ts` |
| `interruptResolved` | **New** | `runtime/interrupts.ts`, `runtime/ipc.ts` |
| `checkpointCreated` | **New** | callers of `checkpointStore.create()` |
| `checkpointRestored` | **New** | `runtime/node.ts` |
| `forkStart` | **New** | `runtime/runner.ts` |
| `forkBranchEnd` | **New** | `runtime/runner.ts` |
| `forkEnd` | **New** | `runtime/runner.ts` |
| `threadCreated` | **New** | `runtime/state/threadStore.ts` |
| `error` | **New** | `runtime/prompt.ts`, `runtime/ipc.ts`, `runtime/schema.ts` |

## Wire format

After enhancement, a typical event on the wire looks like:

```json
{
  "trace_id": "abc123",
  "project_id": "my-project",
  "span_id": "sp_xk9m2n",
  "parent_span_id": "sp_root1",
  "data": {
    "type": "promptCompletion",
    "timestamp": "2026-05-15T14:30:00.000Z",
    "messages": [...],
    "completion": {...},
    "model": "gpt-4o",
    "timeTaken": 1234,
    "tools": [...],
    "responseFormat": {...},
    "usage": {
      "inputTokens": 1500,
      "outputTokens": 300,
      "cachedInputTokens": 200,
      "totalTokens": 1800
    },
    "cost": {
      "inputCost": 0.0015,
      "outputCost": 0.006,
      "totalCost": 0.0075
    },
    "finishReason": "stop",
    "stream": false
  }
}
```

And a new interrupt event:

```json
{
  "trace_id": "abc123",
  "project_id": "my-project",
  "span_id": "sp_tool1",
  "parent_span_id": "sp_llm1",
  "data": {
    "type": "interruptThrown",
    "timestamp": "2026-05-15T14:30:01.000Z",
    "interruptId": "int_abc",
    "interruptData": "Are you sure you want to delete 1000000 emails?",
    "functionName": "deleteEmail"
  }
}
```

## Backward compatibility

- All new fields on existing events (usage, cost, finishReason on `promptCompletion`) are optional. Existing server implementations that don't expect them will ignore them.
- The new `span_id` and `parent_span_id` fields in the envelope are additive. Existing servers will ignore unknown fields.
- The new event types (`interruptThrown`, `handlerDecision`, etc.) are new `type` values in the `data` object. Existing servers that switch on `type` will hit their default/unknown case.
- The `statelogClient.diff()` method is unused. It can be left as-is or removed; this spec does not change it.

## Testing strategy

### Unit tests

- `statelogClient.test.ts`: Test each new method emits the correct JSON structure. Test span ID propagation. Test that events are no-ops when host is unset.
- `spanContext.test.ts`: Test span push/pop, parent ID propagation, span type tracking.

### Integration tests

- Create a small Agency program that exercises: LLM call, tool call, interrupt, handler, checkpoint, restore, fork, thread.
- Run it with `observability: true` and `host: "stdout"` and capture the JSON output. Note: stdout mode is exempt from the API key requirement.
- Assert the event stream contains all expected event types in the correct order, with correct span nesting (parent IDs match), correct token/cost data, and correct interrupt lifecycle events.

### Fixture tests

- Update existing test fixtures that snapshot StateLog output (if any) to include the new fields.
- The `promptCompletion` events in existing tests will gain `usage`, `cost`, and `finishReason` fields with `undefined` values (since test LLM clients may not return them). Ensure these are handled gracefully.
