# Init Topological Sort and Centralized Init

## Overview

Agency files have top-level `static const`, `const`/`let`, and bare
statements that need to run before any node executes. When a module
imports values from other modules, those upstream modules' inits must
complete first. Get the order wrong and a static initializer reads a
sentinel and trips the runtime read-before-init trap (PR 1); or a
bare statement runs against a global the importer hasn't yet
populated.

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
and why is it async" rationale, see [`init.md`](init.md). This doc is
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
    module in the closure. Drives `__initializeStatic`, which runs
    once per process per module.
  - **globalGraph** — one node per non-static `const` / `let` and
    one synthetic node per bare top-level statement (`functionCall`,
    `interruptStatement`). Drives `__initializeGlobals`, which runs
    once per agent execution per module.

A node looks like:

```typescript
type InitVarNode = {
  moduleId: string;                  // absolute source path
  varName: string;                   // user-visible name, or
                                     // `__bareStmt_${moduleId}_${line}`
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

**Functions are never edges.** Only values participate. A static
initializer that calls a function defined elsewhere produces no edge
to that function's locals; the runtime trap (PR 1) is the safety
net for unset statics read indirectly.

### Cross-phase rules

Two graphs are kept independent so each can be cycle-checked on its
own. The cross-phase rules are enforced separately:

  - **static → global is a compile error.** A `static const`
    initializer that references a `global` cannot be satisfied at
    Phase A time (globals don't exist yet). Surfaced as
    `StaticReferencesGlobalError` in `rejectStaticReferencesGlobal`.
  - **global → static is allowed.** All statics finish initializing
    before any global init runs (`buildInitializeGlobalsFn` emits
    `await __initializeStatic(__ctx)` at the top of the global init
    body). The dep graph drops the cross-phase ref as an edge but
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
a node — that closes the loop. The result is rendered by
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
nodes **do** contribute their out-edges to `awaitModules` — a bare
`show(helper.helperGlobal)` needs `helper.agency`'s globals init
awaited before it runs, same as any named decl that references an
imported global.

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
  - `topLevelCallbackStatements` — `callback(name, fn)` calls,
    re-registered on every fresh run AND every resume

Each init statement is tagged with its `varName` (`null` for bare
statements). After partitioning, `reorderTagged` applies the
plan's `localOrder`:

  - **Bare slots stay anchored to their source position.** This is
    critical for side-effecting patterns like `foo(); const x =
    fromFoo; bar();` — `x` must snapshot AFTER `foo()` has run, not
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

`__initializeGlobals` has the same shape, with an additional
`await __initializeStatic(__ctx)` at the top so all statics finish
before any global init runs.

### Promise-based guard

`__staticInitPromise` is the once-per-process latch. The first
caller into `__initializeStatic` populates the promise; concurrent
callers `await` the same promise. This protects against the case
where two import chains both fan in to the same upstream module —
its init runs at most once.

### cwd-relative paths in the registry strings

All four registry-touching string literals (`__registerStaticInit`,
`__registerGlobalsInit`, `__awaitStaticInit`, `__awaitGlobalsInit`)
flow through `displayModuleId(absPath)`, which rewrites absolute
paths to cwd-relative for readability. The register and await
sites use the same helper so the registry keys still match exactly
within a single compilation pass. Once the literals are baked in,
the value of `process.cwd()` at runtime is irrelevant.

## Runtime registry (`lib/runtime/crossModuleInitRegistry.ts`)

The runtime side is small. Two registries (`staticInits`,
`globalsInits`) keyed by moduleId, plus four functions:

  - `__registerStaticInit(moduleId, fn)` — called at JS-load time
    by every compiled module immediately after declaring
    `__initializeStatic`.
  - `__registerGlobalsInit(moduleId, fn)` — same, for
    `__initializeGlobals`.
  - `__awaitStaticInit(moduleId, ctx)` — called from inside other
    modules' `__initializeStatic` bodies (via the plan's
    `awaitModules`). Returns immediately if the module isn't
    registered.
  - `__awaitGlobalsInit(moduleId, ctx)` — same, for globals.

Cycle safety at runtime: ES module load order matches the
file-import DAG (JS-level imports are added by codegen), so by the
time any init function runs (which only happens during agent
execution, well after all modules have loaded), every module's
registration has already completed. Compile-time topsort guarantees
no var-level cycles inside the init graph, so the await chain
always terminates.

## Bare top-level statements

Bare `functionCall` / `interruptStatement` nodes at module top
level get synthetic `__bareStmt_${moduleId}_${line}` nodes in the
**global** graph (statics are decl-only today). They participate
in the dep graph like any other global node:

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

## Read-before-init trap (PR 1) — the safety net

The dep graph orders **values**, not **callable code**. A
static initializer that calls a function which transitively reads
another static produces no edge in the graph, because function
bodies don't execute during outer-initializer evaluation.

The runtime read-before-init trap (`__readStatic`, PR 1) catches
this case. Every static read in generated code is wrapped in
`__readStatic(value, name, sourceModuleId)`. If the value is still
the `__UNINIT_STATIC` sentinel, the trap throws with a helpful
message pointing at the source module of the unset static. The
test suite exercises this in
`lib/runtime/topsortCycleErrors.test.ts` (the `runtime-trap`
fixture).

## Multi-entry compile cache

`lib/cli/commands.ts:compile()` caches the `CompiledClosure` across
entry files in one CLI invocation. When the first entry pulls in a
file the second entry also imports, the cache reuses the parse +
topsort work. The cache key is the entry path; when a later entry
isn't in the cache, the cache rebuilds for that entry's closure (a
known place for past bugs — see PR 2 review commit b9fb4695).

## Testing

  - **Unit tests** for the dep graph live in
    [`lib/compiler/initDepGraph.test.ts`](../../lib/compiler/initDepGraph.test.ts).
    Use the `writeFixture` helper — it mirrors production's
    `resolveReExports`-per-file step.
  - **Topsort tests** for cycles + ordering live in
    [`lib/compiler/topSortInitGraph.test.ts`](../../lib/compiler/topSortInitGraph.test.ts).
  - **End-to-end success cases** are agency fixtures under
    `tests/agency/topsort/` (run via `pnpm run agency test
    tests/agency/topsort/`).
  - **Compile-error + runtime-trap fixtures** live under
    `tests/agency/topsort/cycles/` and are driven by the vitest
    runner in
    [`lib/runtime/topsortCycleErrors.test.ts`](../../lib/runtime/topsortCycleErrors.test.ts) —
    the agency test framework has no "expected compile error"
    assertion, so they go through vitest's
    `process.exit`/`console.error` interception.
  - **Plan-driven assertions** live in
    [`lib/compiler/compileClosure.test.ts`](../../lib/compiler/compileClosure.test.ts).
    Add a test here whenever you change `phasePlanFor` /
    `globalPhasePlanFor` to assert on `c.plans[moduleId].static`
    or `.global` directly.

When debugging init order issues, the banner comment at the top of
the generated `__initializeStatic` / `__initializeGlobals` is the
fastest way to see what the planner decided without re-deriving
from the body. Use `pnpm run compile --ts file.agency` to inspect
the generated `.ts` (the `.js` output runs through esbuild which
strips comments).

## File map

| File | Purpose |
| --- | --- |
| `lib/compiler/initDepGraph.ts` | Build per-variable graphs from parsed programs. `FreeRef` + `ImportAliasResolver`. |
| `lib/compiler/topSortInitGraph.ts` | Kahn's + cycle tracing. One ordering key (`sequenceHint`). |
| `lib/compiler/compileClosure.ts` | One-stop entry: parse closure → graphs → topsort → per-module `ModuleInitPlan`. |
| `lib/backends/typescriptGenerator.ts` | Projects `CompiledClosure` to `InitPlanForModule` for one file. |
| `lib/backends/typescriptBuilder/sectionAssembler.ts` | `partitionProgram`, `reorderTagged`, `buildStaticVarSetup`, `buildInitializeGlobalsFn`, `displayModuleId`, banner. |
| `lib/backends/typescriptBuilder.ts` | Orchestrates per-module codegen; passes the plan into the section assembler. |
| `lib/runtime/crossModuleInitRegistry.ts` | Process-global registry of per-module init functions. Register + await. |
| `lib/preprocessors/resolveReExports.ts` | Synthesizes wrapper statics so re-export chains show up in the dep graph. |
