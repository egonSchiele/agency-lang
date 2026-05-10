# `_run` Receives RuntimeContext via AgencyFunction Wrapping

## Problem

The subprocess IPC feature requires `_run()` to call `interruptWithHandlers()` on incoming subprocess interrupts. `interruptWithHandlers()` requires a `RuntimeContext` (`ctx`) to access the parent's handler chain. But `_run()` is a raw TypeScript function imported by `stdlib/agency.agency`, and raw functions do not receive runtime state — `__call()` in `call.ts` drops the `state` parameter for non-AgencyFunction targets.

## Solution

Apply the same AgencyFunction wrapping pattern used by `checkpoint`, `getCheckpoint`, and `restore`. This is a three-part change:

1. **`_run` lives in `lib/runtime/ipc.ts`** with `__state: InternalFunctionState` as its last parameter.
2. **Export `_run` from `agency-lang/runtime`** so the imports template can access it.
3. **Wrap `_run` as an `AgencyFunction` in `imports.mustache`** — same pattern as lines 66-68 for the checkpoint functions.

## How It Works

### The existing pattern (checkpoint example)

```
// imports.mustache
import { checkpoint as __checkpoint_impl } from "agency-lang/runtime";
const checkpoint = __AgencyFunction.create({
  name: "checkpoint", module: "__runtime",
  fn: __checkpoint_impl, params: [], toolDefinition: null
}, __toolRegistry);
```

When generated code calls `__call(checkpoint, descriptor, state)`:
1. `__call` sees an `AgencyFunction`
2. Routes through `AgencyFunction.invoke(descriptor, state)`
3. `invoke()` appends `state` as the last argument to the underlying `__checkpoint_impl`
4. `__checkpoint_impl` receives `__state: InternalFunctionState`, extracts `ctx`

### Applied to `_run`

```
// imports.mustache (new addition)
import { _run as __run_impl } from "agency-lang/runtime";
const _run = __AgencyFunction.create({
  name: "_run", module: "__runtime",
  fn: __run_impl,
  params: [
    { name: "compiled", hasDefault: false, defaultValue: undefined, variadic: false },
    { name: "options", hasDefault: false, defaultValue: undefined, variadic: false }
  ],
  toolDefinition: null
}, __toolRegistry);
```

`stdlib/agency.agency` calls `_run(compiled, options)`. The generated code produces `__call(_run, { type: "positional", args: [compiled, options] }, state)`. Since `_run` is now an `AgencyFunction`, `invoke()` appends `state`, and `__run_impl` receives `__state` as its third argument.

### `_run` signature

```typescript
// lib/runtime/ipc.ts
export async function _run(
  compiled: { path: string; moduleId: string },
  options: { node: string; args: Record<string, any> },
  __state: InternalFunctionState,
): Promise<RunNodeResult<any>> {
  const ctx = __state.ctx;
  const stateStack = __state.stateStack ?? ctx.stateStack;
  // fork subprocess, manage IPC loop
  // For each subprocess interrupt message:
  //   interruptWithHandlers(kind, msg, data, origin, ctx, stateStack)
  // The sixth arg (stateStack) is needed for branch-aware cancellation checks.
}
```

The current `_run` in `stdlib/lib/agency.ts` has an ad-hoc `state?: { ctx: any; threads: any; stateStack: any }` parameter with a runtime guard (`if (!state?.ctx) throw`). With the AgencyFunction wrapping, `__state` is always provided by `invoke()`, so the guard is unnecessary and the parameter becomes the standard `InternalFunctionState` type.

### `stdlib/agency.agency` import change

Currently:
```
import { _compile, _run } from "./lib/agency.js"
```

After this change, `_run` is removed from the import (it's now a module-level constant from the imports template, like `checkpoint`):
```
import { _compile } from "./lib/agency.js"
```

The call site `return try _run(compiled, options)` continues to work — `_run` is in scope as a module-level `AgencyFunction` constant, same as how `checkpoint()` is callable without being imported.

## Files Changed

| File | Change |
|------|--------|
| `lib/runtime/ipc.ts` | Move `_run` here from `stdlib/lib/agency.ts`. Change last param from ad-hoc `state?` to `__state: InternalFunctionState`. Remove the `if (!state?.ctx) throw` guard. |
| `lib/runtime/index.ts` | Export `_run` from `agency-lang/runtime` |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | Add `_run` import alias and `AgencyFunction.create` wrapping |
| `lib/templates/backends/typescriptGenerator/imports.ts` | Recompile from mustache |
| `stdlib/lib/agency.ts` | Remove `_run` (moved to `lib/runtime/ipc.ts`) |
| `stdlib/agency.agency` | Remove `_run` from the `./lib/agency.js` import. `_run` is now available via the imports template. |

## Trade-offs

**Every compiled module gets this import/wrapping**, even modules that never use `std::agency`. This is the same trade-off that exists for `checkpoint`, `getCheckpoint`, and `restore` — they're imported in every module even though not every module uses them. The unused wrapping is dead code that doesn't execute.

**This doesn't scale** to many stdlib functions needing `ctx`. If more appear, a compiler-level solution (e.g., `import ctx { _run } from "..."` syntax) would be warranted. For a single function, the hardcoded approach is pragmatic.

## Alternatives Considered

1. **Pass state to all raw functions in `__call`** — Change `call.ts:24` to `target(...descriptor.args, state)`. Rejected: leaks internal runtime state to every raw function.
2. **AsyncLocalStorage** — Store `ctx` in Node's `AsyncLocalStorage`. Rejected: ties runtime to Node (blocks browser support), introduces implicit state, new pattern for the codebase.
3. **Compiler annotation** (`import ctx { ... }`) — Teach the compiler to wrap specific backing imports. Most principled long-term solution but unnecessary complexity for one function.
