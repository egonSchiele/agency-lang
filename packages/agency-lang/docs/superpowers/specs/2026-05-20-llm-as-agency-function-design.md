# Rewriting `llm()` as an Agency Function

## Summary

Rewrite the `llm()` built-in from a compiler-special-cased call into a regular Agency function backed by thin TypeScript helpers. This makes `llm()` a first-class function that gets full runner step-tracking, enabling debugger stepping through LLM calls, interrupts from within the LLM call lifecycle, and composability with partial application, pipe chains, and tool usage.

## Dependencies

- **Generic functions**: `llm()` needs a generic parameter `T` so that `schema(T)` can generate the structured output schema. Generic functions must be implemented first (separate PR). The type annotation inference rule — if the function has a single generic return type parameter, the compiler infers it from the LHS type annotation — must also be in place. The generic functions implementation must also support `schema(T)` inside generic function bodies — the expected mechanism is that the compiler generates the Zod schema at the call site (where `T` is concrete) and passes it as a hidden parameter, similar to how context-injected builtins get `__ctx` prepended.
- **Thread builtins spec** (`2026-05-20-thread-builtins-and-stdlib-design.md`): The `std::thread` module and `__systemMessage`/`__userMessage`/`__assistantMessage` builtins.

## Motivation

Today, `llm()` is a compiler-special-cased call. The compiler detects `llm(...)` in `typescriptBuilder.ts:processLlmCall()`, generates a Zod schema from the LHS type annotation, and emits a direct call to `runPrompt()` — a 700-line TypeScript function in `lib/runtime/prompt.ts`.

This has several problems:

1. **Black box to the debugger.** The user calls `llm()` and waits. They can't step through the LLM call, see tool dispatch, or inspect intermediate state. The entire LLM interaction is invisible.

2. **Callbacks can't affect execution.** Callbacks like `onLLMCallEnd` fire in TypeScript code outside the runner's step-tracking. They can observe but cannot throw interrupts or halt execution. This blocks features like cost guards.

3. **Not composable.** `llm()` can't be used as a tool, in a pipe chain, or with partial application. It's not a real function — it's compiler magic.

4. **Tool calls are sequential.** When the LLM requests multiple tool calls in one round, they execute sequentially. Making them parallel (via `fork`) would be faster and is the expected behavior.

Making `llm()` a regular Agency function solves all of these. The runner provides step tracking (debugger), interrupt support (guards), and composability (it's just a function).

## Design

### The `llm()` function signature

```agency
def llm<T>(
  prompt: string,
  model: string = "",
  provider: string = "",
  apiKey: string = "",
  maxTokens: number = 0,
  temperature: number = -1,
  stream: boolean = false,
  reasoningEffort: string = "",
  tools: any[] = [],
  metadata: any = {},
  memory: boolean = false,
  maxToolCallRounds: number = 10
): T {
  """
  Make a call to a large language model.
  @param prompt - The prompt to send to the LLM
  @param model - The model to use (e.g., "gpt-4o")
  @param provider - The provider to use (e.g., "openai")
  @param tools - Functions to make available as tools
  @param memory - Whether to inject relevant memory context
  """
  // implementation
}
```

Key changes from current API:
- **Generic parameter `T`**: Drives structured output. The function calls `schema(T)` to generate the Zod schema. If `T` is unspecified (no type annotation), `T` defaults to `string` and no schema is generated (the LLM returns unstructured text).
- **Flat parameters instead of options object**: All options are named parameters with defaults. This enables partial application: `const gpt4 = llm.partial(model: "gpt-4o")`.
- **`tools` as a parameter**: Users can partially apply tools: `const researcher = llm.partial(tools: [search, fetch])`.

### Usage

Basic usage (unchanged from the user's perspective):
```agency
const response = llm("What is the capital of France?")
```

With structured output:
```agency
const numbers: number[] = llm("Return the first 5 Fibonacci numbers")
```

With tools:
```agency
const result = llm("Search for info about Agency", tools: [search])
```

Partial application:
```agency
const researcher = llm.partial(model: "gpt-4o", tools: [search, fetch])
const result = researcher("Find info about Agency")
```

In a pipe chain:
```agency
const result = success("What is 2+2?") |> llm.partial(model: "gpt-4o")
```

As a tool for another LLM:
```agency
const summary = llm("Summarize this topic", tools: [llm.partial(model: "gpt-4o-mini")])
```

### Implementation: Agency code + TS helpers

The `llm()` function is Agency code that calls TS helpers for the pieces that require direct smoltalk/runtime access. The Agency code owns the control flow (the loop, tool dispatch via fork, error handling), while TS code handles the protocol details.

#### Sketch of the Agency implementation

```agency
def llm<T>(prompt: string, /* ...options */): T {
  // Step 1: Prepare
  const responseFormat = schema(T)
  if (memory) {
    __injectMemoryContext(prompt)
  }
  __pushUserMessage(prompt)

  // Step 2: Initial LLM call
  let response = __callLLM(responseFormat, /* ...config */)

  // Step 3: Tool loop
  let round = 0
  while (__hasToolCalls(response) && round < maxToolCallRounds) {
    const toolCalls = __getToolCalls(response)

    // Tool calls run in parallel via fork
    const results = fork(toolCalls) as toolCall {
      const toolFn = __getToolFunction(toolCall.name, tools)
      const result = __invokeTool(toolFn, toolCall.args)
      return __processToolResult(toolCall, result, toolFn)
    }

    // Push tool results back as messages
    for (toolResult in results) {
      __pushToolMessage(toolResult)
    }

    // Next LLM round
    round = round + 1
    response = __callLLM(responseFormat, /* ...config */)
  }

  // Step 4: Extract and return
  return __extractResponse(response, responseFormat)
}
```

This is a sketch — the actual implementation will need to handle edge cases (tool crashes, retryability, tool removal after repeated failures, etc.). But the key point is that the control flow is Agency code, which means every step is tracked by the runner.

#### TS helpers

| Helper | Purpose |
|--------|---------|
| `__callLLM(responseFormat, config)` | Make the actual LLM API call via the configured client (smoltalk). Handles streaming internally (see open questions). Returns the parsed response. Fires `onLLMCallStart`/`onLLMCallEnd` callbacks. Records telemetry (cost, tokens, timing) to statelog. |
| `__hasToolCalls(response)` | Check if the LLM response contains tool calls. |
| `__getToolCalls(response)` | Extract tool calls from the response as Agency-friendly objects (arrays of `{ id, name, args }`). |
| `__getToolFunction(name, tools)` | Look up an `AgencyFunction` by name from the tools array. Returns the function or null if not found. |
| `__invokeTool(toolFn, args)` | Invoke a tool function with the given arguments. This is a thin wrapper around `AgencyFunction.invoke()`. |
| `__processToolResult(toolCall, result, toolFn)` | Handle the result of a tool call. Categorizes the result (success, failure, crash, interrupt) and returns a structured object that the Agency code uses to decide what to do. Handles retryability checks (the `safe` keyword), error counting, and tool removal logic. |
| `__pushToolMessage(toolResult)` | Push a tool result message onto the active thread with the correct `tool_call_id`. |
| `__pushUserMessage(prompt)` | Push a user message onto the active thread. (May reuse `__userMessage` from the thread builtins spec.) |
| `__extractResponse(response, schema)` | Extract the final response from the LLM's last message. If a schema is provided, parse and validate against it. |
| `__injectMemoryContext(prompt)` | Query the memory layer for relevant context and inject it as a transient system message. |

All helpers use the `__internal_` prefix for consistency with existing context-injected builtins (e.g., `__internal_callLLM`, `__internal_hasToolCalls`). They receive `__ctx` automatically via the context-injection mechanism in `lib/codegenBuiltins/contextInjected.ts`.

### Checkpoint and resume

Because `llm()` is an Agency function with runner step-tracking, checkpoint/resume is largely handled automatically by the runner. Local variables (`response`, `round`, `tools`) are stored in the frame's locals and survive serialization. The `while` loop's iteration counter is tracked via substeps. The `fork` for tool calls creates branches with isolated state, which the runner serializes and restores.

Key points:
- **The LLM response** from `__callLLM` must be serializable. The TS helper should return a plain object (not smoltalk classes) so it can round-trip through `JSON.stringify`/`JSON.parse`.
- **The `fork` within the `while` loop** needs unique branch keys per iteration. The runner's existing substep tracking handles this — each loop iteration gets its own substep scope, and fork within that scope gets iteration-specific branch keys.
- **The `tools` array** may be mutated during execution (tools removed after failures). Since it's a local variable in the Agency function, the mutated version is saved in the frame and restored on resume.
- **Message thread state** is managed by the TS helpers (`__internal_pushUserMessage`, `__internal_pushToolMessage`), which push messages onto the active thread. On resume, the thread's messages are restored from the `ThreadStore` serialization (already handled by the existing checkpoint system).

The current `runPrompt` has ~150 lines of manual checkpoint/resume logic (saving `messagesJSON`, `pendingToolCalls`, etc. to frame locals). Most of this becomes unnecessary because the runner handles it automatically. The main exception is message thread restoration on resume — the TS helpers may need to handle the case where messages need to be re-synced with the thread after deserialization.

### Cross-call tool removal

In the current implementation, `__removedTools` is stored on the node's locals (`self.__removedTools`), so tools removed in one `llm()` call stay removed for subsequent calls in the same node. In the Agency function version, `tools` is a local parameter — tool removal within one call won't persist to the next.

This is an acceptable behavioral change. Cross-call tool removal was a convenience, not a safety feature. If a tool crashes repeatedly, it will crash again in the next call and be removed again. The per-call isolation is actually cleaner — each `llm()` call starts fresh.

### What this enables

#### Debugger stepping through LLM calls

Every step in the `llm()` function becomes a debuggable step. Users can:
- Step through the initial LLM call
- See each tool call being dispatched
- Inspect tool results before the next LLM round
- Watch the tool loop iterate

This is a major improvement over the current black-box behavior.

#### Interrupts from callbacks

Because `llm()` is now inside the runner, callbacks fire at step boundaries. A scoped callback in `onLLMCallEnd` can signal an interrupt, and the runner can handle it between steps. This enables cost guards:

```agency
def guard(limit: number, block: () => any): Result {
  let totalCost = 0
  callback onLLMCallEnd(data) {
    totalCost = totalCost + data.cost.totalCost
    if (totalCost > limit) {
      return interrupt guard::costExceeded(
        "Cost limit exceeded",
        { cost: totalCost, limit: limit }
      )
    }
  }
  return block()
}
```

The interrupt fires between steps inside `llm()`, the handler chain runs, and execution either continues or halts. The full execution state (including partial results from completed tool calls) is preserved in the checkpoint.

Note: the guard example above requires scoped callbacks to support interrupts. The scoped callbacks spec (`2026-05-20-scoped-callbacks-design.md`) currently defers this as a "future extension." This spec assumes that capability will be added — the scoped callbacks spec should be updated to include interrupt support as a requirement (not a future extension) once this spec is approved.

#### Parallel tool calls

Tool calls within one LLM round execute in parallel via `fork`. If any tool throws an interrupt, Agency's existing concurrent interrupt batching handles it — all interrupts are collected and returned to the user.

#### Composability

`llm()` is a regular function. It can be:
- Used as a tool for another LLM call
- Used in a pipe chain
- Partially applied to create specialized variants
- Used with `.describe()` to customize its tool description
- Used with `.preapprove()` to auto-approve its interrupts

### Migration

#### Breaking changes

- **Options object → named parameters**: `llm("prompt", { model: "gpt-4o", tools: [add] })` becomes `llm("prompt", model: "gpt-4o", tools: [add])`. This is a breaking change. All existing code using the options object syntax needs to be updated.
- **`system()` removal**: Already covered by the thread builtins spec.

#### Compiler changes

The compiler no longer special-cases `llm()` calls. The `processLlmCall()` method in `typescriptBuilder.ts` is removed. Instead, `llm()` is imported from the stdlib and called like any other function. The generic parameter `T` is resolved by the compiler's generic function support, and `schema(T)` generates the Zod schema at the call site.

## Open questions

### Streaming

There are two approaches for how streaming works in the Agency `llm()` function:

#### Option A: Streaming stays entirely in TS (inside `__callLLM`)

The `__callLLM` helper handles the entire stream internally — assembles chunks, fires `onStream` callbacks, returns the final complete response. From Agency's perspective, `__callLLM` is just a function that takes a while and returns a response. The Agency `llm()` code is identical for streaming and non-streaming.

**Pros:**
- Simple. The Agency `llm()` function doesn't need to know about streaming.
- The chunk assembly logic (partial JSON across multiple chunks, partial tool calls) is fiddly protocol work better expressed in TS.
- No new Agency primitives needed.

**Cons:**
- The stream is a black box to the debugger. Users can't step through individual chunks.
- Users can't write Agency code that reacts to individual chunks.
- `onStream` callbacks are TS-side only (though the existing callback system already handles this).

#### Option B: Streaming partially in Agency (Agency controls the chunk loop)

`__callLLM` returns a stream-like object. Agency code loops over chunks, processing each one, firing callbacks at each step. Something like:

```agency
let stream = __startLLMStream(config)
while (__hasNextChunk(stream)) {
  const chunk = __nextChunk(stream)
  __processChunk(stream, chunk)
}
const response = __finalizeStream(stream)
```

**Pros:**
- Debugger can step through streaming. Each chunk is a visible step.
- Users could write scoped callbacks that react to individual chunks.
- More consistent with the "everything is visible in Agency" philosophy.

**Cons:**
- Significantly more complex. Agency would need some way to iterate over an async stream.
- The chunk protocol (partial JSON, partial tool calls, tool call assembly) is very TS-specific. Exposing it to Agency adds complexity without much user benefit.
- More TS helpers needed.

### Tool failure handling granularity

The sketch above uses `__processToolResult` as a single TS helper that encapsulates all the failure categorization logic (crash vs failure vs rejection, retryability, error counting, tool removal). An alternative is to express more of this logic in Agency:

```agency
if (isFailure(result)) {
  if (toolFn.safe) {
    // retryable — let the LLM try again
    __pushToolErrorMessage(toolCall, result.error)
  } else {
    // not retryable — remove the tool
    tools = filter(tools) as t { return t.name != toolCall.name }
    __pushToolErrorMessage(toolCall, result.error)
  }
}
```

This gives users more visibility into failure handling via the debugger but adds verbosity to the `llm()` function. The right split between Agency and TS for this logic needs to be determined during implementation.

### How `__callLLM` fires callbacks

`__callLLM` is a TS helper that makes the actual LLM API call. It currently fires `onLLMCallStart` and `onLLMCallEnd` callbacks. With `llm()` as an Agency function inside the runner, these callbacks could potentially fire at a point where the runner can handle interrupts.

The question is: does `__callLLM` fire the callbacks internally (as it does today), or does the Agency `llm()` code fire them explicitly at step boundaries?

If `__callLLM` fires them internally, they're still in TS code, but since `__callLLM` is called from within a runner step, the callback could return a signal that `__callLLM` propagates back to the Agency code as a special return value. The Agency code then checks for it and throws an interrupt if needed.

If the Agency code fires them explicitly:
```agency
__fireCallback("onLLMCallStart", { prompt, tools, model, messages })
let response = __callLLM(config)
const callbackResult = __fireCallback("onLLMCallEnd", { model, response, cost, usage })
if (callbackResult.shouldInterrupt) {
  return interrupt(callbackResult.message, callbackResult.data)
}
```

This is more explicit and gives the runner full visibility, but adds boilerplate. The right approach depends on how scoped callbacks (separate spec) evolve.

### Message thread management

The current `runPrompt` takes a `MessageThread` object and mutates it directly. The Agency `llm()` function would use the `__pushUserMessage`, `__pushToolMessage`, etc. helpers to add messages to the active thread. But some operations (like restoring `messagesJSON` on resume, or stripping transient memory injection messages) are more complex and may need dedicated helpers.

### Validation syntax with generic functions

Currently users can write `const x: number[]! = llm("...")` to get both structured output AND runtime validation. With generic functions, the structured output comes from `T` and validation comes from `!`. The interaction between these needs to be specified — does `llm<number[]!>(...)` make sense? Or is `!` always on the variable annotation, never on the generic parameter? This is likely a question for the generic functions spec rather than this one.

## Relationship to other specs

This spec **supersedes parts of** the cost-and-guard-tracking spec (`2026-05-20-cost-and-guard-tracking-design.md`). Specifically:
- Guards no longer need `__pushGuard`/`__popGuard` builtins or `GuardExceededError`. Instead, guards use scoped callbacks + interrupts, which work because `llm()` is now inside the runner.
- The guard function becomes a scoped callback that checks cost in `onLLMCallEnd` and throws an interrupt if exceeded.

This spec **builds on** the scoped callbacks spec (`2026-05-20-scoped-callbacks-design.md`). Scoped callbacks become more powerful because they fire at step boundaries inside the runner, enabling them to affect control flow via interrupts.

This spec **builds on** the thread builtins spec (`2026-05-20-thread-builtins-and-stdlib-design.md`) for message manipulation helpers.

## Files to modify

### New files
- `stdlib/llm.agency` — the `llm()` function implementation
- `stdlib/lib/llm.js` (or `.ts`) — TS backing file with all `__` helpers

### Modified files
- `lib/backends/typescriptBuilder.ts` — remove `processLlmCall()` special case; `llm()` is now a regular function call
- `lib/codegenBuiltins/contextInjected.ts` — register all `__internal_` helpers
- `lib/typeChecker/builtins.ts` — remove `llm` special case, add as generic function type
- `lib/config.ts` — register `std::llm` or add to `std::thread` module (TBD where `llm` lives)
- `lib/runtime/prompt.ts` — refactor into individual helper functions callable from Agency; `runPrompt` may be retained as a TS-only fallback or removed entirely

### Removed
- The `processLlmCall()` method in `typescriptBuilder.ts` and associated template code
