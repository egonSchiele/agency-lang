# Codegen ALS accessors: `__threads()`, `__ctx()`, `__stateStack()`

This doc covers how generated Agency code reads runtime values (the `ThreadStore`, `RuntimeContext`, `StateStack`) from the active `agencyStore` ALS frame, the file layout for the codegen → runtime → template path, and the recipe for adding a new accessor or pruning an existing setup-block local.

Sister doc: [docs/dev/async-context.md](./async-context.md) describes `agencyStore` itself and where frames are installed. Read that first.

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

## Current status (as of 2026-05-26)

| Local | Status | Accessor | PR |
| --- | --- | --- | --- |
| `__threads` | ✅ pruned | `__threads()` | [#201](https://github.com/egonSchiele/agency-lang/pull/201) |
| `__graph` | ✅ pruned (dead code) | — | this PR |
| `statelogClient` | ✅ pruned (dead code) | — | this PR |
| `__stateStack` | ✅ pruned | `__stateStack()` | this PR |
| `__ctx` | ❌ still a const | `__ctx()` (defined in runtime, codegen migration deferred — see "Why `__ctx` is deferred" below) | TBD |

Alongside the accessor migrations, function and node body try blocks now wrap in `await agencyStore.run({ctx, stack, threads}, async () => { ... })` (defense-in-depth — closes the gap between Runner-managed steps where the outer ALS frame could be lost by a future refactor).

Migration roadmap: [docs/superpowers/plans/2026-05-26-als-migration-phase-4-cleanup.md](../superpowers/plans/2026-05-26-als-migration-phase-4-cleanup.md).

### Why `__ctx` is deferred

Migrating `__ctx` is structurally identical to `__threads` and `__stateStack`, but three complications make it a meaningfully larger change than the rest of Phase 4:

1. **Top-level rebind for docstring interpolation.** When a module has a function or graph node with an interpolation segment in its doc string (`"version ${toolVersion}"`), the codegen emits `const __ctx = __globalCtx;` at the module top scope so the *eager* tool-registration object literal can read `__ctx.globals.get(...)`. This rebind lives at module scope alongside the runtime import — making `__ctx` a `function` import would clash with the rebind, and turning the rebind into a `__ctx()` call would return `undefined` because the eager evaluation happens before any ALS frame is installed.
2. **`classMethod.mustache` has its own `__ctx` setup.** `const __ctx = __state?.ctx || __globalCtx;` is method-scoped and inherits the same "no ALS frame yet at the call boundary" problem.
3. **~17 deref sites in `lib/backends/typescriptBuilder.ts`.** Each needs the lenient (`__ctx()`) vs strict (`getRuntimeContext().ctx`) decision (per the rule in the next section), and several of them sit inside top-level emission paths where ALS is genuinely not available.

This PR ships the `__ctx()` accessor (in `lib/runtime/asyncContext.ts`, exported from `lib/runtime/index.ts`) so the runtime piece is ready, but defers the codegen migration to a follow-up that can handle the docstring-interpolation rewrite in isolation.

## Why two flavors: `__X()` vs `getRuntimeContext().X`

Both shapes read from the same ALS frame, but they behave differently when **no frame is installed**:

- **`__X()`** (lenient) — `agencyStore.getStore()?.X`. Returns `undefined` when no frame. Safe at sites where the consumer either tolerates `undefined` (`setupFunction({state: {threads: __threads()}})` — `setupFunction` falls back to a fresh `ThreadStore` when `threads` is undefined) or assigns into an object property where `undefined` will surface later as a clearer error.
- **`getRuntimeContext().X`** (strict) — throws `"getRuntimeContext() called outside an Agency execution frame..."`. Use at sites where `undefined` would dereference unactionably (e.g. `getRuntimeContext().threads.active().push(...)` — without the throw, you'd see a cryptic `Cannot read properties of undefined (reading 'active')`).

Rule of thumb: **call the accessor when the value is being passed somewhere; call `getRuntimeContext().X` when the value is being immediately dereferenced.** The Copilot review on PR #201 caught one missed case at `system.mustache` where `__threads().active().push(...)` would crash with a generic TypeError — that line now uses `getRuntimeContext().threads.active().push(...)`.

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
│  blockSetup, classMethod, system,    │    template that referenced the
│  debugger, interruptAssignment,      │    local
│  interruptReturn, ...                │
╰──────────────────────────────────────╯
```

Generated code, after a successful migration:

```ts
import {
  ...
  __threads, __stateStack, __ctx, getRuntimeContext,
  ...
} from "agency-lang/runtime";

graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({ state: __state });
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  // No __ctx, __threads, __stateStack, statelogClient, __graph here.
  let __forked;
  let __functionCompleted = false;

  const runner = new Runner(__ctx(), __stack, {
    nodeContext: true,
    state: __stack,
    moduleId: "...",
    scopeName: "main",
    threads: __setupData.threads,
  });

  try {
    // body — every reference to the old locals is now a call:
    //   __threads().active().push(...)
    //   __ctx().checkpoints.create(...)
    //   __stateStack().pop()
    // (or `getRuntimeContext().X` at strict sites)
  } finally {
    __stateStack()?.pop();
  }
});
```

## Recipe: adding a new accessor

If you find yourself wanting to prune another setup-block local (or simply add a new read-from-ALS helper for stdlib JS code), follow this recipe. Estimated time: ~30 min for the code change, plus fixture regen.

### 1. Define the accessor

[`lib/runtime/asyncContext.ts`](../../lib/runtime/asyncContext.ts):

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
  myThing: MyThing;          // new
};
```

…and seed it at every `agencyStore.run(...)` call site: `runNode`, `Runner.runInScope`, `runBatch.runInBranchAlsFrame`, `runInBootstrapFrame`, `runInTestContext`.

### 2. Re-export from `lib/runtime/index.ts`

```ts
export {
  agencyStore,
  getRuntimeContext,
  runInTestContext,
  __threads,
  __myThing,          // new
  type AgencyStore,
} from "./asyncContext.js";
```

### 3. Add to `imports.mustache`

Generated code can't reference `__myThing` until the runtime import list includes it. Add to [`lib/templates/backends/typescriptGenerator/imports.mustache`](../../lib/templates/backends/typescriptGenerator/imports.mustache):

```
  __call, __callMethod, __threads, __myThing, getRuntimeContext,
```

### 4. Wire the IR builder

If `__myThing` will appear as a value in `ts.obj({...})`/`ts.call(...)` from `typescriptBuilder.ts`, give it an alias in [`lib/ir/builders.ts`](../../lib/ir/builders.ts) `runtime: { ... }`:

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
pnpm tsc --noEmit          # clean
pnpm run lint:structure    # clean
pnpm test:run              # ~90 fixture failures expected
make                       # rebuild dist + recompile stdlib
make fixtures              # regenerate every fixture
pnpm test:run              # 4423/4423
```

Spot-check a fixture: `grep -n "__myThing\|__myThing()" tests/typescriptBuilder/simple.mjs` — the old name should be gone, the call form present.

### 8. Commit + PR

Two commits per the convention:
- `codegen: ...` — code + templates (~20 files)
- `fixtures: regen after ...` — fixture diff (~90 files)

Open with `gh pr create --body-file /tmp/body.md`. Watch for Copilot review within ~2 minutes — the strict-vs-lenient decision is the most common comment.

## Gotchas

### "I added the accessor but generated code still uses the old name"

Three causes, in order of likelihood:

1. Forgot `pnpm run templates` after editing a `.mustache`.
2. Forgot `make fixtures` after editing codegen.
3. Edited the generated `.ts` template file instead of the `.mustache` source. The `.ts` files in `lib/templates/backends/typescriptGenerator/` are AUTO-GENERATED with a header that says so; they get clobbered on the next `pnpm run templates`.

### "tsc passes but vitest fails in fixture comparison tests"

Expected after any codegen change. Run `make fixtures` and re-run vitest. If fixture diffs look bigger than the change should produce, you probably edited a template the wrong way or hit an unintended emission path; diff one fixture to confirm.

### "Test passes locally but `make` fails"

`make` runs `tsc` over the dist build. If you regenerated templates and a generated `.ts` import is malformed, vitest won't notice (it uses ts-node-style transforms with looser checks), but `tsc --noEmit` will. Always run `pnpm tsc --noEmit` before pushing.

### "The accessor returns `undefined` but I expected a value"

You're outside an `agencyStore.run(...)` frame. Three cases:

- **Test harness** without `runInTestContext`. Wrap the call: `await runInTestContext(ctx, stack, threads, () => _myHelper(args))`.
- **Bootstrap scope** (module top-level `const x = ...`, `callback(...)` registration, `onAgentStart` hook). The frame is a `BootstrapThreadStore` if you're reading `threads`; for other fields the frame is real, but reads must not assume node-body semantics. See [docs/dev/async-context.md](./async-context.md) "Frame kinds".
- **A nested `await` after the frame was torn down.** Rare — frames propagate through normal `await` chains. If you see this, the frame was probably popped between scheduling and execution.

### "Don't change `__stateStack` inside `forkBlockSetup.mustache`"

[`forkBlockSetup.mustache`](../../lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache) line 10 has `const __stateStack = __forkBranchStack;`. This is **not** a normal setup-block local — it's an intentional rebind to the branch-specific stack inside a fork branch body. The branch stack must not be sourced from the parent ALS frame (which has the parent's stack); the entry point for the fork branch already installs an inner ALS frame with the branch stack via `runBatch.runInBranchAlsFrame`. Leave the rebind alone when migrating `__stateStack` to `__stateStack()` elsewhere.

### Runner constructor needs explicit `threads`

`Runner.runInScope` re-enters ALS with `this.threads`. If the constructor didn't get `threads`, ALS frames inside steps would use the OUTER frame's `ThreadStore`, which for a tool-called function is the per-run store (wrong — should be a fresh store). Codegen MUST pass `threads: __setupData.threads` (or the equivalent) to every Runner. See PR [#200](https://github.com/egonSchiele/agency-lang/pull/200) for the bug this fixed.

### `Runner.thread(id, method, callback)` reads `this.threads`

Pre-migration, the signature was `Runner.thread(id, threads, method, callback)` and the codegen emitted `runner.thread(0, __threads, "create", ...)`. After PR [#201](https://github.com/egonSchiele/agency-lang/pull/201), the Runner sources `threads` from its own `this.threads` field and the codegen emits `runner.thread(0, "create", ...)`. If you build a `Runner` manually in a test, you MUST pass `threads:` to the constructor or wrap in `agencyStore.run(...)` — otherwise `runner.thread(...)` throws a clear error.

## Reference: every "ALS frame" site in the runtime

For grep-friendliness when adding a new field to `AgencyStore`:

| Site | File | Frame kind | Notes |
| --- | --- | --- | --- |
| `runNode` top-level wrap | [lib/runtime/node.ts](../../lib/runtime/node.ts) | node | Wraps every fresh agent run; outer frame for all node bodies. |
| `runNode` `onAgentStart` | [lib/runtime/node.ts](../../lib/runtime/node.ts) | bootstrap | Fires before any node runs. |
| `runNode` `onAgentEnd` | [lib/runtime/node.ts](../../lib/runtime/node.ts) | node | Fires after the run completes — uses the real ThreadStore. |
| `initializeGlobals` + `registerTopLevelCallbacks` | [lib/runtime/node.ts](../../lib/runtime/node.ts) | bootstrap | Module-level setup. |
| `Runner.runInScope` | [lib/runtime/runner.ts](../../lib/runtime/runner.ts) | node | Per-step ALS re-wrap. |
| `runBatch.runInBranchAlsFrame` | [lib/runtime/runBatch.ts](../../lib/runtime/runBatch.ts) | node (branch) | Per-fork-branch ALS with branch stack. |
| `respondToInterrupts` resume wrap | [lib/runtime/interrupts.ts](../../lib/runtime/interrupts.ts) | bootstrap | Resume from interrupt. |
| `rewindFrom` replay wrap | [lib/runtime/rewind.ts](../../lib/runtime/rewind.ts) | bootstrap | Replay from checkpoint. |
| `runInTestContext` | [lib/runtime/asyncContext.ts](../../lib/runtime/asyncContext.ts) | test | Convenience wrapper for unit tests. |

When you add a new field to `AgencyStore`, every entry in this table needs to seed that field. Forgetting one site is the most common source of "the accessor returns undefined" bugs.

## Reference: every emission site that touches a setup-block local

Use this as a checklist when migrating one of the remaining locals (`__ctx`, `__stateStack`):

- IR builder: `lib/ir/builders.ts` → `ts.runtime.X` definition, `setupEnv({...})` signature + body, any helper that constructs an identifier from the name.
- Backend: `lib/backends/typescriptBuilder.ts` → search for the bare name; both function-body emission (around line 1473) and node-body emission (around line 2179) call `setupEnv`. Other raw-string emissions of `__X.method(...)` need updating individually.
- Templates: `lib/templates/backends/typescriptGenerator/`:
  - `blockSetup.mustache`
  - `forkBlockSetup.mustache` (caveat: `__stateStack` rebind, see Gotchas)
  - `classMethod.mustache`
  - `debugger.mustache`
  - `interruptAssignment.mustache`
  - `interruptReturn.mustache`
  - `resultCheckpointSetup.mustache`
  - `functionCatchFailure.mustache`
  - `builtinFunctions/system.mustache` (and any other per-builtin templates)
- Generated mirrors in `lib/templates/.../*.ts` — auto-regenerated by `pnpm run templates`. Never edit by hand.
- Runtime helpers: `lib/runtime/runner.ts` if Runner method signatures referenced the value as a positional arg (rare — `Runner.thread(...)` is the example).

## Related docs

- [docs/dev/async-context.md](./async-context.md) — `agencyStore` itself, frame seeding sites, frame kinds.
- [docs/dev/typescript-ir.md](./typescript-ir.md) — TsNode tree the IR builders produce.
- [docs/dev/threads.md](./threads.md) — `ThreadStore` and `MessageThread` design.
- [docs/superpowers/plans/2026-05-26-als-migration-phase-4-cleanup.md](../superpowers/plans/2026-05-26-als-migration-phase-4-cleanup.md) — outstanding migration tasks.
