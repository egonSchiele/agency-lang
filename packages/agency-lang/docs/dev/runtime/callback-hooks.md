# Callback hooks

Agency lets user code register callbacks for runtime events
(`onFunctionStart`, `onNodeStart`, `onLLMCallStart`, `onToolCallStart`,
etc.) via the stdlib `callback()` function. Callbacks are side-effect
hooks: they run when the event fires and that is it.

## `interrupt` is not allowed in a callback body

The typechecker rejects any `interrupt` statement inside a `callback(...)
{ ... }` body, direct or transitive. See `checkCallbackBodyInterrupts`
in `lib/typeChecker/interruptAnalysis.ts`.

This is the static gate that lets the runtime stay simple. There is no
"callback halts the runner" path, no "callback-stamped checkpoint", no
multi-callback resume orchestration. If you need to pause execution for
user input, put the `interrupt(...)` in the calling node or function.

## `callHook` dispatch

`invokeCallbacks(...)` in `lib/runtime/hooks.ts` is the single dispatcher
that fires every callback for a given hook name. `callHook(...)` is a thin
wrapper over it that omits the `stateStack` override. Both return
`Promise<void>`. Order:

1. Global hooks registered via `registerGlobalHook` (external packages
   like `@agency-lang/mcp`).
2. Innermost stack-frame scoped callbacks (from `callback(...) { ... }`
   blocks inside an open scope).
3. Outer stack-frame scoped callbacks (walking up).
4. Top-level callbacks (registered at module init), in registration
   order.
5. The TS-passed `ctx.callbacks[name]` callback, if any.

Steps 2 through 5 are what `gatherCallbacks` returns, in that order.

All callbacks fire sequentially. A later one still runs when an earlier one
threw a plain JS error, because `fireWithGuard` logs and drops those. A
control-flow signal is different: it propagates and ends the chain. See below.

`ctx` is optional on both functions. When omitted it resolves from the active
ALS frame via `getRuntimeContext()`, which is what every codegen-emitted
`callHook(...)` site does.

`hasCallbackConsumer(ctx, name, stateStack?)` answers "is anyone listening?"
across all five sources. Use it instead of reaching into `ctx.callbacks`
directly, which only sees the TS-passed slot.

Before firing anything, `invokeCallbacks` calls `sendCallbackToParent(name, data)`
(`lib/runtime/callbackForwarding.ts`). Inside a `std::agency` `run()` subprocess
that forwards the event to the parent process, so the parent's callbacks fire for
child events. It is
fire-and-forget, strips functions, and is a no-op outside IPC. The child still
fires its own callbacks. Because a relayed event re-forwards upward, nesting
works automatically.

## Errors in callback bodies

`fireWithGuard` catches any JS error thrown by a callback and logs it
via `console.error`. The next callback in the chain still fires.

Two exceptions always re-throw instead: `RestoreSignal` and `AgencyAbort`.
`AgencyAbort` covers both a cancellation and a guard trip. A guard trip raised
inside a callback must reach its owning guard, so logging and dropping it would
be wrong.

## Recursion guard

`fireWithGuard` uses an `AsyncLocalStorage`-scoped Set to prevent a
callback that synchronously re-fires its own hook, through a helper
function call, from recursing into itself. Fixture:
`tests/agency/callback-recursion.agency`.

Each `fireWithGuard` call enters its own `_activeCallbacksALS.run(...)`
scope with a freshly-allocated `new Set<object>(inherited)` containing
the parent scope's entries plus the current callback's key. Within
that scope the Set is inherited through `await` boundaries and nested
sync calls, so a synchronous re-fire of the same callback sees its
own key and is skipped. Concurrent sibling branches each enter their
OWN `.run(...)` scope, so parallel fork/tool branches can each fire
the same callback without dropping sibling invocations. ALS state is
live-only — never serialised, automatically released when the scope
exits.

## Codegen-emitted call sites

The compiler emits
`await runner.hook(id, async () => { await callHook({ name, data }) })`
for `onFunctionStart`, `onNodeStart`, `onNodeEnd`, and `onEmit`
(`ts.runnerHookStep`, `lib/backends/typescriptBuilder.ts`). The
`runner.hook` wrapper advances the substep counter, so the hook fires
exactly once across resume cycles. It intentionally skips the debug
hook that `runner.step` calls, because a codegen-emitted hook site has
no user-visible source line and pausing on one would surprise the
debugger user.

`onFunctionEnd` is the exception. It is not a `runner.hook` step. It fires
from the function's `finally` block, guarded by `__functionCompleted`, so it
does not fire when the function halted on an interrupt.

## Parallel-branch callbacks (per-tool firings)

When a callback fires from inside a parallel branch — e.g. the
per-tool `onToolCallStart` / `onToolCallEnd` in `runPrompt`'s tool
loop — `prompt.ts` calls `invokeCallbacks({ ..., stateStack:
branchStack })` so that scoped callbacks registered inside the
branch's frame chain are discovered by `gatherCallbacks`. This is
purely about scope discovery, not interrupt routing.

## `onCheckpoint`: one statement checkpoint per event

A host that runs long jobs needs a checkpoint between yields, so a run
that dies mid-way can be resumed from its last statement. Without one,
the host can only go back to the run's last pause or interrupt.
`onCheckpoint` gives it that through the ordinary callbacks channel. The payload is `{ runId, checkpoint }`,
where `checkpoint` is the object `Checkpoint.toJSON()` returned. The
host stores it and later calls
`resumeFromCheckpoint({ type: "paused", checkpoint, runId }, { metadata: { callbacks } })`.

Where it fires. `debugStep` (`lib/runtime/debugger.ts`) builds a
`Checkpoint` for every statement the runner reaches, hands it to the
trace writer, and then fires this hook if `hasCallbackConsumer` says
anyone is listening. The runner's gate for "take a checkpoint at this
step" (`recordsStepCheckpoints` in `lib/runtime/runner.ts`) has three
reasons: a debugger, a trace writer, or an `onCheckpoint` consumer. A
run with none of the three builds no statement checkpoints, as before.
Steps inside a tool call are skipped, as they are for the trace writer,
because a branch stack cannot be re-entered from outside.

What it does not cover. The checkpoint a pause returns and the
checkpoint an interrupt carries are not reported here; both already
reach the host inside the run's result.

Not forwarded from a subprocess. A `std::agency` `run()` child inherits
its parent's run id. A forwarded child checkpoint would carry the job's
run id and the child program's stack, and a host that stored it as the
job's latest state would resume the parent into the wrong program. So
`onCheckpoint` is on `NON_FORWARDABLE_CALLBACKS`.

The payload is not a copy. Cloning a whole stack on every statement
would be paid by every consumer, so the hook hands out the object
`toJSON()` built. A host that keeps it past the callback should
serialize or clone it at once.

Errors. Like every hook, a callback that throws is logged and dropped by
`fireWithGuard`. The runtime does not know that a host failed to store a
checkpoint; the host must record that itself.

Agency-side registration. `callback("onCheckpoint")` is accepted because
the name is in `VALID_CALLBACK_NAMES` like any other. The body runs at
every statement, and its own statements do not re-fire the hook because
of the recursion guard above. Nothing in the runtime uses this; it
exists because refusing it would need a special case.

The dormant `onTrace` hook. `onTrace` has been in the registry with a
`TraceEvent` payload for a long time and is never dispatched. Its
payload would be one line of the trace file format (a content-addressed
chunk or a manifest referencing chunks), which a host would have to
reassemble to get a checkpoint back. `onCheckpoint` was added instead of
wiring `onTrace` because the consumer wants a value it can hand straight
to `resumeFromCheckpoint`. The two are separate mechanisms. If `onTrace`
is ever wired, it should stay a trace-line stream.
