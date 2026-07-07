---
name: Callbacks
description: Documents Agency's callback hooks (e.g. `onNodeStart`) that can be registered from Agency files via `callback(...)` or passed in from TypeScript when invoking a node, including scoping rules and the no-interrupts-in-callbacks restriction.
---

# Callbacks

Agency exposes a number of hooks. It's possible to write callbacks for these hooks in Agency or TypeScript. Here are both options.

## Callbacks in Agency

```ts
callback("onNodeStart") as data {
  print(`Node ${data.nodeName} started.`)
}
```

Callbacks are scoped to the function or node they reside in. Callbacks in the global scope are always active.

## Callbacks in TypeScript

```ts
import { main } from "agency"
const callbacks = {
  onNodeStart: (data) => {
    console.log(`Node ${data.nodeName} started.`)
  }
}

const result = main(param1, param2, { callbacks })
```

The last argument to `main()` is an options object. You can pass in a `callbacks` object here.

Note that:
- Callback bodies cannot raise interrupts. 
- Callbacks can't change the flow of execution.

## List of hooks

### onAgentStart
Called when an agent starts executing.

- `nodeName`: the name of the entry node
- `args`: the arguments passed to the agent
- `messages`: the initial message history
- `cancel(reason?)`: call this to cancel the agent at any point.

### onAgentEnd
Called when an agent finishes executing.

- `nodeName`: the name of the entry node (the same node reported by `onAgentStart`)
- `result`: the result of running the agent

### onNodeStart
Called when a graph node begins executing.

- `nodeName`: the name of the node

### onNodeEnd
Called when a graph node finishes executing.

- `nodeName`: the name of the node
- `data`: the data returned by the node

### onLLMCallStart
Called before an LLM call is made. Side-effect only — the callback's return value is ignored, and it cannot alter the messages sent to the LLM.

- `prompt`: the prompt — either a string, or an array of text/attachment parts (redacted for logging)
- `tools`: the tools available to the LLM, each with `name`, `description`, and `schema`
- `model`: the model being used
- `messages`: the messages that will be sent

### onLLMCallEnd
Called after an LLM call completes. Side-effect only — the callback's return value is ignored, and it cannot alter the messages stored in the thread.

- `model`: the model that was used
- `result`: the full prompt result from the LLM
- `usage`: token usage statistics (if available)
- `cost`: estimated cost (if available)
- `timeTaken`: how long the call took in milliseconds
- `messages`: the messages that were sent

### onLLMRetry
Called just before the backend waits to retry an LLM call after a transient failure (see [retries and timeouts](/guide/llm-part-2#retries-and-timeouts)). Side-effect only — it cannot change whether the retry happens.

- `attempt`: the retry attempt number, starts at 1 (retry 1, 2, …)
- `maxRetries`: the configured max retry count
- `delayMs`: how long the backend will wait before this retry
- `reason`: why we're retrying — `"timeout"`, `"connectionLost"`, `"streamInterrupted"`, `"rateLimit"`, `"serverError"`, or `"overloaded"`
- `detail`: the raw provider message

### onLLMTimeout
Called whenever an LLM call exceeds its per-call deadline (`timeout`), whether or not a retry follows.

- `limitMs`: the deadline that was exceeded
- `attempt`: the 0-based attempt that timed out

### onOAuthRequired
Called when an MCP server needs OAuth authorization before it can be used.

- `serverName`: the name of the server requesting authorization
- `authUrl`: the URL the user must visit to authorize
- `complete`: a `Promise<void>` that resolves once authorization finishes
- `cancel()`: call this to cancel the authorization flow

### onFunctionStart
Called when a function (tool) begins executing. Fires for every Agency `def` — both your own functions and the auto-imported stdlib functions (`print`, `sleep`, `range`, `fetch`, …). It does *not* fire for language built-ins such as `interrupt`, `checkpoint`, `llm`, or `fork`, which compile to dedicated constructs rather than function bodies.

- `functionName`: the name of the function
- `args`: the arguments passed to the function
- `moduleId`: the module the function belongs to

### onFunctionEnd
Called when a function (tool) finishes executing.

- `functionName`: the name of the function
- `timeTaken`: how long the function took in milliseconds

### onEmit
Called when agency code invokes `emit(...)`. Receives whatever value was passed to `emit`.

### onToolCallStart
Called when the LLM invokes a tool call.

- `toolName`: the name of the tool being called
- `args`: the arguments passed to the tool

### onToolCallEnd
Called when a tool call finishes.

- `toolName`: the name of the tool
- `result`: the result returned by the tool
- `timeTaken`: how long the tool call took in milliseconds

### onStream
Called during streaming LLM responses. The data is a tagged union with one of these types:

- `{ type: "text", text }` — a chunk of streamed text
- `{ type: "tool_call", toolCall }` — a streamed tool call
- `{ type: "done", result }` — streaming is complete
- `{ type: "error", error }` — an error occurred during streaming

### onTrace
Called for each trace line emitted during execution. Providing this callback automatically activates tracing for the execution. Receives a `TraceEvent` object:

- `runId`: a unique id identifying this run (useful for distinguishing concurrent requests)
- `line`: the trace line, one of:
  - `{ type: "header", ... }` — trace metadata (first line)
  - `{ type: "chunk", hash, data }` — content-addressed data block
  - `{ type: "manifest", ... }` — checkpoint reference (one per step)
  - `{ type: "footer", checkpointCount, chunkCount, timestamp }` — emitted when execution completes

### onThreadStart
Called when a thread or subthread begins.

- `threadId`: the thread's id in slug form (e.g. `"t3"`)
- `threadType`: either `"thread"` or `"subthread"`
- `parentThreadId`: the parent thread's id in slug form, when present
- `label`: the label from `thread(label: "...") { ... }`, if any
- `isResumption`: `true` when the thread is entered via continue/session

### onThreadEnd
Called when a thread closes.

- `threadId`: the thread's id in slug form
- `label`: the thread's label, if any
- `eagerSummarize`: whether the thread was opened with `thread(summarize: true)`
- `messages`: a `MessageJSON[]` snapshot of the thread at close
