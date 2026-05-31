# Cross-module Static / Global Init Order

This document explains how Agency guarantees that imported `static const` (and top-level `let` / `const`) values are populated before any importer reads them. It is the internals doc for the subsystem that landed as PR #237 and fixed issue #232.

If you are looking for the *user-facing* contract, see [`docs/site/guide/execution-model.md`](../site/guide/execution-model.md#cross-module-init-order). If you are looking for the older global-variable init story (top-level expressions running outside any node context, esbuild async issues, etc.), see [`docs/dev/init.md`](./init.md). That doc covers a different problem; this one is strictly about cross-module ordering.

---

## The bug

Before the fix, this code crashed with `TypeError: Cannot read property of undefined`:

```agency
// shared.agency
export static const BASE_DIR = "${env(\"HOME\")}/.myapp"
```

```agency
// main.agency
import { BASE_DIR } from "./shared.agency"

export static const CONFIG_PATH = "${BASE_DIR}/config.json"

node main() { return read(CONFIG_PATH) }
```

The codegen emitted each module's top-level code into an `__initializeGlobals(__ctx)` function and triggered that function lazily on the first node-entry of each module. The lazy-init check was *per-module*. Concretely:

```diagram
╭────────────────────────────────────────────────────────────╮
│ Node loads main.js                                         │
│   → ES module body runs                                    │
│   → static let CONFIG_PATH;     ← decl only, not init      │
│                                                            │
│ User calls mod.main()                                      │
│   → entry to node `main` triggers lazy-init                │
│   → if (!__ctx.globals.isInitialized("main")) {            │
│       await __initializeGlobals(__ctx)                     │
│       │  CONFIG_PATH = `${BASE_DIR}/config.json`           │
│       │      ↑ reads BASE_DIR from shared.js               │
│       │      ↑ but shared.js's __initializeGlobals         │
│       │        has NEVER run, because no function in       │
│       │        shared.js has been called!                  │
│       │  → BASE_DIR is undefined → crash                   │
│     }                                                      │
╰────────────────────────────────────────────────────────────╯
```

The pre-fix design relied on each module being self-sufficient: a module would init its own globals on first use. That falls apart when a module's init expression *reads from another module*. The importer's init fires first (because the importer is what the user called into), but the imported module's init has never been triggered.

The fix had to guarantee: *every* reachable module's statics must be populated *before* any of them are read, regardless of which module hosts the entry point.

---

## Architecture: two-phase init with a process-global orchestrator

The fix introduces three pieces that work together:

1. **Per-static memoized async getters** (`__init_X`) — every top-level `static const X = expr` is compiled into a lazy async getter; the assignment to the underlying `let X` happens inside that getter. Reads of an imported `X` cascade through the getter graph.
2. **A two-phase per-module init split** — each module gets `__initializeStatic(__ctx)` (populates statics) and `__runImperatives(__ctx)` (runs top-level imperatives). They MUST run in two distinct phases globally: every module's Phase 1 before any module's Phase 2.
3. **A process-global registry + orchestrator** — every compiled module self-registers at ES-import time. The entry module's `__initializeGlobals` iterates the registry, running Phase 1 across all modules, then Phase 2 across all modules.

```diagram
                       ╭──────────────────────────╮
                       │ ES module load (Node)    │
                       │  depth-first post-order  │
                       ╰──────────┬───────────────╯
                                  │
                                  ▼
            ┌──────────────────────────────────────────────┐
            │ Each module's top-level code runs:           │
            │   - decls (`let X`)                          │
            │   - getter pairs (`__init_X = __initVar...`) │
            │   - __registerModule({                       │
            │       __moduleId,                            │
            │       __initializeStatic,                    │
            │       __runImperatives,                      │
            │     })                                       │
            └──────────────────────┬───────────────────────┘
                                   │
                                   ▼
            User awaits a node (e.g. `await mod.main()`)
                                   │
                                   ▼
            ┌──────────────────────────────────────────────┐
            │ Lazy first-call check at function entry:     │
            │   if (!__ctx.globals.isInitialized(...))     │
            │     await __initializeGlobals(__ctx)         │
            └──────────────────────┬───────────────────────┘
                                   │
                                   ▼
            ┌──────────────────────────────────────────────┐
            │ __initializeGlobals(__ctx):                  │
            │   const registered = __getRegisteredModules()│
            │   ╭── Phase 1 ────────────────────────────╮  │
            │   │ for (const mod of registered)         │  │
            │   │   await mod.__initializeStatic(__ctx) │  │
            │   ╰───────────────────────────────────────╯  │
            │   ╭── Phase 2 ────────────────────────────╮  │
            │   │ for (const mod of registered)         │  │
            │   │   await mod.__runImperatives(__ctx)   │  │
            │   ╰───────────────────────────────────────╯  │
            └──────────────────────────────────────────────┘
                                   │
                                   ▼
                            Node body runs.
```

The two phases exist because top-level imperatives in module C may read a `static const X` from module B that no init expression depends on. If we ran Phase 1 and Phase 2 interleaved per module, the imperative would observe `undefined` when it ran before B's Phase 1.

---

## The per-static getter cascade

The user writes:

```agency
// shared.agency
export static const A = computeA()

// main.agency
import { A } from "./shared.agency"
export static const B = transform(A)
```

The codegen emits, in each module:

```ts
// shared.js
export let A;
async function __init_A_compute(__ctx) {
  A = __deepFreeze(await computeA(__ctx));
  return A;
}
const __init_A = __initVar("shared:A", __init_A_compute);
export { __init_A };
```

```ts
// main.js
import { __init_A } from "./shared.js";

export let B;
async function __init_B_compute(__ctx) {
  // The cross-module read of `A` was rewritten by InitGetterRewriter
  // into a `__init_A(__ctx)` cascade.
  B = __deepFreeze(await transform(__ctx, await __init_A(__ctx)));
  return B;
}
const __init_B = __initVar("main:B", __init_B_compute);
export { __init_B };
```

`__initVar` is a memoized async-getter factory ([`lib/runtime/initVar.ts`](../../lib/runtime/initVar.ts)). The first call kicks off the compute and caches the resulting promise; every subsequent call (and every concurrent call) gets the same cached promise. So no matter how many places `await __init_A(__ctx)` shows up — in `__init_B`'s compute, in another module's compute, in a function body — `__init_A_compute` runs exactly once. Permanent failures (rejected promises) are also cached: a rejection is never retried.

This cascade is the mechanism that handles *cross-module reads inside init expressions*. The orchestrator's Phase 1 just makes sure every getter is *touched at least once* per execCtx so populated values are visible to Phase 2 imperatives and to function bodies that read them later.

---

## Important files

### Runtime (`lib/runtime/`)

| File | Role |
| --- | --- |
| [`initVar.ts`](../../lib/runtime/initVar.ts) | The memoized async-getter primitive. `__initVar(name, computeFn)` returns a getter; the first call invokes `computeFn`, every subsequent call returns the same cached promise. Includes cycle detection (throws if a getter awaits itself transitively) and the `__requireInitVar` helper that throws a clean error when consumers import a pre-#232 compiled module. |
| [`initOrchestrator.ts`](../../lib/runtime/initOrchestrator.ts) | The process-global module registry. `__registerModule(mod)` appends or replaces in place (last-write-wins on `__moduleId`, preserves DFS position). `__getRegisteredModules()` returns a snapshot in registration order. `__resetModuleRegistry()` is a test-only hook. |
| [`initOrchestrator.test.ts`](../../lib/runtime/initOrchestrator.test.ts) | Unit tests for the registry (append-on-first, replace-on-duplicate). |
| [`initVar.test.ts`](../../lib/runtime/initVar.test.ts) | Unit tests for the memoized getter (concurrent calls, diamond deps, cycle detection, permanent-failure semantics, cross-module cycle behavior). |
| [`index.ts`](../../lib/runtime/index.ts) | Re-exports `__initVar`, `__requireInitVar`, `__registerModule`, `__getRegisteredModules`, `__resetModuleRegistry`, `ModuleInitHandle` so generated modules and the stdlib can `import` them via the `agency-lang/runtime` barrel. |

### Codegen (`lib/backends/typescriptBuilder/`)

| File | Role |
| --- | --- |
| [`sectionAssembler.ts`](../../lib/backends/typescriptBuilder/sectionAssembler.ts) | Emits the per-module init shape: `let X` decls, `__init_X_compute` + `__init_X` pairs, the `__MY_INIT_GETTERS` array, `__initializeStatic`, `__runImperatives`, `__initializeGlobals`, and the self-registration call. The three relevant functions are `buildStaticVarSetup`, `buildRunImperativesFn`, and `buildInitializeGlobalsFn`. |
| [`initGetterRewriter.ts`](../../lib/backends/typescriptBuilder/initGetterRewriter.ts) | Helper that rewrites references to imported statics inside init-context compute bodies — e.g. `transform(A)` becomes `transform(await __init_A(__ctx))`. Single owner of the `__init_X` / `__init_X_compute` naming convention (exposed via `InitGetterRewriter.getterName(name)` and `InitGetterRewriter.computeName(name)`). |
| [`lib/backends/typescriptBuilder.ts`](../../lib/backends/typescriptBuilder.ts) | The driver. Sets up the partition between static-init exprs and top-level imperatives via `partitionProgram` (with the `onStaticVarNamesCollected` callback that pre-populates the rewriter's known-static-names set), and emits the lazy first-call orchestrator trigger inside every `setupFunction` / `setupNode` epilogue (the `if (!__ctx.globals.isInitialized(...)) await __initializeGlobals(...)` block around line 1602). Also contains the docstring-interpolation eager-init shim around line 3439 (see "Known limitations"). |

### Codegen templates (`lib/templates/`)

| File | Role |
| --- | --- |
| [`backends/typescriptGenerator/imports.mustache`](../../lib/templates/backends/typescriptGenerator/imports.mustache) | The header every generated `.js` file gets. Imports `__initVar`, `__requireInitVar`, `__registerModule`, `__getRegisteredModules` from `agency-lang/runtime`. Change this and run `pnpm run templates` to regenerate `imports.ts`. |
| [`backends/typescriptGenerator/imports.ts`](../../lib/templates/backends/typescriptGenerator/imports.ts) | Generated from the mustache file. Do not edit by hand. |

### Tests

| File | Role |
| --- | --- |
| [`lib/backends/static-init-runtime.test.ts`](../../lib/backends/static-init-runtime.test.ts) | Runtime-side coverage: concurrent runs share memoization, resume / repeat invocations don't re-run init, trace captures populated cross-module state, backward-compat guard fires when a `pkg::` dep is pre-#232. Calls `__resetModuleRegistry()` before each dynamic import so registry state doesn't leak between tests. |
| `tests/agency/static-init-concurrent-runs/` | Fixture: two parallel `main()` calls share a single static-init pass. |
| `tests/agency/static-init-cross-module/` | Fixture: importer reads exporter's `static const`. The canonical #232 repro. |
| `tests/agency/static-init-function-mediated/` | Fixture: `static const X = computeX()` where `computeX` is a top-level `def` that reads another module's static. Exercises the function-mediated init path that gated `markInitialized` placement. |
| `tests/agency/static-init-cross-module-diamond/` | Fixture: diamond import graph (A imported by B and C, both imported by main); confirms A's compute runs once. |
| `tests/agency/static-init-cross-module-cycle/` | Fixture: documents that cross-module `.agency` import cycles do compile but crash at module load with a TDZ error in `__registerTool` (a pre-existing limitation unrelated to #232). |
| `tests/agency/static-init-mixed-module/` | Fixture: mixed module with both statics and imperatives; observes the phase ordering via `onFunctionStart` callbacks. |
| `tests/agency/static-init-cycle/` | Fixture: init-expression cycle; expects `__initVar`'s cycle-detection error. |
| `tests/agency/global-let-cross-module/` | Fixture: cross-module *importer-side* global; the source module exports `static const`, the importer creates a top-level `const` that captures it. |
| Many `tests/typescriptGenerator/*.mjs`, `tests/typescriptBuilder/*.mjs` | Snapshot fixtures regenerated by `make fixtures` whenever codegen changes. Most of PR #237's line count is these regenerations. |

### Documentation

| File | Role |
| --- | --- |
| [`docs/site/guide/execution-model.md`](../site/guide/execution-model.md#cross-module-init-order) | User-facing contract: what guarantees Agency provides about init ordering. |
| [`docs/dev/init.md`](./init.md) | The *older* init story — top-level expressions running outside any node context, esbuild async issues, debugger / interrupt / checkpoint integration. Predates and is orthogonal to this doc. |
| PR [#237](https://github.com/egonSchiele/agency-lang/pull/237) + issue [#232](https://github.com/egonSchiele/agency-lang/issues/232) | The implementation PR and the bug report that drove it. Skim for the original design discussion, alternatives considered in review, and the rollout sequence. |

---

## Anatomy of a generated module

When you compile any `.agency` file under this subsystem, every generated module has the following shape (annotated):

```ts
// === imports (from imports.mustache) ===
import { __initVar, __registerModule, __getRegisteredModules /* ... */ } from "agency-lang/runtime";
import { __init_A } from "./shared.js";  // cross-module getter imports

// === per-static let decls ===
export let B;

// === per-static getter pairs ===
async function __init_B_compute(__ctx) {
  B = __deepFreeze(await transform(__ctx, await __init_A(__ctx)));
  return B;
}
const __init_B = __initVar("main:B", __init_B_compute);
export { __init_B };

// === orchestrator-facing array ===
const __MY_INIT_GETTERS = [__init_B];

// === Phase 1 ===
async function __initializeStatic(__ctx) {
  __ctx.globals.markInitialized("main");  // ← see "markInitialized placement"
  for (const init of __MY_INIT_GETTERS) await init(__ctx);
  await __ctx.writeStaticStateToTrace(__globalCtx.getStaticVars());
}

// === static-state snapshot for trace writer ===
function __getStaticVars() { return { B }; }
__globalCtx.getStaticVars = __getStaticVars;

// === Phase 2 ===
async function __runImperatives(__ctx) {
  // (top-level let X = ..., bare top-level calls, etc.)
}

// === backward-compat shim ===
async function __initializeGlobals(__ctx) {
  const __registered = __getRegisteredModules();
  for (const mod of __registered) await mod.__initializeStatic(__ctx);
  for (const mod of __registered) await mod.__runImperatives(__ctx);
}

// === self-register ===
__registerModule({
  __moduleId: "main",
  __initializeStatic,
  __runImperatives,
});

// === user-written top-level code (handlers, tool registrations, etc.) ===
// ...
```

Function bodies emitted elsewhere in the module (nodes, defs) all start with:

```ts
if (!__ctx.globals.isInitialized("main")) {
  await __initializeGlobals(__ctx);
}
```

That lazy first-call check is what kicks the orchestrator. Whichever module hosts the entry point, the orchestrator walks the *full* registry — so every module's statics get populated, not just this one's.

---

## Invariants

These are the load-bearing rules. Break any of them and #232 (or a related bug) comes back.

### 1. Phase 1 fully finishes before Phase 2 starts on ANY module

The phase split is the whole point. Top-level imperatives can read statics from other modules. If we run Phase 1+Phase 2 per module (instead of all-Phase-1 then all-Phase-2), a Phase-2 statement in module C might observe an unpopulated static in module B because B's Phase 1 hasn't run yet.

Concretely: never let an imperative in `__runImperatives` start running before every registered module's `__initializeStatic` has resolved.

### 2. `markInitialized` lives at the TOP of `__initializeStatic`, not inside `__runImperatives`

The marking placement matters for re-entrancy. Consider:

```agency
static const X = computeX()  // computeX is a top-level `def`
def computeX(): number { return read("/etc/version") }
```

`__init_X_compute` calls `computeX(__ctx)`. `computeX` is a function, so on entry it hits the lazy first-call check — `if (!__ctx.globals.isInitialized("...")) await __initializeGlobals(...)`. Without marking the module up front, this would re-enter `__initializeGlobals`, which would re-enter `__initializeStatic`, which would re-await `__init_X` — and `__init_X`'s cached promise is in-flight, so we'd deadlock.

Marking at the top of `__initializeStatic` (BEFORE the for-loop iterates the getters) short-circuits that re-entry. The orchestrator still drives every module's `__runImperatives` from the outer `__initializeGlobals` call, so global-init side effects still happen — the lazy-init check just stops re-firing the orchestrator from inside `computeX`.

### 3. The orchestrator iterates SEQUENTIALLY with `for await`, not `Promise.all`

Two reasons:
- **Trace and checkpoint replay determinism.** `Promise.all` interleaves dep chains in whatever microtask order they happen to resolve, which makes trace events arrive in different orders run-to-run.
- **The phase invariant.** With `Promise.all`, one module's `__runImperatives` could conceivably start before another module's `__initializeStatic` finished (if one phase's `Promise.all` resolves before another's). Sequential `for await` makes the phase split impossible to violate accidentally.

### 4. `__init_X_compute` must be a NAMED function declaration

The `__initVar` cycle-detection error message tells the user "every frame named `__init_*` is a participating variable." That promise only holds if the compute closures actually have names V8 prints in stack traces. An anonymous arrow inside the `__initVar` call expression would show up as just `<anonymous>` and the error would be useless.

`InitGetterRewriter.computeName(name)` is the single owner of the naming convention; codegen always uses it.

### 5. Registration order is fixed by ES module load order

Don't add registration calls from anywhere other than each module's own top-level code. The order matters: post-order DFS over the static import graph (deps register before importers, entry module registers last). The orchestrator relies on that ordering for trace determinism and for the Phase 2 invariant.

### 6. The cross-module init contract is NOT serialized into checkpoints

`__ctx.globals.isInitialized(moduleId)` and the `__init_X` memoization caches are *runtime* state, not checkpoint state. On resume after rewind/restore, `__initializeGlobals` is re-invoked on the restored execCtx, and the `__init_X` caches are repopulated. The `__initVar` memoization makes this free (cached promises resolve immediately).

If you find yourself trying to serialize init state, stop and re-read this section.

---

## Common pitfalls

### Editing `imports.mustache` without regenerating

The mustache file is the source; `imports.ts` is generated. Edit only the `.mustache` file and run `pnpm run templates` to regenerate. Forgetting this means generated modules import a stale shape and you get cryptic "no matching export" errors at runtime — exactly what bit the `pack` test when the rename in PR #237 first landed.

### Editing codegen without running `make fixtures`

The hundreds of `tests/typescriptGenerator/*.mjs` and `tests/typescriptBuilder/*.mjs` files are full-module snapshots. Any codegen change rewrites them. After editing `sectionAssembler.ts` or `typescriptBuilder.ts`, always:

```bash
make fixtures      # regenerates everything under tests/typescriptGenerator/ + tests/typescriptBuilder/
make stdlib        # rebuilds stdlib .js if the imports template changed
```

### Test isolation: forgetting `__resetModuleRegistry()`

The orchestrator registry is a process-global. Any test that dynamically imports a freshly-compiled fixture must call `__resetModuleRegistry()` first, or it will iterate handles from prior fixtures and re-run their `__initializeStatic` / `__runImperatives`. See [`lib/backends/static-init-runtime.test.ts`](../../lib/backends/static-init-runtime.test.ts) for the pattern.

### Believing the docstring before reading the code

Several docstrings in PR #237's first commits drifted from the implementation during refactoring (e.g. claiming `__runImperatives` has an `isInitialized` guard when it doesn't). The post-merge review caught those. When in doubt, read the actual emitted statements, not the comment block above the function.

---

## Known limitations

### Circular `.agency` imports crash at module load

If `a.agency` imports `b.agency` and `b.agency` imports `a.agency`, the generated `a.js` ↔ `b.js` ES modules form a static cycle. ES module resolution handles cycles fine for plain bindings, but `__registerTool` (emitted at the top of every Agency module's bound functions) reads from the importing module's let-bindings before they're populated and crashes with a TDZ error.

This is a *pre-existing* limitation unrelated to #232. The init subsystem doesn't make it worse, but doesn't fix it either. See the cycle test fixture at `tests/agency/static-init-cross-module-cycle/` and the cycle-related test in [`initVar.test.ts`](../../lib/runtime/initVar.test.ts) for the documented behavior.

### Cycles within `__initVar` getters throw a clear error

In contrast to module-level cycles, init *expression* cycles — `static const A = f(B)` where `B = g(A)` — are detected by `__initVar` and throw with a list of participating `__init_*` frames. That's the intended behavior; the error tells the user which definitions form the cycle.

### Per-process registry, not per-entry

The registry is a single process-global list. If a long-lived process loads multiple unrelated compiled Agency programs (or a test runner imports many fixtures back-to-back without resetting), every registered module is visited by every subsequent `__initializeGlobals` call. Per-entry scoping would require recording dependency edges at registration time and walking only the reachable subgraph from the entry module — tracked as a follow-up but not implemented.

For production (single-entry processes) this is a non-issue. For tests, see "Test isolation" above.

### Docstring interpolation triggers eager init at module load (#239)

When a module has a function with `${global}` interpolation inside its docstring, codegen emits a fire-and-forget `__runImperatives(__globalCtx);` at module-load time so the description string can read populated globals synchronously. This has two ugly side effects:

1. **Every top-level imperative fires at import time**, not just the `globals.set` calls the docstring needs. A user's top-level `sendStartupMetric(...)` will fire whenever any module imports the file.
2. **Those imperatives fire AGAIN when `main()` runs**, because the eager call wrote to `__globalCtx` but the lazy first-call check at function entry reads `__ctx.globals.isInitialized` on the per-execution `__ctx`. They're separate stores.

The proper fix is to make tool descriptions *lazy* (a thunk or a getter property), so nothing has to run at import time. Tracked as issue #239.

### Cross-module re-imports under cache-busting

PR #237's commit `Cross-module init: last-write-wins on __registerModule (#238)` handles HMR / cache-busted dynamic re-imports by replacing the stale module's handles in place when a new instance registers under the same `__moduleId`. The DFS position is preserved. Normal ESM operation is unaffected (a module body only runs once per realm, so `__registerModule` is called exactly once per `__moduleId`).

---

## When you change this subsystem

A rough checklist:

1. Read this doc.
2. Skim PR #237 + the comments thread for design context.
3. Make your change in `lib/runtime/` or `lib/backends/typescriptBuilder/`.
4. If you touched `imports.mustache`, run `pnpm run templates`.
5. Run `pnpm run build`.
6. Run `make fixtures` to regenerate snapshot fixtures.
7. If you changed runtime exports or codegen, run `make stdlib` so the bundled `.js` reflects the change.
8. Run the targeted tests:
   ```bash
   pnpm vitest run lib/runtime/initVar.test.ts lib/runtime/initOrchestrator.test.ts lib/backends/static-init-runtime.test.ts
   ```
9. Run the full lib unit suite:
   ```bash
   pnpm vitest run lib/
   ```
10. If you changed anything user-observable, update `docs/site/guide/execution-model.md`.
11. If you broke any invariant above (intentionally or otherwise), update *this* doc.

---

## Related docs

- [`docs/dev/init.md`](./init.md) — the older global-variable init story (esbuild async, checkpoint integration, debugger / interrupt support).
- [`docs/dev/globalstore.md`](./globalstore.md) — the per-execCtx globals store that backs `__ctx.globals.get` / `set` / `isInitialized` / `markInitialized`.
- [`docs/dev/checkpointing.md`](./checkpointing.md) — checkpoint state model; explains why init state is NOT serialized.
- [`docs/dev/interrupts.md`](./interrupts.md) — interrupt-response path; calls `__initializeGlobals` on resume.
- [`docs/dev/typescript-ir.md`](./typescript-ir.md) — the `TsNode` tree the codegen emits into.
- [`docs/dev/pkg-imports.md`](./pkg-imports.md) — `pkg::` imports; relevant to the backward-compat-guard path.
