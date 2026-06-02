# PR 2 — Per-variable topological sort + centralized init

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace per-module lazy `__initializeStatic` / `__initializeGlobals` with a centralized, topologically-sorted init across the full import closure. Eliminates cross-module init-order bugs at compile time.

**Architecture:** At compile time, walk the entry module's full import closure (following both `import` and `export ... from` re-exports). Build TWO independent per-variable dep graphs — one for `static` decls (Phase A, once per process) and one for non-static `const`/`let` + bare top-level statements (Phase B, every run). Edges in each graph come from direct free-variable references in the initializer expression. Topologically sort each graph independently (using a precomputed `sequenceHint` per node to break ties deterministically — file-import depth, then source line). Emit a single `__initializeAllStatics(ctx)` + `__initializeAllGlobals(ctx)` per compilation that walks the corresponding sorted list. Compile-time error on cycles in either variable graph (with offending decls named). Compile-time error if a `static` initializer references a `global` (the global doesn't exist yet at Phase A). Lazy `isInitialized` guards stay as safety net.

**Why two graphs instead of one:**
- Phase A and Phase B have different lifetimes, run on different schedules, and have different visibility rules. Combining them obscures both.
- Globals reading statics is fine (statics are already initialized at Phase B time) — this is a one-way *cross-phase* allowance, not a cross-graph edge.
- Statics reading globals is a compile-time error — caught by a dedicated validation pass over the static graph's free-variable references.
- (Out of scope for PR 2; a separate follow-up PR owns the static-initializer-restriction work end-to-end. PR 2 implements the static→global rejection in the validation pass because the dep graph already has the information sitting there.)

**Design principles for this PR (explicit because the first cut violated them):**
- **Reuse, don't reimplement.** AST traversal goes through `walkNodes` from `lib/utils/node.ts`. Import resolution goes through `SymbolTable.resolveImport`. Closure walking is owned by the compile entry point and passed in as data.
- **Closed interfaces.** The dep graph exposes `nodes + edges` only — file-import ordering is baked into each node's `sequenceHint` at build time, so consumers see one ordering rule, not two.
- **Declarative pipelines, encapsulated imperative code.** Compile flow is `parse → SymbolTable → CompilationUnits → InitPlan → codegen`. Each arrow is one function; the imperative work lives inside.
- **One ADT for the cross-task contract.** `InitPlan` (per-module ordered list of typed `InitStep` items) is what flows between Tasks 3 and 4. Codegen dispatches on `step.kind`; no other coupling.

**Tech Stack:** TypeScript compiler analysis pass, TS codegen, runtime entry-point wiring.

**Scope:**
- IN: full closure walk including re-exports (`export { x } from "y"`)
- IN: per-variable dep graph + topsort + cycle error
- IN: centralized init functions emitted in every compiled file (so any node can be an entry point)
- IN: integration tests reproducing all 8 worked examples from the design doc
- IN: cherry-pick reusable fixtures from PR 237's branch where the expected behavior matches our design
- OUT: `static` keyword for bare statements (PR 3)
- OUT: compile-time validations on what's allowed inside static initializers (PR 4)
- OUT: `agency explain-init` CLI (PR 5)

---

## Task 1: Dep graph builder — REFACTOR

**Status:** First cut landed in commit e20d9312. Needs refactor to remove duplicated/leaky pieces before continuing.

**Files:**
- Modify: `lib/compiler/initDepGraph.ts`
- Modify: `lib/compiler/initDepGraph.test.ts` (only as needed; the public API contract below is mostly compatible)

- [ ] Extract a single `ImportAliasResolver` interface owned by this module:
  - Built once from `(symbolTable, programs)`; exposes `resolve(localName, inModuleId) → { sourceModuleId, sourceName } | null`.
  - Internally: calls `SymbolTable.resolveImport` for each `importStatement`, then follows `reExportedFrom` chains to the ultimate source.
  - **This same resolver is reused by the PR-1 thread-through fix in Task 4.** No second implementation lives at the codegen wrap site.
- [ ] Replace the hand-rolled `collectFreeIdentifiers` (currently ~85 lines of switch + generic fallback) with a `walkNodes`-based filter:
  - Walk the initializer; collect every `variableName` node; skip subtrees rooted at name-binding constructs (`function`, `graphNode`) using the `ancestors` argument that `walkNodes` already provides.
  - Net result: ~15 lines, no fallback, no duplicated traversal logic.
- [ ] Stop walking the import closure inside the dep graph. The entry point (Task 3) collects all reachable programs and passes them in. `buildInitDepGraphs` becomes pure: `(programs, symbolTable, entryModuleId) → { staticGraph, globalGraph }` where `programs` is already the full closure.
- [ ] **Build two independent graphs**, one per phase. A node belongs to the static graph iff `node.static === true` (the parser flag — pre-codegen, so `scope` is not yet set). All other top-level assignments + bare statements go to the global graph. Same `InitVarNode` shape; just different graph membership.
- [ ] Add bare top-level statements (function calls, etc.) as nodes in the **global graph only** (statics can't have side-effecty bare statements until PR 3's `static` keyword work). Bare-statement nodes carry no outgoing edges (we can't statically see what functions touch); their `sequenceHint` keeps source-order behavior. Use a synthetic `varName` like `__bareStmt_${moduleId}_${line}` so the key stays unique.
- [ ] Add a validator: walk each static-graph node's initializer free vars; if any resolve (locally or via import) to a global-graph node, throw a `StaticReferencesGlobalError` listing the offending pair. This is the static→global compile error.
- [ ] Bake the file-import-depth tiebreaker into each node at build time. Each `InitVarNode` gets a `sequenceHint: number` computed from `(fileImportDepth, sourceLine)`. **Remove the `fileImports` field from `InitDepGraph`** — the topsort no longer needs it. One ordering mechanism, one consumer.
- [ ] Re-verify all 7 existing unit tests pass (after renaming `buildInitDepGraph` → `buildInitDepGraphs`); add tests:
  - `sequenceHint` orders Example-2 case correctly
  - Two separate graphs returned; a static var and a global var with the same name don't collide
  - Static referencing a global throws `StaticReferencesGlobalError`
  - Global referencing a static is allowed (cross-phase, no edge)
  - Bare top-level statement appears in global graph, source-order preserved relative to other globals
  - Module-reference outside the closure produces no edge and doesn't crash
  - AST visitor catches references inside: string interpolation, array/object spreads, `new X()` args, splat call args
- [ ] Commit.

**Final shape:**
```ts
type InitVarNode = {
  moduleId: string; varName: string; kind: "static" | "global";
  // For bare statements: kind="global", initExpr is the wrapping expr-statement node.
  initExpr: Expression | AgencyNode;
  loc?: SourceLocation; exported: boolean;
  sequenceHint: number;  // (fileImportDepth, sourceLine) packed into one number
  // Optional `with approve` modifier from the parser. `handle { ... }` blocks
  // are NOT legal at module top level — only `with approve` is — so a single
  // optional field captures the full surface area.
  withApprove?: boolean;
};
type InitDepGraph = {
  nodes: Record<InitVarKey, InitVarNode>;
  edges: Record<InitVarKey, InitVarKey[]>;
};
type BuildResult = { staticGraph: InitDepGraph; globalGraph: InitDepGraph };
```

---

## Task 2: Topological sort + cycle detection — REFACTOR

**Status:** First cut landed in commit 6af7dd97. Needs refactor in lockstep with Task 1's changes.

**Files:**
- Modify: `lib/compiler/topSortInitGraph.ts`
- Modify: `lib/compiler/topSortInitGraph.test.ts`

- [ ] Delete `computeFileImportOrder` and its supporting helpers. Ordering is now read directly from `node.sequenceHint`.
- [ ] Reshape `topSortInitGraph` as `kahn(nodes, edges, keyFn)` where `keyFn(node) = node.sequenceHint`. Single ordering rule, same function called once per graph (static + global).
- [ ] Replace the bespoke `insertSorted` with `ready.sort(byHint)` per round — N is small (top-level vars across the closure); the readability win is worth more than the asymptotic cost.
- [ ] Keep `findCycle` as the cycle reporter, but extract it into a small `traceCycleFrom(graph, start)` helper that's purely declarative ("walk one edge at a time until we revisit a node; return the loop slice").
- [ ] All 6 existing tests still pass; update the file-import-tiebreak test to assert on `sequenceHint` plumbing rather than a separate map. Add tests:
  - A 3-var cycle: cycle path lists all 3 in order
  - Cycle message includes module path + line for each decl (assertion on message string, not just on "throws")
  - Same graph topsorted twice yields the same order (determinism — no Map iteration order leak)
  - Disconnected components are both fully ordered
- [ ] Commit.

---

## Task 3: Compile-flow integration — `CompiledClosure` + `InitPlan`

**Files:**
- Create: `lib/compiler/compiledClosure.ts`
- Create: `lib/compiler/initPlan.ts`
- Modify: `lib/cli/commands.ts` (delegate)
- Modify: `lib/compiler/compile.ts` (delegate)

- [ ] Introduce `compileClosure(entryFile, config) → CompiledClosure` as the single owner of multi-file compilation:
  - Parses every reachable agency file once (BFS over imports + re-exports). Builds one shared `SymbolTable`.
  - **Parse failures: abort via `process.exit(1)` matching today's `lib/cli/commands.ts` behavior. `lib/compiler/compile.ts` (in-memory entry) instead returns a `CompileFailure` per its existing contract.**
  - Runs `buildInitDepGraphs` (two graphs) + `topSortInitGraph` on each.
  - On `CycleError` (either graph): throw a `CompileError` naming the phase ("Phase A (static)" / "Phase B (global)") and listing the decl pair/cycle.
  - On `StaticReferencesGlobalError`: throw a `CompileError` naming the offending pair.
  - Builds per-module `CompilationUnit`s.
  - Produces an `InitPlan` per module from the two sorted orders (see ADT below).
  - Returns `{ programs, symbolTable, units, plans, sourceMaps, resolver }` — a fully prepared bundle that codegen consumes. `resolver` is the `ImportAliasResolver` from Task 1, exposed so the codegen wrap site can use it for the PR-1 thread-through.
- [ ] Both `lib/cli/commands.ts:compile()` and `lib/compiler/compile.ts:compileSource()` become thin wrappers: call `compileClosure`, then iterate units and call `generateTypeScript(unit, plan, resolver)` for each. No more recursive `compile()` calls.
- [ ] Cycle error message (verbatim shape):
  ```
  Error: Circular static dependency
    foo.fooStatic (foo.agency:2) depends on bar.barStatic
    bar.barStatic (bar.agency:2) depends on foo.fooStatic
  Static vars cannot depend on each other in a cycle. Break the cycle by
  extracting one into a third file or computing from a literal.
  ```
  (Same shape for global-graph cycles; just swap "static" for "global".)
- [ ] `InitPlan` ADT (the only thing flowing between Task 3 and Task 4):
  ```ts
  type InitStep =
    | { kind: "localStatic"; varName: string; initExpr: Expression; exported: boolean; loc?: SourceLocation; withApprove?: boolean }
    | { kind: "localGlobal"; varName: string; initExpr: Expression; loc?: SourceLocation; withApprove?: boolean }
    | { kind: "importedAlias"; localName: string; sourceModuleId: string; sourceName: string }
    | { kind: "bareStatement"; statement: AgencyNode; withApprove?: boolean };
  type InitPlan = { moduleId: string; staticSteps: InitStep[]; globalSteps: InitStep[] };
  ```
  Note: `withApprove` covers the only top-level handler form (`with approve`). Block-form `handle { ... }` is not legal at module top level, so no other handler-shape needs representation.
- [ ] Tests:
  - `compileClosure` on a 3-file fixture returns one program per file and a plan per module.
  - Static-cycle fixture throws `CompileError` with the formatted message (assert on message string).
  - Global-cycle fixture throws `CompileError` naming Phase B.
  - Static-references-global fixture throws `CompileError` naming both decls.
  - A file with a syntax error inside the closure causes `compileClosure` to abort with exit code 1 (verified via spawning the CLI in a subprocess — direct `process.exit` makes in-process testing of the CLI path painful; `compileSource` test path returns the failure).
  - Re-export resolution: 2-file fixture where `foo` re-exports `bar`'s static; the plan in `foo` shows it as `importedAlias`, NOT `localStatic`.
- [ ] Commit.

---

## Task 4: Codegen — driven by `InitPlan`

**Files:**
- Modify: `lib/backends/typescriptBuilder/sectionAssembler.ts`
- Modify: `lib/backends/typescriptBuilder.ts`

- [ ] `partitionProgram` no longer extracts static/global init statements itself. It still classifies top-level declarations (functions, graph nodes, callbacks) but the static/global init bodies come from the `InitPlan` passed in by Task 3.
- [ ] Add a single `emitInitStep(step: InitStep) → TsNode` dispatch table:
  - `localStatic` → `X = __deepFreeze(<expr>)`, wrapped in `withApprove` handler arrow if set
  - `localGlobal` → `__ctx.globals.set(moduleId, name, value)`, similar handler wrap
  - `importedAlias` → emit a top-level TS `export { sourceName as localName } from "./sourceModule.js"` — handled at module-init time by JS module resolution, NOT by the init function body. (Alternative considered: runtime alias via `globals.set`; rejected because the source binding is already initialized by the source module's `__initializeAllStatics` so we'd double-init.)
  - `bareStatement` → the already-processed statement, optionally wrapped in `with approve`
- [ ] `buildInitializeAllStaticsFn` and `buildInitializeAllGlobalsFn` are each `plan.{staticSteps,globalSteps}.filter(non-import).map(emitInitStep)` wrapped in the `__staticInitPromise` memoization shell (kept from current code). `importedAlias` steps lift to top-level `export ... from` statements before either init function. One emit path per phase; no branching at call sites.
- [ ] Per-function `isInitialized` lazy guards stay as the safety net (no change).
- [ ] **PR-1 thread-through:** the wrap site at `lib/backends/typescriptBuilder.ts:780-788` calls `ImportAliasResolver.resolve(name, currentModuleId)` and threads the resulting `sourceModuleId` to `__readStatic`. No new field on `CompilationUnit`; the resolver from Task 1 is the single source of truth.
- [ ] Regenerate fixtures: `make fixtures` then `pnpm test:run lib/backends/typescriptGenerator.integration.test.ts` (save output to `/tmp/codegen-fixtures.log` first). Review diff.
- [ ] Tests added in this task:
  - Unit test for `emitInitStep`: each of the 4 step kinds maps to the expected TsNode shape. `withApprove` adds the handler wrap.
  - Integration test: PR-1 trap message now contains the source moduleId (asserts `"barStatic" from "bar.agency"` substring, NOT `<unknown module>`).
  - Integration test: a re-export chain compiles to `export ... from` — assert the generated JS contains the re-export, not a duplicate `__deepFreeze` of the same value.
- [ ] Commit.

---

## Task 5: Integration tests — the 8 worked examples

**Files:**
- Create: `lib/runtime/initPlanWorkedExamples.test.ts` (one file, 8 cases)
- Create: `lib/runtime/testHelpers/runAgencyClosure.ts`

- [ ] Extract a single declarative test helper (used by Tasks 5, 6, 7):
  ```ts
  runAgencyClosure({ files: Record<relPath, content>, entry: relPath, expectFail?: RegExp }) → Promise<string>
  ```
  - Writes files to a temp dir under `.agency-tmp/`.
  - Compiles via `compileClosure`.
  - Imports the entry's compiled JS (`pathToFileURL` for Windows).
  - Runs the entry node, returns captured stdout (or rejects with the matching error).
  - Cleans up in caller's `afterEach`.
- [ ] Each of the 8 examples becomes a 5–10 line `it(...)`:
  - Example 1: silent undefined → prints "hello!"
  - Example 2: `getBarStatic()` indirection → works via sequenceHint
  - Example 3: indirect dep across cycle → PR-1 trap fires (assert message includes the SOURCE moduleId, not "<unknown>")
  - Example 4: router/code/research → compiles and runs
  - Example 5: direct state cycle → compile error (assert formatted message)
  - Example 6: bare top-level call timing (pre-`static`-keyword behavior) — assert call ordering matches source order
  - Example 7: `const _ = ...` → normal global
  - Example 8: concurrent web-server requests → still works (5 parallel calls; each sees its own globals)
- [ ] **Additional load-bearing tests** (each is one `it(...)` using the helper):
  - **Multi-entry-point:** import `bar.agency` as the entry, not `foo.agency`; centralized init still runs correctly. Asserts the "emitted in every compiled file" property.
  - **Cross-module globals reading statics:** `global X = importedStatic` works (this is the allowed cross-phase direction).
  - **Static memoization under concurrency:** spawn 5 parallel calls to a node; assert the static initializer body ran exactly once (counter sentinel inside a static IIFE).
  - **Handler-wrapped static (`with approve`):** `static const x = sensitive() with approve` — assert approval handler fires once, x is set.
  - **AST-visitor edge cases that produced edges correctly:** static initializer references inside template-string interpolation, array spread, object spread, `new X()` args, splat call args. One test per case asserting the right init order.
  - **Module-reference outside closure:** a static references a name not in any reachable module → should compile (typechecker handles undefined names; dep graph must not crash) and produce a separate compile-time error from the typechecker, not a graph crash.
- [ ] Commit fixtures + helper + tests.

---

## Task 6: Re-export chain test

**Files:**
- Add a single `it(...)` to `lib/runtime/initPlanWorkedExamples.test.ts` using the helper from Task 5.

- [ ] 3-level chain (`a` re-exports from `b`, `b` re-exports from `c`); another module's static reads through the chain; assert correct value. Dep-graph machinery already handles this via the resolver — the test confirms the end-to-end wiring.
- [ ] Commit.

---

## Task 7: Performance smoke test

**Files:**
- `lib/compiler/topSortInitGraph.test.ts` (one perf case)

- [ ] Generated input: 50 modules with ~3 static vars each, randomized acyclic deps. Build graph + topsort. Assert wall-clock < 100ms.
- [ ] Commit.

---

## Pre-PR checklist

- [ ] Tasks 1+2 refactor commits keep all original unit tests passing
- [ ] All 8 worked-example integration tests + re-export chain test pass via the shared helper
- [ ] Regenerated typescriptGenerator fixtures look right (diff reviewed)
- [ ] No regressions in existing unit tests
- [ ] PR description references design doc, notes PR 2 of 6, calls out: built on PR 1's runtime trap; resolver introduced here also powers PR-1 thread-through fix
