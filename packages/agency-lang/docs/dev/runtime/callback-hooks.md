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
