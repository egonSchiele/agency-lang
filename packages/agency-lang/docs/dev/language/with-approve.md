# `with approve/reject/propagate` Handler Modifier

## Overview

The `with` modifier is a shorthand for wrapping a single statement in a handler:

```
const text = read("file.txt") with approve
```

This is equivalent to:

```
handle {
  const text = read("file.txt")
} with approve
```

It supports the three builtin handler names: `approve`, `reject`, and `propagate`. Inline handlers are not supported — use a full `handle` block for those.

## Why this syntax exists: global scope

The primary motivation for `with` is that it works in global scope, where the regular `handle { } with` block syntax does not.

### The problem with `handle` blocks in global scope

Global-scope assignments compile into `__initializeGlobals`, a plain async function that runs once per execution context. Unlike node and function bodies, `__initializeGlobals` does not have a runner — there's no `Runner` instance, no step counter, no `__state`, and no `__threads`. These are all set up by `setupNode`/`setupFunction`, which only run inside graph nodes and Agency functions.

The regular `handle { } with` block compiles to `runner.handle(id, handlerFn, callback)`, which requires a runner. Since there's no runner in global scope, `handle` blocks can't work there.

### How `with` solves this

The `with` modifier has two separate code generation paths:

**In runner scopes (nodes and functions):** It compiles to `runner.handle()` — identical to `handle { } with approve`. No difference in behavior.

**In global scope:** It compiles to raw `__ctx.pushHandler()` / `__ctx.popHandler()` calls with a try/finally:

```ts
async function __initializeGlobals(__ctx) {
  __ctx.markInitialized("module.agency");
  __ctx.pushHandler(async (__data) => approve(__data));
  try {
    __ctx.globals.set("module.agency", "text", await read("file.txt", { ctx: __ctx }));
  } finally {
    __ctx.popHandler();
  }
}
```

This works because the handler stack lives on `__ctx`, not on the runner. When the called function internally triggers an interrupt via `interruptWithHandlers()`, the runtime checks `__ctx.handlers`, finds the `approve` handler, evaluates it, and short-circuits — the interrupt is resolved immediately without needing state serialization, step counters, or any of the runner machinery.

### Other differences in global scope

Two additional adjustments make function calls work inside `__initializeGlobals`:

1. **Minimal function call config.** In node/function scope, Agency function calls pass `{ ctx, threads, interruptData }`. In global scope, `__threads` and `__state` don't exist, so function calls pass only `{ ctx }`. The called function handles the missing fields gracefully (same path as when a function is called as a tool by the LLM).

2. **Early `markInitialized`.** The `markInitialized` call is emitted *before* the init statements. Without this, a global init expression that calls a function defined in the same module would trigger `__initializeGlobals` again (via the `isInitialized` check in every function preamble), causing infinite recursion.

## Limitations

- Only builtin handlers (`approve`, `reject`, `propagate`) are supported. For custom handler logic, use a full `handle` block inside a node or function.
- In global scope, `with propagate` will propagate the interrupt to the TypeScript caller. Whether this is useful depends on whether the caller handles interrupts.
- Since global scope has no runner, `with` in global scope does not support debugger stepping through the handler. Adding a runner to `__initializeGlobals` would enable this in the future.
