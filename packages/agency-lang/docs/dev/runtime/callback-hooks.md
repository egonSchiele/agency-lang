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

`callHook(...)` in `lib/runtime/hooks.ts` is the single dispatcher that
fires every callback for a given hook name. It returns `Promise<void>`.
Order:

1. Global hooks registered via `registerGlobalHook` (external packages
   like `@agency-lang/mcp`).
2. Innermost stack-frame scoped callbacks (from `callback(...) { ... }`
   blocks inside an open scope).
3. Outer stack-frame scoped callbacks (walking up).
4. Top-level callbacks (registered at module init), in registration
   order.
5. The TS-passed `ctx.callbacks[name]` callback, if any.

All callbacks fire sequentially; later ones run regardless of whether
earlier ones threw.

## Errors in callback bodies

`fireWithGuard` catches any JS error thrown by a callback and logs it
via `console.error`. The next callback in the chain still fires.

`RestoreSignal` and `AgencyCancelledError` are special — they are
internal control-flow signals and always re-throw.

## Recursion guard

`fireWithGuard` uses an `AsyncLocalStorage`-scoped Set to prevent a
callback that synchronously re-fires its own hook (via a helper
function call) from recursing into itself
(tests/agency/callback-recursion).

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
`await runner.hook(id, async () => { await callHook({ ctx, name, data }) })`
for each of: `onFunctionStart`, `onFunctionEnd`, `onNodeStart`,
`onNodeEnd`, `onEmit`. The `runner.hook` wrapper advances the substep
counter (so the hook fires exactly once across resume cycles) but
intentionally skips the debug hook — codegen-emitted hook sites have
no user-visible source line, so pausing on one would surprise the
debugger user.

## Parallel-branch callbacks (per-tool firings)

When a callback fires from inside a parallel branch — e.g. the
per-tool `onToolCallStart` / `onToolCallEnd` in `runPrompt`'s tool
loop — `prompt.ts` calls `invokeCallbacks({ ..., stateStack:
branchStack })` so that scoped callbacks registered inside the
branch's frame chain are discovered by `gatherCallbacks`. This is
purely about scope discovery, not interrupt routing.
