# Codegen ALS accessors: `__threads()`, `__stateStack()`, `__globals()`

This doc covers how generated Agency code reads runtime values (the `ThreadStore`, `RuntimeContext`, `StateStack`) from the active `agencyStore` ALS frame, the file layout for the codegen → runtime → template path, and the recipe for adding a new accessor or pruning an existing setup-block local.

Sister doc: [docs/dev/runtime/async-context.md](../runtime/async-context.md) describes `agencyStore` itself and where frames are installed. Read that first.

## TL;DR

Generated Agency code used to declare per-scope `const __threads = ...; const __ctx = ...; const __stateStack = ...;` locals in every function and node body's setup block. That worked but it forced the codegen and every downstream emission site (templates, IR builders, `typescriptBuilder.ts`) to thread the values through by name. The migration replaces each `__X` local with a runtime accessor function `__X()` that reads from `agencyStore.getStore()?.X`. The codegen now just emits the accessor call where the local used to be referenced.

```ts
// before
const __threads = __setupData.threads;
runner.halt({ messages: __threads, data: result });

// after
runner.halt({ messages: __threads(), data: result });
```

The cost is one ALS read per access (negligible — `AsyncLocalStorage.getStore()` is a fast atomic read on Node's async hook stack). The benefit is that setup blocks stop carrying a five-line preamble of `const` declarations and the codegen doesn't have to plumb names through every emission path.

## Current status

| Local | Status | How generated code reads it |
| --- | --- | --- |
| `__threads` | pruned | `__threads()` ([#201](https://github.com/egonSchiele/agency-lang/pull/201)) |
| `__stateStack` | pruned | `__stateStack()` |
| `__graph` | pruned (was dead code) | — |
| `statelogClient` | pruned (was dead code) | — |
| `__ctx` | still a `const`, but seeded FROM ALS | `getRuntimeContext().ctx`, see below |

`__globals()` is a fourth accessor. It never replaced a setup-block local; it exists so a fork branch's generated code reads the branch-local `GlobalStore` view rather than the canonical one.

Alongside the accessor migrations, function and node body try blocks wrap in `await agencyStore.run({...getRuntimeContext(), ctx, stack, threads}, async () => { ... })`. This is defense in depth: it closes the gap between Runner-managed steps where a future refactor could lose the outer ALS frame.

Migration roadmap: [docs/superpowers/plans/2026-05-26-als-migration-phase-4-cleanup.md](../../superpowers/plans/2026-05-26-als-migration-phase-4-cleanup.md).

### Why `__ctx` stayed a local

`__ctx` did NOT become a bare `__ctx()` accessor call in generated code, and it never will. The blocker is a name collision.

`setupEnv` emits `const __ctx = getRuntimeContext().ctx;` in every function and node body. That local shares its name with the `__ctx` runtime export. The esbuild TypeScript transform resolves the clash by renaming the local to `__ctx2` and rewriting *every* `__ctx` reference in that scope, including ones bound to the import. A sibling template emitting `__ctx()` would therefore print `__ctx2()`, and `__ctx2` is a `RuntimeContext` value, not a function. The result is `__ctx2 is not a function` at runtime.

So `ts.runtime.ctx` prints `getRuntimeContext().ctx` ([lib/ir/builders.ts](../../../lib/ir/builders.ts)), which no local can shadow. The local stays because pre-wrap code needs a lexical handle to seed ALS: the `Runner` constructor, the `agencyStore.run` seed object, and the `__initializeGlobals` call all run before the frame exists. Those three sites emit `ts.id("__ctx")` directly.

The `__ctx()` accessor still exists in `lib/runtime/asyncContext.ts` and is exported from `lib/runtime/index.ts`, but `imports.mustache` does not import it, so no generated code calls it.

Two complications that used to make this migration look larger are simply gone. The module-top-level `const __ctx = __globalCtx;` rebind for docstring interpolation was removed; the codegen now flips `topLevel: true` on the description subtree's `TsScopedVar` nodes and the pretty-printer emits `__globalCtx.globals.get(...)` directly. And `classMethod.mustache`, which had its own `const __ctx = __state?.ctx || __globalCtx;` setup, no longer exists.

## Why two flavors: `__X()` vs `getRuntimeContext().X`

Both shapes read from the same ALS frame, but they behave differently when **no frame is installed**:

- **`__X()`** (lenient) — `agencyStore.getStore()?.X`. Returns `undefined` when no frame is installed. Safe at sites where the consumer tolerates `undefined`, or where the value is assigned into an object property and a missing value surfaces later as a clearer error.
- **`getRuntimeContext().X`** (strict) — throws `"getRuntimeContext() called outside an Agency execution frame..."`. Use at sites where `undefined` would dereference unactionably. Without the throw, `__threads().active().push(...)` gives you a cryptic `Cannot read properties of undefined (reading 'active')`.

Rule of thumb: **call the accessor when the value is being passed somewhere; call `getRuntimeContext().X` when the value is being immediately dereferenced.** The Copilot review on PR #201 caught one missed case in `builtinFunctions/system.mustache`, where `__threads().active().push(...)` would crash with a generic TypeError. That line now uses `getRuntimeContext().threads.active().push(...)`.

## File layout

The accessor pattern touches one runtime file, one re-export, one import template, the IR builder, and N templates per migration:

```diagram
╭──────────────────────────────────────╮
│ lib/runtime/asyncContext.ts          │  ← define __X(): T | undefined
│                                      │     export function __threads() { ... }
╰──────────────┬───────────────────────╯
               │
               ▼
╭──────────────────────────────────────╮
│ lib/runtime/index.ts                 │  ← re-export __X
╰──────────────┬───────────────────────╯
               │
               ▼
╭──────────────────────────────────────╮
│ lib/templates/.../imports.mustache   │  ← add __X to the runtime import list
╰──────────────┬───────────────────────╯
               │
               ▼
╭──────────────────────────────────────╮     ╭──────────────────────────────╮
│ lib/ir/builders.ts                   │     │ lib/backends/                │
│  • ts.runtime.X → TsRaw `__X()`      │◀───▶│  typescriptBuilder.ts        │
│  • setupEnv drops the X param        │     │  • drop X from setupEnv()    │
│                                      │     │    callers                   │
╰──────────────┬───────────────────────╯     │  • flip remaining `__X`      │
               │                             │    emissions to `__X()`      │
               ▼                             ╰──────────────────────────────╯
╭──────────────────────────────────────╮
│ lib/templates/.../*.mustache         │  ← flip `__X` → `__X()` in every
│  blockSetup, forkBlockSetup,         │    template that referenced the
│  interruptAssignment, interruptReturn│    local
│  resultCheckpointSetup, system, ...  │
╰──────────────────────────────────────╯
```

Generated code, after a successful migration:

```ts
import {
  ...
  __threads, __stateStack, __globals, getRuntimeContext, agencyStore,
  ...
} from "agency-lang/runtime";

graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({ state: __state });
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  // No __threads, __stateStack, statelogClient or __graph local here.
  let __forked;
  let __functionCompleted = false;

  claimFrameForScope(__stack, "main");
  const runner = new Runner(__ctx, __stack, {
    nodeContext: true,
    state: __stack,
    moduleId: "...",
    scopeName: "main",
    threads: __setupData.threads,
  });

  try {
    await agencyStore.run(
      { ...getRuntimeContext(), ctx: __ctx, stack: __ctx.stateStack, threads: __setupData.threads },
      async () => {
        // body — every reference to a pruned local is now a call:
        //   __threads().getOrCreateActive()
        //   __stateStack().pop()
        //   getRuntimeContext().ctx.pendingPromises.add(...)   (strict sites)
      },
    );
  } finally {
    ...
  }
});
```

`tests/typescriptBuilder/simple.mjs` is the checked-in fixture of this shape.

## Recipe: adding a new accessor

If you find yourself wanting to prune another setup-block local (or simply add a new read-from-ALS helper for stdlib JS code), follow this recipe. Estimated time: ~30 min for the code change, plus fixture regen.

### 1. Define the accessor

[`lib/runtime/asyncContext.ts`](../../../lib/runtime/asyncContext.ts):

```ts
/**
 * Generated-code accessor for <thing>. Returns the active
 * agencyStore frame's <field>, or undefined when no frame is installed.
 *
 * For sites where undefined would dereference unactionably, prefer
 * `getRuntimeContext().<field>` so the missing-frame case throws the
 * dedicated error with a pointer to runInTestContext.
 */
export function __myThing(): MyThing | undefined {
  return agencyStore.getStore()?.myThing;
}
```

If the value isn't already on `AgencyStore`, extend that type:

```ts
export type AgencyStore = {
  ctx: RuntimeContext<any>;
  stack: StateStack;
  threads: ThreadStore;
  globals: GlobalStore;
  callsite?: CallsiteLocation;
  runner?: Runner;
  myThing: MyThing;          // new
};
```

…and seed it at every `agencyStore.run(...)` call site. The table at the end of this doc lists them all. Sites that spread an existing frame (`{ ...parent, stack }`) inherit the new field for free; sites that build a fresh object do not.

### 2. Re-export from `lib/runtime/index.ts`

```ts
export {
  agencyStore,
  getRuntimeContext,
  runInTestContext,
  __threads,
  __stateStack,
  __ctx,
  __globals,
  __myThing,          // new
  type AgencyStore,
} from "./asyncContext.js";
```

### 3. Add to `imports.mustache`

Generated code can't reference `__myThing` until the runtime import list includes it. Add to [`lib/templates/backends/typescriptGenerator/imports.mustache`](../../../lib/templates/backends/typescriptGenerator/imports.mustache):

```
  __call, __callMethod, __threads, __stateStack, __globals, __myThing, getRuntimeContext, agencyStore,
```

### 4. Wire the IR builder

If `__myThing` will appear as a value in `ts.obj({...})`/`ts.call(...)` from `typescriptBuilder.ts`, give it an alias in [`lib/ir/builders.ts`](../../../lib/ir/builders.ts) `runtime: { ... }`:

```ts
runtime: {
  ...
  myThing: { kind: "raw", code: "__myThing()" } as TsRaw,
  ...
},
```

This mirrors what `runtime.threads` became in PR #201: a `TsRaw` call expression rather than a bare `TsIdentifier`. Every `ts.runtime.myThing` reference now prints as `__myThing()`.

If the old name was being declared in `setupEnv({...})`, drop the param + the `ts.constDeclId(...)` line.

### 5. Flip template emission sites

For each `.mustache` file that mentions `__myThing`:

- **Bare reads** (`__myThing`) → `__myThing()`
- **Strict deref sites** (`__myThing.someMethod().chain(...)`) → `getRuntimeContext().myThing.someMethod().chain(...)`
- **Optional deref** (`__myThing.pop()` in a `finally` block that may run outside any frame) → `__myThing()?.pop()`

Regenerate with `pnpm run templates` (typestache compiles `.mustache` → `.ts`).

### 6. Update `typescriptBuilder.ts`

Grep for the old name:

```bash
grep -n "__myThing" lib/backends/typescriptBuilder.ts
```

For each hit:
- If it's inside `setupEnv({...})`, remove the key.
- If it's a `ts.id("__myThing")`, replace with `ts.runtime.myThing`.
- If it's a `ts.raw("...__myThing...")`, edit the raw string.

### 7. Validate

```bash
pnpm run typecheck         # three tsc configs; a bare `tsc --noEmit` skips test and eval files
pnpm run lint:structure    # clean
pnpm run fmt:ts            # CI fails if you skip this
make                       # rebuild dist + recompile stdlib
make fixtures              # regenerate every fixture
pnpm test:run
```

Expect fixture comparison failures between the codegen change and `make fixtures`; that is the point of the ordering.

Spot-check a fixture: `grep -n "__myThing" tests/typescriptBuilder/simple.mjs`. The old name should be gone and the call form present.

### 8. Commit + PR

Two commits per the convention:
- `codegen: ...` for code and templates
- `fixtures: regen after ...` for the fixture diff

Open with `gh pr create --body-file <file>`. Watch for the Copilot review; the strict-versus-lenient decision is the most common comment.

## Gotchas

### "I added the accessor but generated code still uses the old name"

Three causes, in order of likelihood:

1. Forgot `pnpm run templates` after editing a `.mustache`.
2. Forgot `make fixtures` after editing codegen.
3. Edited the generated `.ts` template file instead of the `.mustache` source. The `.ts` files in `lib/templates/backends/typescriptGenerator/` are AUTO-GENERATED with a header that says so; they get clobbered on the next `pnpm run templates`.

### "tsc passes but vitest fails in fixture comparison tests"

Expected after any codegen change. Run `make fixtures` and re-run vitest. If fixture diffs look bigger than the change should produce, you probably edited a template the wrong way or hit an unintended emission path; diff one fixture to confirm.

### "Test passes locally but `make` fails"

`make` runs `tsc` over the dist build. If you regenerated templates and a generated `.ts` import is malformed, vitest won't notice, because it uses looser transforms. `tsc` will. Always run `pnpm run typecheck` before pushing. It runs three configs; a bare `tsc --noEmit` skips the test and eval files and CI catches what you missed.

### "The accessor returns `undefined` but I expected a value"

You're outside an `agencyStore.run(...)` frame. Three cases:

- **Test harness** without `runInTestContext`. Wrap the call: `await runInTestContext(ctx, stack, threads, () => _myHelper(args))`.
- **Bootstrap scope**: module top-level `const x = ...`, `callback(...)` registration, or the `onAgentStart` hook. The `threads` slot is a `BootstrapThreadStore` sentinel that throws on use. Other fields are real, but reads must not assume node-body semantics. See [docs/dev/runtime/async-context.md](../runtime/async-context.md), "Frame kinds".
- **A nested `await` after the frame was torn down.** Rare — frames propagate through normal `await` chains. If you see this, the frame was probably popped between scheduling and execution.

### "Adding a local that shadows an accessor import"

If you find yourself tempted to write `const __stateStack = somethingElse;` (or any other rebind that shares a name with the runtime import) inside a `.mustache` template, **don't**. The runtime import is a function; the local would shadow it; TypeScript renames the local to `__stateStack2` (or similar); any other template that emits `__stateStack()` then resolves to `__stateStack2` — a `StateStack` value, not a function — and crashes with `__stateStack2 is not a function`.

This bit us specifically in `forkBlockSetup.mustache`: an earlier `const __stateStack = __forkBranchStack;` rebind was kept "to make the branch stack visible inside the body". It turned out to be unnecessary: `runBatch.runInBranchAlsFrame` (lib/runtime/runBatch.ts) already seeds the branch ALS frame with `stack: branchStack`, so `__stateStack()` inside the branch body resolves to the branch stack automatically. The rebind was removed; the gotcha here is "don't reintroduce it".

If you genuinely need a *different* StateStack visible inside a sub-scope, install a new ALS frame for that scope (`agencyStore.run({...}, ...)`) rather than rebinding the name.

### Runner constructor needs explicit `threads`

`Runner.runInScope` re-enters ALS with `this.threads`. If the constructor didn't get `threads`, ALS frames inside steps would use the OUTER frame's `ThreadStore`, which for a tool-called function is the per-run store (wrong — should be a fresh store). Codegen MUST pass `threads: __setupData.threads` (or the equivalent) to every Runner. See PR [#200](https://github.com/egonSchiele/agency-lang/pull/200) for the bug this fixed.

### `Runner.thread(id, method, opts, callback)` reads `this.threads`

Pre-migration, the signature was `Runner.thread(id, threads, method, callback)` and the codegen emitted `runner.thread(0, __threads, "create", ...)`. After PR [#201](https://github.com/egonSchiele/agency-lang/pull/201), the Runner sources `threads` from its own `this.threads` field and the codegen emits `runner.thread(0, "create", ...)`. If you build a `Runner` manually in a test you MUST pass `threads:` to the constructor, or wrap the call in `agencyStore.run(...)`. Otherwise `runner.thread(...)` throws a clear error.

## Reference: every "ALS frame" site in the runtime

For grep-friendliness when adding a new field to `AgencyStore`:

| Site | File | Frame kind | Notes |
| --- | --- | --- | --- |
| `runNode` top-level wrap | [lib/runtime/node.ts](../../../lib/runtime/node.ts) | node | Wraps every fresh agent run; outer frame for all node bodies. |
| `runExportedFunction` wrap | [lib/runtime/node.ts](../../../lib/runtime/node.ts) | node | Same shape, for an exported function invoked directly. |
| `runNode` `onAgentEnd` | [lib/runtime/node.ts](../../../lib/runtime/node.ts) | node | Fires after the run completes; uses the real ThreadStore. |
| `runNode` `onAgentStart` | [lib/runtime/node.ts](../../../lib/runtime/node.ts) | bootstrap | Fires before any node runs. |
| `initializeGlobals` + `registerTopLevelCallbacks` | [lib/runtime/node.ts](../../../lib/runtime/node.ts) | bootstrap | Module-level setup. |
| `Runner.runInScope` | [lib/runtime/runner.ts](../../../lib/runtime/runner.ts) | node | Per-step ALS re-wrap. The only site that seeds `callsite` and `runner`. |
| `runBatch.runInBranchAlsFrame` | [lib/runtime/runBatch.ts](../../../lib/runtime/runBatch.ts) | node (branch) | Per-fork-branch ALS with branch stack, threads, and globals. |
| `withResumableScope` | [lib/runtime/resumableScope.ts](../../../lib/runtime/resumableScope.ts) | node | Scope body frame; inherits `globals` from the outer frame. |
| Tool invocation in `runPrompt` | [lib/runtime/prompt.ts](../../../lib/runtime/prompt.ts) | node | Re-enters the parent frame with a FRESH `ThreadStore`. |
| Scoped callback dispatch | [lib/runtime/hooks.ts](../../../lib/runtime/hooks.ts) | node | Re-enters the parent frame with the callback's own stack. |
| `respondToInterrupts` resume wrap | [lib/runtime/interrupts.ts](../../../lib/runtime/interrupts.ts) | bootstrap | Resume from interrupt. |
| `rewindFrom` replay wrap | [lib/runtime/rewind.ts](../../../lib/runtime/rewind.ts) | bootstrap | Replay from checkpoint. |
| IPC message dispatch | [lib/runtime/ipc.ts](../../../lib/runtime/ipc.ts) | inherited | Re-enters a stored parent frame (`s.parentStore`). |
| `withCallsite` | [lib/runtime/asyncContext.ts](../../../lib/runtime/asyncContext.ts) | inherited | Copies the current frame, overrides `callsite` only. Throws with no base frame. |
| `runInTestContext` | [lib/runtime/asyncContext.ts](../../../lib/runtime/asyncContext.ts) | test | Convenience wrapper for unit tests. |

When you add a new field to `AgencyStore`, every entry in this table needs to seed that field. Forgetting one site is the most common source of "the accessor returns undefined" bugs.

## Reference: every emission site that touches a setup-block local

Use this as a checklist when pruning another setup-block local:

- IR builder: `lib/ir/builders.ts` — the `ts.runtime.X` definition, the `setupEnv({...})` signature and body, and any helper that constructs an identifier from the name.
- Backend: `lib/backends/typescriptBuilder.ts` — search for the bare name. Two sites call `setupEnv`, one for function bodies and one for node bodies. Other raw-string emissions of `__X.method(...)` need updating individually.
- Templates in `lib/templates/backends/typescriptGenerator/`:
  - `blockSetup.mustache`
  - `forkBlockSetup.mustache` (note: no `__stateStack` rebind, because the branch ALS frame from `runBatch.runInBranchAlsFrame` carries the branch stack)
  - `interruptAssignment.mustache`
  - `interruptReturn.mustache`
  - `resultCheckpointSetup.mustache`
  - `functionCatchFailure.mustache`
  - `finalizeClosure.mustache`
  - `withHandlerWrapper.mustache`
  - `builtinFunctions/system.mustache`, and the other per-builtin templates next to it
- Generated mirrors in `lib/templates/.../*.ts` are regenerated by `pnpm run templates`. Never edit them by hand.
- Runtime helpers: `lib/runtime/runner.ts`, if a Runner method signature took the value as a positional arg. `Runner.thread(...)` is the one example.

## Related docs

- [docs/dev/runtime/async-context.md](../runtime/async-context.md) — `agencyStore` itself, frame seeding sites, frame kinds.
- [docs/dev/compiler/typescript-ir.md](./typescript-ir.md) — TsNode tree the IR builders produce.
- [docs/dev/runtime/threads.md](../runtime/threads.md) — `ThreadStore` and `MessageThread` design.
- [docs/superpowers/plans/2026-05-26-als-migration-phase-4-cleanup.md](../../superpowers/plans/2026-05-26-als-migration-phase-4-cleanup.md) — outstanding migration tasks.
