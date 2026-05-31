# Lift `static` Out of `__ctx.globals` Into JS Module Bindings

> Status: **idea** / RFC. Not implemented. Captured here so the architectural intent doesn't live only in chat history.

## TL;DR

Today, Agency's `static const X = expr` compiles to a runtime entry in `__ctx.globals` — even though `static` semantically means "this value is fixed across all runs of the agent." The mismatch (cross-run value, per-execution store) is the structural reason PR #237 had to introduce a process-global module registry, a two-phase orchestrator, and per-variable memoized async getters. None of that machinery is needed if `static` values live where they semantically belong: **as plain ES module exports**. Node already handles cross-module init ordering, async compute (via top-level await), and re-exports for free. The proposal: lift statics into JS module-let bindings, leverage Node's existing semantics, and delete most of PR #237's runtime + codegen.

Concurrently, introduce a `static foo()` statement form so users can express "this bare call runs once at module load" cleanly, instead of contorting through `static const _ = foo()`.

## Why this idea exists

PR #237 fixed [issue #232](https://github.com/egonSchiele/agency-lang/issues/232) (cross-module `static const` reads returning `undefined`) with a tactical mechanism: every `static const X` became a memoized async getter (`__init_X`) keyed in a process-global registry; an orchestrator (`__initializeGlobals`) walked the registry in two phases — first populating all statics, then running all top-level imperatives.

That works. But the architectural retrospective revealed the complexity is irreducible *only because Agency tries to make `static` live inside `__ctx.globals`*. If you accept that statics are JS module-level (they are! that's what `static` means), Node's ES module resolution already provides:

- Depth-first post-order import resolution → deps initialized before importers.
- Top-level await → async statics work.
- Re-exports (`export { X } from "./D"`) → name routing through intermediate modules.
- Module-singleton-per-realm → no double init.

Everything PR #237's orchestrator + registry + `__initVar` does is a hand-rolled version of these, but inside `__ctx.globals` instead of in the JS module system.

## The proposal

### 1. `static const X` compiles to a plain ES module export

```agency
// shared.agency
export static const BASE_DIR = "${env(\"HOME\")}/.myapp"
```

```ts
// shared.js — proposed
import { env } from "agency-lang/stdlib/system.js";
export const BASE_DIR = `${env(__globalCtx, "HOME")}/.myapp`;
```

Importers consume it as a plain JS import:

```agency
// main.agency
import { BASE_DIR } from "./shared.agency"
export static const CONFIG_PATH = "${BASE_DIR}/config.json"
```

```ts
// main.js — proposed
import { BASE_DIR } from "./shared.js";
export const CONFIG_PATH = `${BASE_DIR}/config.json`;
```

Node guarantees `shared.js`'s body runs before `main.js`'s body (DFS post-order over static imports). `BASE_DIR` is populated before `CONFIG_PATH` reads it. **No `__init_X` getter, no orchestrator, no registry, no two-phase split.**

Asynchronous statics use top-level await:

```agency
static const TOKEN = httpGet("/auth")
```

```ts
export const TOKEN = await httpGet(__globalCtx, "/auth");
```

Cycles in the static-import graph crash at module load with a TDZ error — same as the current `.agency` cycle behavior, and the same as any plain ES module cycle in JS. Neither design fixes cycles.

### 2. `static foo()` statement form for one-time imperatives

Symmetric with `static const`. Defaults are now crisp:

| Source | Semantics |
| --- | --- |
| `static const X = expr` | Value fixed at module load, shared across all runs. |
| `static foo()` | Call fires once at module load, before any run starts. |
| `let X = expr` | Per-run global; re-initialized on every agent run. |
| `foo()` | Per-run side effect; fires whenever the orchestrator runs imperatives. |

This eliminates the existing `static const _x = sideEffect()` workaround idiom (which today is the only way to express "side effect once at load") and removes the bare-call ambiguity entirely — the user just writes what they mean.

Codegen:

```agency
static sendBootMetric("greeter loaded")
```

```ts
await sendBootMetric(__globalCtx, "greeter loaded");   // top-level, at module load
```

### 3. Non-static top-level code stays per-execution

Nothing about `let X = expr` or bare `foo()` changes. They still compile into a per-module `__runImperatives(__ctx)` function fired by the lazy first-call check at function entry. This is the pre-#232 behavior, restored — and it's correct now, because the cross-module ordering problem only exists for *statics*, which are no longer in `__ctx.globals`.

```agency
let counter = 0
sendStartupMetric("greeter started")
```

```ts
async function __runImperatives(__ctx) {
  __ctx.globals.set("counter", 0);
  await sendStartupMetric(__ctx, "greeter started");
}
```

The `__initializeGlobals(__ctx)` shim becomes per-module, no orchestrator — just calls this module's `__runImperatives`. No registry, no cross-module imperative firing (which was also a behavior change in #237 vs pre-#232, see the simpler-alternative analysis).

### 4. Static initializers calling Agency functions

This is the load-bearing question. The answer is: **yes, they can, provided the called functions don't depend on per-execution state**.

Agency `def` already compiles to a JS function whose first arg is `__ctx`. At module load, we pass `__globalCtx` — the module-level context that already exists.

Works:

```agency
import { BASE_DIR } from "./shared.agency"
static const PATH = composePath()
def composePath(): string { return "${BASE_DIR}/config" }
```

```ts
import { BASE_DIR } from "./shared.js";
function composePath(__ctx) { return `${BASE_DIR}/config`; }
export const PATH = composePath(__globalCtx);
```

Cross-module function-mediated chains:

```agency
import { otherFn } from "./other.agency"
static const X = wrapped()
def wrapped(): string { return otherFn() }
```

```ts
import { otherFn } from "./other.js";
function wrapped(__ctx) { return otherFn(__ctx); }
export const X = wrapped(__globalCtx);
```

If `otherFn` reads a static from yet another module, Node has already initialized that module too (DFS guarantee).

Fails honestly:

```agency
static const X = currentNodeId()    // reads __ctx.stateStack — undefined at load
```

Throws at module load with something like `Cannot read 'stateStack' of undefined`. The error is loud and discoverable; the constraint matches the user's intuition that `static` means "doesn't depend on per-execution state."

### 5. The `with approve` handler case

User explicitly asked for this to work at static init:

```agency
static const _ = enableMemory({dir: "..."}) with approve
```

Today this idiom is used in `lib/agents/agency-agent/shared.agency` to wire memory at module load. `enableMemory` may interrupt for approval; the `with approve` handler auto-approves so module load doesn't suspend on an interactive prompt.

Requires a `__withHandler` runtime helper that installs a module-level handler frame:

```ts
export const _ = await __withHandler(__globalCtx, "approve", (__ctx) =>
  enableMemory(__ctx, {dir: "..."})
);
```

`__withHandler` pushes a handler onto a module-level handler stack, runs the callback (passing the same `__globalCtx`), pops the handler, returns the result. Any interrupt thrown by `enableMemory` is caught by the handler and resolved. This is the trickiest piece of the proposal but is bounded — single new runtime helper, ~30 lines.

Other handlers (e.g. user-facing approvals, exception handlers that need a node context) can stay illegal at static init by simply not having a module-level equivalent installed. The honest crash is the same as case 4.

### 6. Trace integration

Today the trace writer snapshots `__ctx.globals` to capture static state. Under this proposal, static state lives in JS module bindings, not in `__ctx.globals`.

Each module exports a small `__getStaticState()` helper:

```ts
// Generated alongside the static exports.
export function __getStaticState() { return { BASE_DIR, PATH }; }
```

Trace startup walks every loaded module (via a small registry that just enumerates known module URLs — much simpler than the full orchestrator registry) and calls `__getStaticState()` to snapshot the populated values. One trace event per module, written when the first run starts.

This is a smaller "registry" than #237's — it only enumerates modules for trace purposes, has no init-orchestration role, and isn't on any hot path.

### 7. Per-execution `__ctx.globals` API stays the same

The runtime `__ctx.globals.get`/`set`/`isInitialized`/`markInitialized` API is unchanged. It just stops being used for statics. Non-static top-level `let X` and bare per-run calls still live there. All existing usages (interrupts, rewind, checkpoints) continue to work.

## What this deletes

If we land the proposal, the following code becomes vestigial:

- `lib/runtime/initVar.ts` (~80 lines) — the memoized async getter primitive. Node's import resolution provides the same guarantee.
- `lib/runtime/initOrchestrator.ts` (~85 lines) — the process-global registry + getter snapshot.
- `lib/runtime/initOrchestrator.test.ts` (~50 lines).
- `lib/backends/typescriptBuilder/initGetterRewriter.ts` — the per-variable `__init_X` naming convention and read rewrite.
- The per-static `__init_X = __initVar(...)` getter emit, the `__MY_INIT_GETTERS` array, and the `__initializeStatic` function in `sectionAssembler.ts`.
- The two-phase `__initializeGlobals` body (registry walk, Phase 1 / Phase 2 loops).
- The `__registerModule(...)` self-registration call at the bottom of every generated module.
- The `__requireInitVar` backward-compat guard.
- Issue #238 (cache-busted re-imports) — dissolves; no registry.
- Issue #239 (docstring-interpolation eager init runs ALL imperatives) — dissolves; statics are already populated by the time the description literal evaluates, no eager call needed.
- The "per-process registry leak" follow-up in `docs/dev/cross-module-init.md` — dissolves; no registry.
- The test-only `__resetModuleRegistry()` hook and the obligation for every fixture test to call it.

Net delta: **~250 LOC of runtime deleted, ~100 LOC of codegen deleted, three documented follow-ups dissolved, one whole subsystem removed.**

## Things that stay

- `let X` / non-static globals: per-execution, `__ctx.globals`-backed. Unchanged.
- `__runImperatives(__ctx)` per module: per-execution imperatives. Unchanged.
- The lazy first-call check at function entry: per-module, no orchestrator.
- Handlers, callbacks, interrupts, rewind, checkpoints, traces: API-compatible.
- The cross-module name resolution (handled by `import { X } from "./B"` instead of `__ctx.globals.get("X")`).

## What this changes for users

- **`static const X = ...` is now a real JS export.** Other JS code can `import { X } from "./foo.js"` and use it directly, without going through Agency's runtime. Plain interop.
- **`static foo()` is new syntax.** Users opt into one-time semantics explicitly; no more `static const _ = foo()` idiom.
- **Top-level await is now visible at the module-load level.** A `static const X = httpGet(...)` blocks `import "./foo.js"` until httpGet resolves. This is consistent with how any other ES module with top-level await works. Cold-start cost for agents with async statics is paid up front, once.
- **Static initializers calling per-execution functions crash at module load** with a clear error. Today they silently misbehave. Loud failures > silent ones.
- **Bare top-level calls in modules whose functions are never called from main()** still don't fire under this design — but under `static foo()` they do (because static fires at module load, not at lazy first-call). The non-static `foo()` keeps pre-#232 lazy-fire behavior. The semantic split is now clear and opt-in.
- **Backward compatibility**: every compiled `.js` would need rebuilding. Acceptable per egonSchiele.

## Open design questions

### Q1. How do we mark functions as static-safe?

Three options:
- **Honest runtime crash.** Calling a non-static-safe function from static init throws when it tries to read missing per-execution state. User learns by experience. Pro: zero spec; matches user mental model. Con: only catches bugs that exercise the bad path.
- **Annotation on `def`.** `@static-safe def composePath(): string { ... }` opts in. Static-init contexts only allow calling annotated functions. Pro: catchable at typecheck time. Con: viral annotation requirement; existing code needs migration.
- **Inferred from body.** Typechecker walks the def's body, sees if it touches per-execution state. Pro: zero user-facing change. Con: complex; would need to track which stdlib functions are per-execution-dependent.

I'd lean toward (1) for the first version; revisit (2) or (3) if it bites.

### Q2. What is the `__globalCtx` available at static init?

`__globalCtx` already exists as a module-level `new RuntimeContext({...})` in every generated module. We'd reuse it. It needs to provide:
- `cwd` (for path resolution in stdlib).
- `env` access (for `env(...)`).
- A handler stack (for `with approve` and similar).
- `globals.get`/`set` for any top-level `let` that fires per-run (these still go through `__ctx`, not `__globalCtx`).

What it does NOT provide: per-execution `stateStack`, per-execution `threads`, the interrupt-driven `respondToInterrupts` machinery. Functions that touch these crash honestly per Q1.

### Q3. Trace timing

Today the trace captures static state when `__initializeStatic` finishes (one event per module per run). Under the proposal, statics populate at module load — long before any run. We have options:

- **Emit static-state events at module load**, before any per-run trace stream exists. Buffer them and prepend to the first per-run trace.
- **Emit static-state events at the start of each per-run trace**, by walking modules and calling `__getStaticState()` per run. Slightly redundant (the values are the same across runs) but matches per-run trace shape.

The second is probably cleaner for trace consumers.

### Q4. What about `pkg::` imports / npm packages?

Today, a `pkg::` import of an Agency package's compiled `.js` works because the consumer's codegen knows to import `__init_X` from it. Under the proposal, the package just exports plain consts; consumers import them as plain JS imports. Strictly simpler. Backward-compat with pre-proposal packages is gone (per egonSchiele), so we just rebuild.

### Q5. Codegen name classifier

The current name classifier distinguishes statics from non-statics inside def bodies so reads of statics become `__ctx.globals.get("X")` and reads of imported names become whatever. Under the proposal, reads of statics become plain JS identifiers (`BASE_DIR`). The classifier needs an updated rule but the change is local to one module.

### Q6. What about `static let`?

Today: parser rejects. Under the proposal: still reject. `static` means "set once at load, immutable across runs." `let` means "mutable." The combination is contradictory. Keep the existing rejection.

### Q7. Module-load-time interrupts other than `with approve`

If a user writes:

```agency
static const X = promptUser("API key?")
```

…with no `with approve` handler, what happens? The function throws an interrupt, no handler catches it, and the throw propagates out of module load. Module fails to load. Clear failure; user adds a handler or rethinks the design. Same answer as Q1.

## Comparison to current architecture

```diagram
╭─────────────────────────────╮         ╭─────────────────────────────╮
│       Current (PR #237)     │         │         Proposed            │
├─────────────────────────────┤         ├─────────────────────────────┤
│ static lives in __ctx.globals│         │ static lives in JS exports │
│ __init_X memoized getters   │         │ plain ES module init        │
│ process-global registry      │   →    │ (none)                      │
│ __initializeGlobals          │         │ Node's module loader        │
│ two-phase orchestrator       │         │ (none)                      │
│ Phase 1: static, Phase 2:    │         │ statics at module load;     │
│   imperatives across modules │         │   __runImperatives per-mod  │
│ + backward-compat guard      │         │ + plain JS imports          │
│ + reset-registry test hook   │         │ + (none)                    │
│ ~750 LOC subsystem           │         │ ~50 LOC remaining           │
╰─────────────────────────────╯         ╰─────────────────────────────╯
```

## Rollout if we do this

1. **Land #237 first** (already done — it fixes the bug correctly). Get bake-in.
2. **File the proposal as an issue** (this doc, or a summary) referencing the cross-module-init internals doc.
3. **Implement in stages:**
   - a. Parser: add `static foo()` statement form. Standalone change, no codegen impact yet.
   - b. Runtime: add `__withHandler` for module-level handler frames.
   - c. Codegen: switch `static const` emit to plain ES module export with top-level await. Reads inside def bodies become plain JS identifiers.
   - d. Trace integration: per-module `__getStaticState()`; trace startup walks modules.
   - e. Delete the orchestrator subsystem: `initVar.ts`, `initOrchestrator.ts`, `initGetterRewriter.ts`, the registry codegen, `__requireInitVar`, the related tests.
   - f. Update `docs/dev/cross-module-init.md` → either deleted entirely or rewritten to "we use Node's module system."
4. **Backward compat**: per egonSchiele, just rebuild all compiled `.js` — small enough user base.

Each stage is independently shippable; the architecture only fully simplifies when all stages land.

## Why this is genuinely better

- **Smaller surface area.** ~700 fewer LOC, three fewer subsystems, three dissolved follow-up issues.
- **Familiarity.** Compiles to plain ES modules. JS developers reading generated code see plain `export const X = ...`, not `__init_X = __initVar("modId:X", __init_X_compute)`.
- **Free interop.** Any JS/TS code can `import { X } from "./agency-output.js"` and use Agency statics directly. Today they'd have to call through the Agency runtime.
- **Loud failures.** Calling per-execution functions at static init fails loudly. Today it might silently observe stale or wrong values.
- **No tactical complexity.** The current design has correctness-load-bearing rules that read like "markInitialized must be at the TOP of `__initializeStatic`, NOT inside `__runImperatives`." Under the proposal, those rules dissolve because the underlying machinery dissolves.

## Why this might not be worth doing

- **PR #237 already shipped.** The bug is fixed. The current architecture, while complex, works. Refactoring for elegance has opportunity cost.
- **Migration cost.** Every compiled `.js` rebuilds. Snapshot fixtures regenerate. Anything depending on `__init_X` exports (the `pkg::` backward-compat guard) breaks. All manageable, but real.
- **Discoverability of static-safe functions.** Q1 above is unresolved; the honest-crash answer might be unsatisfying once users hit it in practice.
- **Top-level await as a hard dependency.** Locks Agency to Node 14+ (already true via `@types/node` floor, but worth re-noting).

## Related

- PR [#237](https://github.com/egonSchiele/agency-lang/pull/237) — the cross-module init fix this proposal would partially replace.
- Issue [#232](https://github.com/egonSchiele/agency-lang/issues/232) — the original bug.
- Issue [#238](https://github.com/egonSchiele/agency-lang/issues/238) — cache-busted re-imports; dissolves under this proposal.
- Issue [#239](https://github.com/egonSchiele/agency-lang/issues/239) — docstring-interpolation eager init; dissolves under this proposal.
- [`docs/dev/cross-module-init.md`](../../dev/cross-module-init.md) — internals doc for the current architecture; would shrink dramatically or be rewritten.
- [`pr-237-simpler-alternative.md`](../../../pr-237-simpler-alternative.md) — a smaller intermediate refactor (drop registry/orchestrator, keep `__init_X` getters in `__ctx.globals`). Compared to this proposal, the simpler alternative is one step short of the cleanup.
