# Callbacks

Agency exposes a number of hooks. It's possible to write callbacks for these hooks in Agency files or pass them in when you run the node through TypeScript. Here are both options.

## Callbacks in Agency files

```ts
import { callback } from "std::agency"

callback("onNodeStart") as data {
  print(`Node ${data.nodeName} started.`)
}
```

Callbacks registered with `callback(name, fn)` are scoped to the dynamic
extent of the function or node that calls `callback(...)`. When that function
or node returns, the callback is automatically unregistered. Callbacks
registered at module top-level (outside any function or node) are active for
the entire run.

## Callbacks in TypeScript

```ts
import { main } from "agency"
const callbacks = {
  onNodeStart: (data) => {
    console.log(`Node ${data.node.id} started.`)
  }
}

const result = main(param1, param2, { callbacks })
```

## Raising interrupts from a callback

A callback written in Agency can call `interrupt(...)` like any other
Agency code. Whether that interrupt actually surfaces to the caller of
the agent depends on which hook the callback is registered on — some
hooks fire from contexts where the runtime can pause and resume, and
others fire from contexts where it cannot.

The table below summarizes the current state per hook. Three columns:

- **Interrupts?** — does an `interrupt(...)` in the callback body
  surface to the user (so the program can be resumed via
  `respondToInterrupts`)?
- **Multi-callback batching?** — if you register *multiple*
  interrupt-raising callbacks on the same hook, do all of them
  surface in one batch, and does resume restore all of them cleanly?
- **Notes** — limitations and implementation details.

| Hook              | Interrupts?                  | Multi-callback batching?           | Notes                                                                                                                                                                                                                                          |
|-------------------|------------------------------|------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `onAgentStart`    | ❌ Compile + runtime error    | N/A                                | Fires outside any agency frame — there is no stack to checkpoint and nowhere to resume from. The typechecker errors at build; `callHook` also throws at runtime as a defense-in-depth.                                                         |
| `onAgentEnd`      | ❌ Compile + runtime error    | N/A                                | Same as `onAgentStart`.                                                                                                                                                                                                                        |
| `onNodeStart`     | ✅ Yes                        | ⚠️ Batched, but resume is partial   | Fires inside the node's runner as a resumable substep. Single-callback resume works cleanly (exactly-once semantics). Multi-callback: see the **single-callback constraint** below.                                                            |
| `onNodeEnd`       | ⚠️ Only on void-returning nodes | ⚠️ Same as `onNodeStart`           | Nodes that exit via `return value` halt the runner first; the post-body halted check short-circuits the End hook, so it never fires. Use a void node body if you need `onNodeEnd` to fire.                                                     |
| `onFunctionStart` | ✅ Yes                        | ⚠️ Batched, but resume is partial   | Fires inside the function's runner as a resumable substep. Same as `onNodeStart`.                                                                                                                                                              |
| `onFunctionEnd`   | ❌ Silently dropped           | ❌                                  | Fires from a `finally` block. The function has already returned by the time the hook fires, so interrupts cannot be propagated back into the runner. Today they are discarded with no log or throw. Move to a hook that fires outside `finally` if you need interrupts. |
| `onEmit`          | ✅ Yes                        | ⚠️ Batched, but resume is partial   | Fires as a substep at the call site of `emit(...)`. Verified end-to-end (code before the interrupt does NOT re-run on resume; code after the interrupt fires exactly once on resume).                                                          |
| `onLLMCallStart`  | ✅ Yes                        | ✅ Batched                          | Propagates through `runPrompt`. Pending LLM call does not run. Resume re-enters `runPrompt` and the call is attempted from scratch.                                                                                                            |
| `onLLMCallEnd`    | ✅ Yes                        | ✅ Batched                          | Propagates through `runPrompt`. The LLM response is preserved across the resume cycle by `runPrompt`'s internal state machine.                                                                                                                 |
| `onToolCallStart` | ✅ Yes                        | ✅ Batched                          | Per-tool branch (`b.step`) captures the interrupt. Resume re-fires only the interrupted tool — sibling tools' results are preserved. The tool itself does not execute on the first cycle.                                                      |
| `onToolCallEnd`   | ✅ Yes                        | ✅ Batched                          | Same as `onToolCallStart`. The tool's result is preserved across resume via `setResultOnBranch`.                                                                                                                                               |
| `onStream`        | 🚫 N/A                        | 🚫 N/A                              | Invoked directly by the streaming pipeline (`ctx.callbacks.onStream(...)`), never goes through `callHook`. Agency `callback("onStream", ...)` registrations are never fired.                                                                   |
| `onTrace`         | 🚫 N/A                        | 🚫 N/A                              | Same as `onStream` — direct invocation, not via `callHook`.                                                                                                                                                                                    |

### Single-callback constraint (current limitation)

For the hooks marked **⚠️ Batched, but resume is partial**, the runtime
correctly batches all interrupts into a single `Interrupt[]` and
surfaces them to the user. The catch is on resume: `respondToInterrupts`
uses the first interrupt's checkpoint to drive the restore — so only
that callback's frame is reused from the deserialize queue. Sibling
callbacks' bodies re-run from the top, which means their pre-interrupt
side effects fire again, and they may raise fresh interrupts that
require additional resume cycles.

**Practical guidance:** prefer at most one interrupt-raising callback
per hook. Pure observers (callbacks with no `interrupt(...)` call) can
freely coexist alongside an interrupter — they just re-run on resume.

A future change will move callbacks to a fork-style branched model
that batches resume correctly. The hooks marked **✅ Batched** (LLM and
tool hooks) already get fork-style branched resume for free, because
they fire inside `runPrompt`'s branch machinery.

### Concurrent firing across fork branches

A separate sense of "concurrent" is when the *same hook* fires from
multiple parallel branches (e.g. inside a `fork(...) as item { ... }`
block, each branch's call to `helper()` fires `onFunctionStart`
independently). The runtime handles this case correctly: each branch
has its own `Runner` with its own substep counters, each branch's
`runner.hook` halts independently if its callbacks interrupt, and
`runForkAll` batches the per-branch `Interrupt[]` into a single parent
batch — the same machinery used for any other branch-internal
`interrupt()` call.

### Resume semantics

When a callback raises an interrupt and the user resumes via
`respondToInterrupts`, the **callback's body re-enters at the
interrupt step only** — earlier statements in the callback body have
already advanced past their substep counters and do not re-run. The
hook itself re-fires (so any side effects in the firing path will
repeat), but the callback's saved frame is reused from the
deserialize queue. Net result: a callback that increments a counter
*before* the interrupt and then increments another counter *after* it
will see exactly one increment on each side across the interrupt-and-
resume cycle.

## List of hooks
Here are all the hooks that Agency provides.

### onAgentStart
Called when an agent (graph) starts executing.

- `nodeName`: the name of the entry node
- `args`: the arguments passed to the agent
- `messages`: the initial message history
- `cancel(reason?)`: call this to cancel the agent before it runs

### onAgentEnd
Called when an agent finishes executing.

- `nodeName`: the name of the entry node
- `result`: the result of running the agent

### onNodeStart
Called when a graph node begins executing.

- `nodeName`: the name of the node

### onNodeEnd
Called when a graph node finishes executing.

- `nodeName`: the name of the node
- `data`: the data returned by the node

### onLLMCallStart
Called before an LLM call is made. You can return a `MessageJSON[]` array to override the messages sent to the LLM.

- `prompt`: the prompt string
- `tools`: the tools available to the LLM, each with `name`, `description`, and `schema`
- `model`: the model being used
- `messages`: the messages that will be sent

### onLLMCallEnd
Called after an LLM call completes. You can return a `MessageJSON[]` array to override the messages stored in the thread.

- `model`: the model that was used
- `result`: the full prompt result from the LLM
- `usage`: token usage statistics (if available)
- `cost`: estimated cost (if available)
- `timeTaken`: how long the call took in milliseconds
- `messages`: the messages that were sent

### onFunctionStart
Called when a function (tool) begins executing.

- `functionName`: the name of the function
- `args`: the arguments passed to the function
- `isBuiltin`: whether this is a built-in function
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
