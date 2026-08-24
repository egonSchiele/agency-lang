# Init Topological Sort and Centralized Init

## Overview

Agency files have top-level `static const`, `const`/`let`, and bare
statements that need to run before any node executes. When a module
imports values from other modules, those upstream modules' inits must
complete first. Get the order wrong and a static initializer reads a sentinel and trips
the runtime read-before-init trap. Or a bare statement runs against a
global the importer has not yet populated.

This document describes the system that gets the order right. It
combines:

  - a **compile-time per-variable dependency graph** built across
    the entry's full import closure,
  - a **topological sort** that yields the correct init order (and
    surfaces cycles as compile errors),
  - a **per-module init plan** the codegen consumes to drive
    centralized init (`__initializeStatic`, `__initializeGlobals`),
  - a **runtime registry** (`crossModuleInitRegistry`) that lets one module's
    init `await` another's.

If you are looking for the original "what is `__initializeGlobals`
and why is it async" rationale, see [`init.md`](./init.md). This doc is
about the per-variable + cross-module ordering machinery that wraps
it.

## High-level pipeline

```diagram
╭───────────────────────────╮
│ buildCompiledClosure      │  lib/compiler/compileClosure.ts
│                           │
│  parseClosure             │  parse + resolveReExports per file
│       │                   │
│       ▼                   │
│  SymbolTable.build        │  cross-module symbol info
│       │                   │
│       ▼                   │
│  buildInitDepGraphs       │  static + global graphs per VAR
│       │                   │
│       ▼                   │
│  topSortInitGraph (×2)    │  Kahn over each graph
│       │                   │
│       ▼                   │
│  buildPlans               │  ModuleInitPlan per module
╰─────────────┬─────────────╯
              │
              ▼
╭───────────────────────────╮
│ generateTypeScript        │  one module at a time
│   initPlanForModule(...)  │  projects plan for this file
│        │                  │
│        ▼                  │
│   TypeScriptBuilder.build │
│     partitionProgram(...) │  reorderTagged → init statement order
│     assembleSections(...) │  __initializeStatic + __initializeGlobals
╰─────────────┬─────────────╯
              │
              ▼  generated module on disk
╭───────────────────────────╮
│ Runtime                   │  lib/runtime/crossModuleInitRegistry.ts
│  __registerStaticInit(...)│  modules register themselves at JS-load
│  __awaitStaticInit(...)   │  init bodies await each other
╰───────────────────────────╯
```

## The dep graph (`lib/compiler/initDepGraph.ts`)

Two graphs, one per phase:

  - **staticGraph** — one node per top-level `static const` in any
    module in the closure, plus one per bare `static <statement>`.
    This graph drives `__initializeStatic`, which runs once per process
    per module.
  - **globalGraph** — one node per non-static `const` / `let` and
    one synthetic node per bare top-level statement. A bare statement
    is a `functionCall`, an `interruptStatement`, or a `valueAccess`.
    This graph drives `__initializeGlobals`, which runs once per agent
    execution per module.

A node looks like:

```typescript
type InitVarNode = {
  moduleId: string;                  // absolute source path
  varName: string;                   // user-visible name, or
                                     // `__bareStmt_${line}_${col}`
  kind: "static" | "global";
  initExpr: Expression | AgencyNode; // the RHS or the bare stmt itself
  loc?: SourceLocation;
  exported: boolean;
  sequenceHint: number;              // file-depth * 1e6 + source line
  withApprove?: boolean;             // `with approve` modifier at top level
};
```

Edges go **from a node to every other node its initializer directly
references**. The edge set is derived by walking the initializer
expression for free identifiers and resolving each one through the
shared `ImportAliasResolver`.

**Functions are never edges themselves.** Only values are nodes in
the graph. A bare reference to a function name never produces an
edge to a function node — function defs aren't tracked.

### Depth-1 function-body expansion

When a free identifier in an init expression is a **direct call** of
a top-level Agency function — bare (`getBar()`) or namespace-prefixed
(`bar.getBar()`) — the dep graph walks that function's body once and
treats every top-level value the body reads as an additional
dependency of the enclosing init node. Inner references are resolved
in the function's home module, not the caller's, so an import the
function depends on contributes the correct cross-module edge.

The boundary is exactly one function-body hop:

  - Depth-2+ chains are not followed. The runtime trap (PR 1) is the
    safety net.
  - Function values stored in variables aren't traced. `const f =
    getBar; const foo = f()` produces no expansion, because the call
    site doesn't directly name `getBar`.
  - Method calls on user objects (`obj.method()`) and stdlib or
    built-in functions are silently skipped, because there is no Agency
    AST to walk.

`collectFreeIdentifiers` already skips identifiers inside nested
`function` / `graphNode` bodies via the ancestor stack, so when we
walk a function body for depth-1 expansion the walker naturally stops
at any further nested closures. That gives us the depth-1 boundary for free, with no extra
bookkeeping.

The new piece in the source is the `FunctionDefLookup`
(`lib/compiler/initDepGraph.ts`), which resolves bare or
namespace-prefixed call names to the `(moduleId, FunctionDefinition)`
pair that backs them. `collectDirectCalls` walks an init expression
for call sites and consults the lookup; the body walk reuses
`collectFreeIdentifiers` via `collectFunctionBodyFreeRefs`.

The depth-1 expansion runs in three places, all in lockstep:

  - `depsFor` — adds edges to both static and global graphs.
  - `rejectStaticReferencesGlobal` — surfaces the cross-phase
    violation when a single hop reveals a static reading a global.
  - `globalPhasePlanFor` — augments the cross-phase `awaitModules`
    set so a global reading a cross-module static through one
    function call still emits the right `await __awaitStaticInit`.

Conditional reads inside the called function are treated as
always-reads. That over-approximation may add a few extra `await`s, but it
cannot change correctness.

### Cross-phase rules

Two graphs are kept independent so each can be cycle-checked on its
own. The cross-phase rules are enforced separately:

  - **static → global is a compile error.** A `static const`
    initializer that references a `global` cannot be satisfied at
    Phase A time (globals don't exist yet). Surfaced as
    `StaticReferencesGlobalError` in `rejectStaticReferencesGlobal`.
  - **global → static is allowed.** All statics finish initializing
    before any global init runs. `buildInitializeGlobalsFn` emits
    `await __initializeStatic(__ctx)` near the top of the global init
    body. The dep graph drops the cross-phase ref as an edge but
    `globalPhasePlanFor` scans for cross-module static refs and adds
    them to `awaitModules` so the importing module awaits the
    source's static init.

## The ImportAliasResolver

Resolves a locally-bound name used inside an initializer to the
`(sourceModuleId, sourceName)` pair that defines the value. Two
resolution modes:

  - `resolve(localName, inModuleId)` — walks named imports
    (`import { x } from "./y.agency"`) one hop, using the
    `SymbolTable` for the upstream module's exports.
  - `resolveNamespace(prefix, inModuleId)` — walks namespace
    imports (`import * as bar from "./bar.agency"`). When
    `collectFreeIdentifiers` surfaces a `bar.barStatic`-shape
    valueAccess, the dep graph resolves it as `(bar.agency,
    barStatic)` — the same edge a named import would have produced.

**Re-export chains resolve one hop only.** A chain
`foo → reexport_a → reexport_b → bar` produces three edges, one per
hop, because each intermediate re-exporter has a synthesized wrapper
static (`static const x = _reexport_x`) emitted by
`resolveReExports` that must be initialized at runtime. The cascade
emerges from one-hop edges; do not follow the chain to the ultimate
source in the resolver.

Resolver coverage is complete for the supported export surface. In
Agency, globals cannot be exported at all — only statics can. Users
that want to expose mutable state across modules export a function
that reads or mutates the global, and the global itself stays local
to its defining module. There is therefore no "non-static export
const" case the resolver needs to handle.

## collectFreeIdentifiers (`FreeRef`)

Surface both bare identifiers and `prefix.member` patterns so the
resolver has enough information to handle namespace imports:

```typescript
type FreeRef =
  | { kind: "name"; name: string }
  | { kind: "member"; prefix: string; member: string };
```

The walker skips identifiers that appear inside nested name-binding
constructs (`function`, `graphNode`) by inspecting the ancestor
stack — those bodies don't execute during the outer initializer
evaluation. When a `variableName` is the base of a property-access
valueAccess, the member form supersedes its standalone yield so
`bar.barStatic` doesn't produce a duplicate `bar` ref.

## Topological sort (`lib/compiler/topSortInitGraph.ts`)

Kahn's algorithm over the reversed adjacency. The ready bag is
sorted by each node's `sequenceHint` between iterations so the
output is deterministic and matches source order whenever edges
don't force a different choice.

`sequenceHint = fileImportDepth * 1e6 + sourceLine`. File-import
depth is computed by a separate Kahn pass over the file-import DAG,
where leaves (no imports) get depth 0 and importers get higher
values. The result is one numeric ordering key that combines two
intuitions: "init upstream modules first" + "within a module, follow
source order."

### Cycle reporting

If `kahn`'s output is shorter than the node count, the graph has a
cycle. `traceCycleFrom` walks the remaining `inDegree > 0` nodes,
following deps that still have nonzero in-degree, until it revisits
a node. That revisit closes the loop. The result is rendered by
`formatCycleError` in `compileClosure.ts` as:

```
Error: Circular static dependency
  foo.fooStatic (foo.agency:1) depends on bar.barStatic
  bar.barStatic (bar.agency:2) depends on foo.fooStatic
Static vars cannot depend on each other in a cycle. Break the cycle
by extracting one into a third file or computing from a literal.
```

## ModuleInitPlan + per-module codegen

`buildPlans` projects the closure-wide topsort into a
`ModuleInitPlan` per module:

```typescript
type ModuleInitPhasePlan = {
  localOrder: string[];      // local var names in topsort order
  awaitModules: string[];    // other modules whose init must run first
};

type ModuleInitPlan = {
  moduleId: string;
  static: ModuleInitPhasePlan;
  global: ModuleInitPhasePlan;
};
```

`localOrder` includes only **named** local decls. Synthetic
`__bareStmt_` nodes are intentionally omitted: the section assembler
emits bare statements inline at their source position. But bare
nodes **do** contribute their out-edges to `awaitModules`. A bare
`show(helper.helperGlobal)` needs `helper.agency`'s globals init awaited
before it runs, same as any named decl that references an imported
global.

`globalPhasePlanFor` additionally scans all this module's global
nodes for cross-module **static** refs (the cross-phase case) and
adds those source modules to the global plan's `awaitModules`.

## Section assembler (`lib/backends/typescriptBuilder/sectionAssembler.ts`)

### `partitionProgram` + `reorderTagged`

`partitionProgram` walks the program once and routes each top-level
node into one of:

  - `staticInitStatements` — frozen assignments for static consts
  - `globalInitStatements` — `__ctx.globals.set(...)` calls and
    bare top-level expressions/calls
  - `topLevelStatements` — top-level declarations (functions,
    graphNodes, classes, type aliases)
  - `topLevelCallbackStatements` — `callback(name, fn)` calls. They
    go into `__registerTopLevelCallbacks`, which the runtime re-runs on
    every fresh run, every resume, and every rewind.

Each init statement is tagged with its `varName` (`null` for bare
statements). After partitioning, `reorderTagged` applies the
plan's `localOrder`:

  - **Bare slots stay anchored to their source position.** This is
    critical for side-effecting patterns like `foo(); const x =
    fromFoo; bar();`, where `x` must snapshot AFTER `foo()` has run, not
    before.
  - **Named slots are filled in plan order.** The k-th name in
    `localOrder` fills the k-th named slot encountered in source
    order.

### `buildStaticVarSetup` / `buildInitializeGlobalsFn`

Each builds one of the two init functions. The shape of
`__initializeStatic`:

```typescript
// Init plan (static phase):
//   awaits (cross-module): foo/bar.agency, foo/baz.agency
//   local order:           composed → derived
async function __initializeStatic(__ctx) {
  if (__staticInitPromise) return __staticInitPromise;
  __staticInitPromise = (async () => {
    await __awaitStaticInit("foo/bar.agency", __ctx);
    await __awaitStaticInit("foo/baz.agency", __ctx);
    // ...local statements in localOrder...
  })();
  return __staticInitPromise;
}
```

The banner comment is generated by `buildInitBanner` and surfaces
the plan in two human-readable lines. Skipped when both lists are
empty so trivial modules stay quiet.

`__initializeGlobals` has a similar shape. Its body starts with a
per-execCtx idempotence guard (`if (__ctx.globals.isInitialized(moduleId))
return`) and then `__ctx.globals.markInitialized(moduleId)`. Marking first
prevents infinite recursion when a global initializer calls a function in
the same module. Next comes `await __initializeStatic(__ctx)`, emitted only
when the module has static vars or bare `static` statements, so all of this
module's statics finish before any of its global init runs. Then come the
`await __awaitGlobalsInit(...)` calls from the plan, and finally the global
init statements.

`__registerTopLevelCallbacks` is emitted alongside them, always, even when
empty, so every module has a registry entry.

### Promise-based guard

`__staticInitPromise` is the once-per-process latch. The first
caller into `__initializeStatic` populates the promise; concurrent
callers `await` the same promise. This protects against the case
where two import chains both fan in to the same upstream module. Its init
runs at most once.

### cwd-relative paths in the registry strings

All four registry-touching string literals (`__registerStaticInit`,
`__registerGlobalsInit`, `__awaitStaticInit`, `__awaitGlobalsInit`)
flow through `displayModuleId(absPath)`, which rewrites absolute
paths to cwd-relative for readability. The register and await
sites use the same helper so the registry keys still match exactly
within a single compilation pass. Once the literals are baked in,
the value of `process.cwd()` at runtime is irrelevant.

## Runtime registry (`lib/runtime/crossModuleInitRegistry.ts`)

The runtime side is small. Three registries keyed by moduleId
(`staticInits`, `globalsInits`, `callbackInits`), plus these functions:

  - `__registerStaticInit(moduleId, fn)`, called at JS-load time
    by every compiled module immediately after declaring
    `__initializeStatic`.
  - `__registerGlobalsInit(moduleId, fn)`, the same for
    `__initializeGlobals`.
  - `__registerCallbacksInit(moduleId, fn)`, the same for
    `__registerTopLevelCallbacks`.
  - `__awaitStaticInit(moduleId, ctx)`, called from inside other
    modules' `__initializeStatic` bodies through the plan's
    `awaitModules`. It returns immediately if the module isn't
    registered.
  - `__awaitGlobalsInit(moduleId, ctx)`, the same for globals.
  - `__initAllRegistered(ctx)`, the closure-wide bootstrap. `runNode`
    calls it on every fresh run, before the entry module's own globals
    init. It walks the `globalsInits` registry and runs each module's
    `__initializeGlobals`, skipping modules already initialized on this
    execCtx. It exists because the dep graph only sees references in
    initializer expressions. A static read from inside a function body
    produces no edge, so a dependency the entry never names in an
    initializer would otherwise never be initialized.
    Phase A is driven through `__initializeGlobals` rather than
    `__initializeStatic` on purpose: `markInitialized` has to run before
    the static-init IIFE starts, or the per-function lazy prelude
    re-enters `__initializeGlobals` and awaits a still-pending promise.
  - `__initAllRegisteredCallbacks(ctx)`, which clears
    `ctx.topLevelCallbacks` once and then runs every registered module's
    `__registerTopLevelCallbacks`. The fresh-run, resume, and rewind
    paths all call it. The reset lives here, not in the per-module
    function, so one module's registration never clobbers another's.

Cycle safety at runtime: ES module load order matches the
file-import DAG (JS-level imports are added by codegen), so by the
time any init function runs (which only happens during agent
execution, well after all modules have loaded), every module's
registration has already completed. Compile-time topsort guarantees
no var-level cycles inside the init graph, so the await chain
always terminates.

## Bare top-level statements

A bare statement at module top level gets a synthetic
`__bareStmt_${line}_${col}` node. The name uses both line and column
because `foo(); bar()` on one source line would otherwise collide. The
node lands in the **global** graph, unless the source wrote
`static <statement>`, which puts it in the **static** graph instead. It
participates in the dep graph like any other node of its phase:

  - Their initializer expression is the statement itself; the
    free-identifier walk treats them like any other initializer.
  - They contribute out-edges (and so cross-module awaits) but
    **never appear in `localOrder`** — the section assembler emits
    them inline at their source position via `reorderTagged`.

The two correctness rules that intersect bare statements:

  1. **Interleave with named decls by source position**
     (`reorderTagged`). Anchor bares; fill named slots from
     `localOrder`. This is what makes `foo(); const x = ...; bar();`
     preserve the user's side-effect ordering.
  2. **Contribute cross-module edges** (`phasePlanFor`). Bare nodes
     are kept out of `localOrder` but their out-edges still count
     toward `awaitModules`.

## Re-export chains

Re-exports are expanded by `resolveReExports` (a preprocessor)
before the dep graph is built. For each re-export like
`export { x } from "./helper.agency"`, a wrapper static
`static const x = _reexport_x` is synthesized in the re-exporter's
program. The dep graph then sees the wrapper as a regular static
that depends on the source module's `x`, which produces the
familiar one-hop edge chain.

`compileClosure.parseClosure` does this expansion per file AFTER
the closure walk (the closure walk uses raw imports including
`exportFromStatement` to know which files to pull in; expansion
strips those nodes). The unit-test helper `writeFixture` in
`initDepGraph.test.ts` mirrors the same two-step pattern so tests
match production behavior.

## Read-before-init trap: the safety net

The dep graph orders **values**, not **callable code**. Depth-1
function-body expansion means one-hop function calls do contribute edges.
Anything beyond that boundary produces no edge: depth-2 and deeper call
chains, function values stored in variables, methods on user objects, and
stdlib functions.

The runtime read-before-init trap, `__readStatic`, catches this case. Every static read in generated code is wrapped in
`__readStatic(value, name, sourceModuleId)`. If the value is still
the `__UNINIT_STATIC` sentinel, the trap throws with a helpful
message pointing at the source module of the unset static. The
test suite exercises this in
`lib/runtime/topsortCycleErrors.test.ts` (the `runtime-trap`
fixture, deliberately written with a two-hop chain so depth-1
analysis can't see it).

## Multi-entry compile cache

`BuildSession` in `lib/compiler/buildSession.ts` caches one
`CompiledClosure` per session and reuses it across entry files in a single
CLI invocation. `ensureCompiledClosure` keeps the cached closure when it
already covers the new entry, so a file two entries share is parsed and
topsorted once. It rebuilds when the entry is not in the closure's
`programs`, and it skips closure building entirely for stdlib entries,
whose imports are structured differently. This is a known place for past
bugs.

## Testing

  - **Unit tests** for the dep graph live in
    [`lib/compiler/initDepGraph.test.ts`](../../../lib/compiler/initDepGraph.test.ts).
    Use the `writeFixture` helper — it mirrors production's
    `resolveReExports`-per-file step.
  - **Topsort tests** for cycles + ordering live in
    [`lib/compiler/topSortInitGraph.test.ts`](../../../lib/compiler/topSortInitGraph.test.ts).
  - **End-to-end success cases** are agency fixtures under
    `tests/agency/topsort/` (run via `pnpm run agency test
    tests/agency/topsort/`).
  - **Compile-error + runtime-trap fixtures** live under
    `tests/agency/topsort/cycles/` and are driven by the vitest
    runner in
    [`lib/runtime/topsortCycleErrors.test.ts`](../../../lib/runtime/topsortCycleErrors.test.ts) —
    The agency test framework has no "expected compile error"
    assertion, so these go through vitest's interception of
    `process.exit` and `console.error`.
  - **Plan-driven assertions** live in
    [`lib/compiler/compileClosure.test.ts`](../../../lib/compiler/compileClosure.test.ts).
    Add a test here whenever you change `phasePlanFor` /
    `globalPhasePlanFor` to assert on `c.plans[moduleId].static`
    or `.global` directly.

When debugging init order issues, the banner comment at the top of
the generated `__initializeStatic` / `__initializeGlobals` is the
fastest way to see what the planner decided without re-deriving
from the body. Use `pnpm run compile --ts file.agency` to inspect the
generated `.ts`. The `.js` output runs through esbuild, which strips the
comments.

## File map

| File | Purpose |
| --- | --- |
| `lib/compiler/initDepGraph.ts` | Build per-variable graphs from parsed programs. `FreeRef` + `ImportAliasResolver` + `FunctionDefLookup` (depth-1 expansion). |
| `lib/compiler/topSortInitGraph.ts` | Kahn's + cycle tracing. One ordering key (`sequenceHint`). |
| `lib/compiler/compileClosure.ts` | One-stop entry: parse closure → graphs → topsort → per-module `ModuleInitPlan`. |
| `lib/backends/typescriptGenerator.ts` | Projects `CompiledClosure` to `InitPlanForModule` for one file. |
| `lib/backends/typescriptBuilder/sectionAssembler.ts` | `partitionProgram`, `reorderTagged`, `buildStaticVarSetup`, `buildInitializeGlobalsFn`, `displayModuleId`, banner. |
| `lib/backends/typescriptBuilder.ts` | Orchestrates per-module codegen; passes the plan into the section assembler. |
| `lib/runtime/crossModuleInitRegistry.ts` | Process-global registry of per-module init functions. Register + await. |
| `lib/preprocessors/resolveReExports.ts` | Synthesizes wrapper statics so re-export chains show up in the dep graph. |
