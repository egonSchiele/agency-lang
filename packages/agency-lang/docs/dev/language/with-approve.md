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

It supports the three builtin handler names: `approve`, `reject`, and `propagate`. The parser accepts nothing else after `with` (`withModifierParser`, `lib/parsers/parsers.ts`). Inline handlers are not supported, so use a full `handle` block for those.

## Why this syntax exists: global scope

The primary motivation for `with` is that it works in global scope, where the regular `handle { } with` block syntax does not.

### The problem with `handle` blocks in global scope

Global-scope assignments compile into `__initializeGlobals`, a plain async function that runs once per execution context. Unlike node and function bodies, `__initializeGlobals` has no runner. There is no `Runner` instance and no step counter. `setupNode` and `setupFunction` create those, and they only run inside graph nodes and Agency functions. `__initializeGlobals` instead runs under a *bootstrap* frame (`runInBootstrapFrame`, `lib/runtime/asyncContext.ts`), which supplies a context and a state stack but no runner, and whose thread store throws on every thread builtin.

The regular `handle { } with` block compiles to `runner.handle(id, handlerFn, callback)`, which requires a runner. Since there's no runner in global scope, `handle` blocks can't work there.

### How `with` solves this

The `with` modifier has two separate code generation paths:

**In runner scopes (nodes and functions):** It compiles to `runner.handle()`, identical to `handle { } with approve`. No difference in behavior.

**In global scope:** `partitionProgram` (`lib/backends/typescriptBuilder/sectionAssembler.ts`) wraps the statement in a `ts.withHandler` IR node instead. That prints a push/pop pair around a try/finally (`lib/templates/backends/typescriptGenerator/withHandlerWrapper.mustache`):

```ts
async function __initializeGlobals(__ctx) {
  if (__ctx.globals.isInitialized("module.agency")) return;
  __ctx.globals.markInitialized("module.agency");
  getRuntimeContext().ctx.pushHandler(async (__data) => approve(__data), []);
  try {
    __ctx.globals.set("module.agency", "text", await __call(read, /* … */));
  } finally {
    getRuntimeContext().ctx.popHandler();
  }
}
```

The second `pushHandler` argument is the handler's live guard ids, and it is deliberately empty. The only guards that can exist during top-level init are the root budget guards, which install before any user code (`initFreshExecCtx`, `lib/runtime/node.ts`) — and those never raise an interrupt, so a wrapper handler hiding them changes nothing.

`withHandler` deliberately needs no step id, which is why it works where `runner.handle()` cannot. The handler stack lives on the context, not on the runner. When the called function raises an interrupt through `interruptWithHandlers()`, the runtime walks `ctx.handlers`, finds the `approve` handler, and resolves the interrupt immediately. No state serialization, step counters, or runner machinery are involved.

`getRuntimeContext()` is the strict accessor, so it throws if no ALS frame is installed. That is on purpose. Handlers are safety infrastructure, and a missing frame is a real bug that should fail loudly rather than skip a registration.

### Other differences in global scope

**Early `markInitialized`.** The `markInitialized` call is emitted *before* the init statements. Without it, a global init expression that calls a function defined in the same module would trigger `__initializeGlobals` again through the `isInitialized` check in every function preamble, and recurse forever.

Call sites themselves need no special handling any more. Every call goes through the `__call` dispatcher (`lib/runtime/call.ts`), which reads the context, stack, and threads from the active ALS frame rather than from a config object passed by codegen. The bootstrap frame supplies all three.

## Limitations

- Only builtin handlers (`approve`, `reject`, `propagate`) are supported. For custom handler logic, use a full `handle` block inside a node or function.
- A bare top-level `foo() with approve` needs its own branch in `partitionProgram`. Without it the node falls through to `processWithModifier`, which asks the step-path tracker for a current id against an empty stack and throws an internal invariant error (issue #229).
- In global scope, `with propagate` will propagate the interrupt to the TypeScript caller. Whether this is useful depends on whether the caller handles interrupts.
- Since global scope has no runner, `with` in global scope does not support debugger stepping through the handler. Adding a runner to `__initializeGlobals` would enable this in the future.
- Global init is a fresh-run side effect. It is not re-executed on interrupt resume.
