# Callback Lifting + Resume Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite every `callback("onX") as data { ... body ... }` into a synthesized top-level `def __cb_<scope>_<n>(data: any) { ... body ... }` + a `callback("onX", __cb_<scope>_<n>)` call, *as an AST-to-AST preprocessor before typecheck*. Reserve the name `callback`. Split top-level callback registration into a re-runnable phase so top-level callbacks survive resume too.

**Architecture:** The lifting runs in a new preprocessor (`lib/preprocessors/liftCallbacks.ts`), modelled on `lib/preprocessors/parallelDesugar.ts`. It runs between `resolveImports` and `buildCompilationUnit` in `lib/compiler/compile.ts`, so:

- The compilation unit picks up the lifted `def`s naturally in `info.functionDefinitions`.
- The typechecker walks the lifted bodies as if they were ordinary functions — **free-identifier captures of enclosing locals become normal "Variable 'x' is not defined" diagnostics from `undefinedVariableDiagnostic.ts`**, with source locations preserved from the original `.agency` file.
- The codegen (`typescriptBuilder.ts`) sees only the named-fn form `callback("onX", __cb_xxx)` — no block-form to special-case, no inline `__AgencyFunction.create({ fn: async … })` closures over `__ctx`.
- Scoped callbacks survive resume because `fn` is now a registered AgencyFunction (registered via the normal `__registerTool` path for user `def`s); serialize/revive works via the existing `nativeTypeReplacer`/`nativeTypeReviver`.
- Top-level callbacks survive resume via a small runtime change: split `__initializeGlobals` into the gated globals init + a re-runnable `__registerTopLevelCallbacks(__ctx)` that fires on every `runNode` / `respondToInterrupts` entry.

### Why preprocessor (vs codegen-level lifting)

Earlier drafts of this plan did the lifting inside `processBlockArgument` in [`typescriptBuilder.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptBuilder.ts#L1197). The preprocessor approach is materially simpler:

| Concern | Codegen-level lifting | Preprocessor lifting |
|---|---|---|
| `processBlockArgument` change | +30 lines, new `callback`-specific branch | none |
| New `agencyFunctionDecl` IR builder | needed | none — uses existing `function` AST path |
| `liftedCallbacks` instance state on `TypeScriptBuilder` | needed | none |
| Module-level emit position | careful ordering vs `__initializeGlobals` | natural — lifted defs are just normal top-level `def`s |
| Capture check | requires a custom typechecker pass OR accepts ugly JS-level errors | **automatic** via existing `undefinedVariableDiagnostic` |
| Source locations for capture errors | poor (point at generated `.ts`) | **good** (point at original `.agency` source) |
| Codegen complexity | grows; new special-case for `callback` | unchanged |

Net: similar code volume, **but cleaner separation** — the codegen stays callback-agnostic; the typechecker's existing infrastructure does the capture check for free.

### Is this the right approach (vs. dropping resume support)?

The single thing that makes any version of this plan non-trivial is **preserving callbacks across interrupt + resume**. Alternative: document "callbacks fire only within their original execution" and ship as-is — then Tasks 2, 4, 5 all collapse and the work reduces to Task 1 + stdlib dedup (≈1 hour).

Cost of that alternative: surprising UX. A user wires top-level `callback("onLLMCallEnd") as data { log(data) }` for observability, the agent pauses on a human-approval interrupt, and after approval the logging silently stops working. For dev-mode tracing this is mild; for production observability it's painful.

**Decision: implement resume support via preprocessor lifting.** It's the cleanest design and we already shipped 10 callback tests committing to the behavior.

**Tech Stack:** preprocessor (`lib/preprocessors/liftCallbacks.ts` — new), pipeline (`lib/compiler/compile.ts`), runtime (`lib/runtime/node.ts`, `lib/runtime/interrupts.ts`, `lib/runtime/state/stateStack.ts`), section assembly for the top-level partition (`lib/backends/typescriptBuilder/sectionAssembler.ts`), reserved-name list (`lib/typeChecker/resolveCall.ts`), test harness (vitest + `tests/agency/*.agency` execution tests).

---

## Background & Context

### Why this work exists

PR #180 added scoped + top-level callbacks (`callback("onX") as data { ... }` inside any function or at the module top-level). It works for fresh runs, but **callbacks do not survive resume across interrupts**:

1. **Top-level callbacks vanish on resume.** They're registered inside `__initializeGlobals(__ctx)`, which is gated by `__ctx.globals.isInitialized(moduleId)`. After resume, `globals` is restored from JSON and `isInitialized` comes back `true`, so `__initializeGlobals` is skipped. The new `execCtx` is created with an empty `topLevelCallbacks` array. The test that documents this is `tests/agency/callback-resume.agency` (committed in the previous PR, intentionally failing).

2. **Scoped callbacks crash on resume.** They serialize the `fn` reference via `State.toJSON`, but `fn` is an inline `__AgencyFunction.create({ fn: async (data) => { ... } })` whose JS closure captures the old `__ctx`. On resume the resurrected function executes against the resurrected stateStack but uses a dead `__ctx`. (Not currently covered by a passing or failing test — we removed the test in PR #180 once we realized the deeper issue.)

### The agreed approach (from the discussion that produced this plan)

- **Lift every `callback("onX") as data { ... }` block body** at compile time into a synthesized module-level AgencyFunction `__cb_<scope>_<n>` registered in `__toolRegistry`. The call site becomes `callback("onX", __cb_<scope>_<n>)`. Named-function form (`callback("onX", myFn)`) needs no change.
- **Forbid callback bodies from referencing enclosing function/node locals.** A lifted module-level function has no JS-lexical access to the enclosing function's `__stack.locals.*`, so the body must not assume it does.
- **Make `callback` a reserved name.** Without this guarantee the compiler can't confidently say "this call to `callback` is the stdlib one"; a user could shadow it. We enforce uniqueness in `classifySymbols` (the symbol-table builder).
- **Split `__initializeGlobals(__ctx)`** into:
  - `__initializeGlobals(__ctx)` — only `globals.set(...)`. Gated by `isInitialized` as today.
  - `__registerTopLevelCallbacks(__ctx)` — only the top-level `callback(...)` calls. Runs unconditionally on every `runNode` entry **and** on every resume entry, after `ctx.topLevelCallbacks = []`.

### Out of scope

- Reworking the entire scoped-callback registration mechanism. We keep `State.scopedCallbacks` and the existing `addScopedCallback`/`collectScopedCallbacks` API. We only change what `fn` looks like (now a registered AgencyFunction with a stable name) so serialize/revive works.
- Making `interrupt` thrown instead of returned. Out of scope; the existing return-value model is fine for callbacks once the lifting is in place.

### Stdlib cleanup (small change)

`callback` is currently duplicated in **both** `stdlib/agency.agency` (line 36) and `stdlib/index.agency` (line 206), and the auto-import template (`lib/templates/backends/agency/template.mustache`) already imports it from `std::index`. The duplicate in `stdlib/agency.agency` is dead weight.

- Remove the `callback` definition from `stdlib/agency.agency` (and remove `_callback` from its import line if no longer needed).
- Keep the definition in `stdlib/index.agency` (auto-imported in every `.agency` file).
- The template needs no change — it already imports `callback` from `std::index`.
- Run `make` after the change (stdlib files were modified).
- Quick verification: any test that explicitly does `import { callback } from "std::agency"` will break. Grep the tree before removing:
  ```bash
  rg 'from "std::agency"' tests/ examples/ stdlib/ | grep callback
  ```
  Update any hits to import from `std::index` instead (or drop the import — auto-imported).

### Relevant files (read before starting)

- `lib/runtime/hooks.ts` — `callHook`, `invokeCallback`, `gatherCallbacks`. Already correct after PR #180 patches; the new work doesn't touch it except to maybe revisit the "unhandled interrupt from callback" error path once lifting is in place.
- `lib/runtime/state/stateStack.ts:35-230` — `State` class, `addScopedCallback`, `toJSON`, `fromJSON`, `isGlobalContext`. The scopedCallbacks serialization (`json.scopedCallbacks = ...`) **already passes `fn` through to the outer serializer**, which uses `nativeTypeReplacer` to handle AgencyFunction registry refs. So once `fn` is a registered AgencyFunction, serialize+revive should already work. Read [`lib/runtime/revivers/index.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/scoped-callbacks/packages/agency-lang/lib/runtime/revivers/index.ts) to confirm `nativeTypeReplacer` handles AgencyFunctions by name and `nativeTypeReviver` resolves through `functionRefReviver.registry`.
- `lib/runtime/state/context.ts` — `RuntimeContext`. The `topLevelCallbacks: { name, fn }[]` array lives on `execCtx` (the per-run context), not the global `RuntimeContext`. Search for `topLevelCallbacks` to confirm.
- `lib/runtime/node.ts:85-145` — `runNode`. Currently calls `initializeGlobals(execCtx)` once. Will additionally call `registerTopLevelCallbacks(execCtx)` after resetting `execCtx.topLevelCallbacks = []`.
- `lib/runtime/interrupts.ts` — `respondToInterrupts`. The resume entry point. Needs the same `registerTopLevelCallbacks` wiring as `runNode` so resumed runs re-register top-level callbacks.
- `lib/backends/typescriptBuilder.ts:1192-1244` — `processBlockArgument`. The current site that emits the inline `__AgencyFunction.create({ fn: async (data) => { ... } })`. The hoisting work mostly lives in or around here.
- `lib/backends/typescriptBuilder/sectionAssembler.ts:55-115, 290-332` — `partitionProgram` and `buildInitializeGlobalsFn`. Where top-level statements get bucketed and emitted. The runtime-split work lives here.
- `lib/symbolTable.ts:321-392` — `classifySymbols`. The redefinition-reject check lives here.
- `lib/templates/backends/agency/template.mustache` — auto-import template. Already updated in the previous commit to include `callback`.
- `lib/stdlib/agency.ts:48-67` — `_callbackImpl`. The runtime side. Validates fn callability, routes to top-level vs scoped frame via `isGlobalContext()`. No changes needed.

### Coding conventions and conventions specific to this repo

Read `docs/dev/coding-standards.md` and `docs/dev/anti-patterns.md` once before starting if unfamiliar with the repo. Key points relevant here:

- **No dynamic imports.** Add static `import` lines.
- **Use objects instead of maps; arrays instead of sets** (the existing `RESERVED_TYPE_NAMES` happens to be a `Set` — fine to keep — but for new collections prefer arrays/objects).
- **Templates in `lib/templates/` are typestache-generated.** Only edit the `.mustache` file; run `pnpm run templates` to regenerate the `.ts`. **Never edit the generated `.ts` directly.**
- **AGENTS.md says `make` always when changing stdlib files.** Several tasks here regenerate stdlib output; always run `make` after a stdlib change.
- **Save test output to a file** when running test suites — they're slow and you don't want to re-run them to inspect failures: `pnpm test:run 2>&1 | tee /tmp/tests.log`.

---

## Pre-flight

- [ ] Confirm tree is green:
  ```bash
  pnpm test:run 2>&1 | tee /tmp/preflight.log
  ```
  Expected: 4357 passing.

- [ ] Confirm typecheck + lint are green:
  ```bash
  pnpm run typecheck
  pnpm run lint:structure
  ```

- [ ] Confirm the failing test that this plan exists to fix:
  ```bash
  pnpm run a test tests/agency/callback-resume.agency 2>&1 | tail -20
  ```
  Expected: FAIL with empty output where `fired,` was expected. This is the smoke that we're done at the end.

- [ ] Read `lib/runtime/hooks.ts`, `lib/runtime/state/stateStack.ts:35-230`, `lib/backends/typescriptBuilder.ts:1192-1244`, `lib/backends/typescriptBuilder/sectionAssembler.ts:55-115`, `lib/runtime/node.ts:85-145`, `lib/symbolTable.ts:321-392`.

---

## File Structure (new + significantly modified)

| File | Status | Responsibility |
|---|---|---|
| `lib/typeChecker/resolveCall.ts` | Modify | Add `"callback"` to `RESERVED_FUNCTION_NAMES` (1 line). |
| `lib/typeChecker/reservedNameDeclaration.test.ts` | Modify | Add `callback` cases mirroring existing pattern. |
| `stdlib/agency.agency` | Modify | Remove duplicate `callback` def (kept only in `stdlib/index.agency`). |
| `lib/preprocessors/liftCallbacks.ts` | **Create** | Walk the program, rewrite every `callback(...) { block }` into a top-level `def __cb_<scope>_<n>` + `callback(name, __cb_<scope>_<n>)`. ~100 lines. |
| `lib/preprocessors/liftCallbacks.test.ts` | **Create** | Unit tests: scoped/top-level/nested/named-fn-passthrough. |
| `lib/compiler/compile.ts` | Modify | Insert `liftCallbackBlocks(program)` between `resolveImports` and `buildCompilationUnit` (1 line + import). |
| `lib/backends/typescriptBuilder/sectionAssembler.ts` | Modify | `partitionProgram` separates top-level `callback(...)` calls into a `topLevelCallbackStatements` bucket; new `buildRegisterTopLevelCallbacksFn`. |
| `lib/backends/typescriptBuilder.ts` (main-fn emit only) | Modify | Wire `__registerTopLevelCallbacks` through the generated `runNode({...})` / `respondToInterrupts({...})` invocations. **No `processBlockArgument` change** — the preprocessor eliminated the block form. |
| `lib/runtime/node.ts` | Modify | `runNode` accepts an optional `registerTopLevelCallbacks` param, calls it after `createExecutionContext` (which already clears `topLevelCallbacks = []`). |
| `lib/runtime/interrupts.ts` | Modify | `respondToInterrupts` does the same wiring. |
| `tests/agency/callback-resume.agency` | Already exists | Should now PASS after Task 2. |
| `tests/agency/callback-scoped-resume.agency` + `.test.json` | **Create** | New: scoped callback survives an interrupt + resume (Task 5). |
| `tests/agency/callback-captures-local-error.agency` + `.test.json` | **Create** | New: callback body references an enclosing local → typechecker `"Variable 'x' is not defined"` error (Task 3). |

---

## Task 1 — Reserve the name `callback` (one-line change)

**Goal:** Adding `def callback(...) { }`, `let callback = ...`, `static const callback = ...`, etc. produces the existing reserved-name error: `"'callback' is a reserved built-in; cannot be redefined."`

**Why so small:** the typechecker already has `RESERVED_FUNCTION_NAMES` in [`lib/typeChecker/resolveCall.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/resolveCall.ts#L44) and applies it from [`lib/typeChecker/index.ts:180-217`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/index.ts#L180-L217) to function defs, node defs, exports, AND every `let`/`const` declaration anywhere in the program (verified by [`reservedNameDeclaration.test.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/reservedNameDeclaration.test.ts)). We just add `"callback"` to the set.

**Files:**
- Modify: `lib/typeChecker/resolveCall.ts` (add `"callback"` to `RESERVED_FUNCTION_NAMES`)
- Modify: `lib/typeChecker/reservedNameDeclaration.test.ts` (add `callback` cases mirroring the existing `interrupt` / `schema` cases)
- Optional: `tests/agency/callback-redefinition-error.agency` + `.test.json` (only if `evaluationCriteria.type === "compile-error"` is supported; otherwise rely on the unit test alone)

### Steps

- [ ] **Step 1: Add `callback` to `RESERVED_FUNCTION_NAMES`**

  In `lib/typeChecker/resolveCall.ts`, append `"callback"` to the existing set (around line 64, after `"debugger"`). Add an inline comment explaining: "Auto-imported from `std::index` — see `stdlib/index.agency`."

- [ ] **Step 2: Add unit tests**

  In `lib/typeChecker/reservedNameDeclaration.test.ts`, copy the existing `interrupt`/`schema` test patterns and add:
  - `def callback(...) { }` at top level produces the reserved-name error
  - `let callback = 5` inside a node body produces it
  - `static const callback = 1` produces it
  - `def helper(callback: number)` — parameter shadowing — should NOT produce the error (parameters can shadow; the `walkNodes` loop only checks `assignment` nodes with `declKind`)

- [ ] **Step 3: Run unit tests**

  ```bash
  pnpm test:run lib/typeChecker/reservedNameDeclaration.test.ts 2>&1 | tail -10
  ```

- [ ] **Step 4: Sanity check — auto-import isn't self-rejecting**

  The auto-import template injects `import { ..., callback } from "std::index"` into every compiled `.agency` file. Verify this doesn't itself trip the redefinition check. Compile any existing file and confirm clean:

  ```bash
  pnpm run compile tests/agency/callback-basic.agency 2>&1 | tail -20
  ```

  If it errors, the check is too eager — likely needs to exclude import-bound symbols. (It probably won't; the existing `interrupt` reserved name is also imported by various tests without issue.)

- [ ] **Step 5: Verify the full suite is still green**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/task1.log | tail -5
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add -A
  git commit -m "Reserve 'callback' name; reject user redefinitions"
  ```

---

## Task 2 — Runtime split: re-runnable top-level callback registration

**Goal:** Top-level callbacks survive resume. Achieved by emitting a separate `__registerTopLevelCallbacks(__ctx)` function and calling it on every `runNode` and `respondToInterrupts` entry.

**Files:**
- Modify: `lib/backends/typescriptBuilder/sectionAssembler.ts` (`partitionProgram` + new `buildRegisterTopLevelCallbacksFn`)
- Modify: `lib/backends/typescriptBuilder.ts` (main-module section assembly — emit the new function; wire it into the generated `main(...)` / `respondToInterrupts(...)` invocation sites)
- Modify: `lib/runtime/node.ts` (add `registerTopLevelCallbacks` param to `runNode`; call it after clearing `ctx.topLevelCallbacks = []`)
- Modify: `lib/runtime/interrupts.ts` (`respondToInterrupts` — same wiring)
- Modify: `tests/agency/callback-resume.agency` (no change to source; just becomes a passing test)

### Why two entry points?

`runNode` is called for fresh runs. `respondToInterrupts` is called for resume. Both need the same "clear + re-register top-level callbacks" preamble; they're independent in the runtime, so we wire both.

### Design decision: where does the partition happen?

Compiler-level: `partitionProgram` does a runtime-shape check on each top-level statement and asks "is this a `functionCall` (or expression statement containing a `functionCall`) whose `functionName` is `'callback'`?". If yes, route to `topLevelCallbackStatements`. Otherwise it goes to `globalInitStatements` as today.

By Task 1's guarantee, `callback` always resolves to the stdlib symbol, so a syntactic name match is sufficient. By Task 4's preprocessor, every top-level `callback(...)` call is the named-fn form (`callback("onX", __cb_top_n)`) — the block-form is gone before this partition runs, so there's no special handling for it.

### Steps

- [ ] **Step 1: Add a `topLevelCallbackStatements` bucket to `PartitionResult`**

  In `lib/backends/typescriptBuilder/sectionAssembler.ts` (around line 40):

  ```ts
  export type PartitionResult = {
    // ... existing
    globalInitStatements: TsNode[];
    topLevelCallbackStatements: TsNode[];   // ← new
    topLevelStatements: TsNode[];
    // ...
  };
  ```

- [ ] **Step 2: Update `partitionProgram` to route top-level `callback(...)` calls into the new bucket**

  Find the partition loop. Today it walks `program.nodes` and pushes each statement into either `globalInitStatements` or `topLevelStatements`. Add a new branch:

  ```ts
  if (isTopLevelCallbackCall(node)) {
    topLevelCallbackStatements.push(deps.processNodeInGlobalInit(node));
    continue;
  }
  ```

  Add helper near the top of the file:

  ```ts
  /** True if `node` is a top-level expression statement of the form
   *  `callback("onX", fn)` or `callback("onX") as data { ... }`.
   *  Relies on `callback` being a reserved name (see Task 1) — a user
   *  cannot shadow it, so a syntactic match is sufficient. */
  function isTopLevelCallbackCall(node: AgencyNode): boolean {
    if (node.type !== "expressionStatement") return false;
    const expr = node.expression;
    if (expr.type !== "functionCall") return false;
    return expr.functionName === "callback";
  }
  ```

  **Important:** if `expressionStatement` isn't the right wrapping AST node type in this codebase, adjust accordingly. Run `pnpm run ast <file>` on a sample file with a top-level `callback(...)` call to confirm the AST shape before writing this helper. Use:

  ```bash
  cat > /tmp/cbcheck.agency <<'EOF'
  callback("onNodeStart") as data {
    print(data.nodeName)
  }

  node main() {
    return 1
  }
  EOF
  pnpm run ast /tmp/cbcheck.agency | head -40
  ```

- [ ] **Step 3: Emit `__registerTopLevelCallbacks(__ctx)` in `sectionAssembler.ts`**

  Add alongside `buildInitializeGlobalsFn` (~line 302):

  ```ts
  /**
   * Emit:
   *   async function __registerTopLevelCallbacks(__ctx) {
   *     …topLevelCallbackStatements
   *   }
   *
   * Called from runNode/respondToInterrupts on every entry (after clearing
   * __ctx.topLevelCallbacks = []), so top-level callbacks survive resume.
   * Body deliberately does NOT touch globals or run user `let`/`const`
   * initializers — those stay in __initializeGlobals and are gated.
   */
  function buildRegisterTopLevelCallbacksFn(opts: AssembleSectionsOpts): TsNode {
    return ts.functionDecl(
      "__registerTopLevelCallbacks",
      [{ name: "__ctx" }],
      ts.statements(opts.topLevelCallbackStatements),
      { async: true },
    );
  }
  ```

  Plumb `topLevelCallbackStatements: TsNode[]` through `AssembleSectionsOpts` (around line 167).

  In whatever function assembles the module (search for callers of `buildInitializeGlobalsFn`), emit `buildRegisterTopLevelCallbacksFn` alongside it. Also: when `topLevelCallbackStatements.length === 0`, **still emit an empty function** — the generated `runNode` invocation passes the reference unconditionally, so the function must exist.

- [ ] **Step 4: Wire the new function into the generated `main(...)` invocation**

  Search the typescriptBuilder for where `main = ({...}) => runNode({ ctx: __globalCtx, nodeName: "main", ..., initializeGlobals: __initializeGlobals })` is emitted (it's the `async function main({ messages, callbacks } = {}) { return runNode({...}); }` block in compiled output).

  Add a sibling parameter:

  ```ts
  return runNode({
    ctx: __globalCtx,
    nodeName: "main",
    data: {},
    messages,
    callbacks,
    initializeGlobals: __initializeGlobals,
    registerTopLevelCallbacks: __registerTopLevelCallbacks,   // ← new
  });
  ```

- [ ] **Step 5: Update `runNode` in `lib/runtime/node.ts`**

  Add the new param and call it after clearing:

  ```ts
  export async function runNode({
    ctx,
    nodeName,
    data,
    messages,
    callbacks,
    initializeGlobals,
    registerTopLevelCallbacks,   // ← new
    abortSignal,
  }: {
    // ...existing
    registerTopLevelCallbacks?: (ctx: RuntimeContext<GraphState>) => void | Promise<void>;
    // ...existing
  }): Promise<RunNodeResult<any>> {
    // ...existing
    const execCtx = await ctx.createExecutionContext(runId);
    if (initializeGlobals) {
      await initializeGlobals(execCtx);
    }
    // Top-level callbacks are re-registered on every fresh run AND every
    // resume entry, after clearing the array. This way they survive
    // serialization/deserialization across interrupts: the registry-by-name
    // shape means each fresh registration produces fresh AgencyFunctions
    // closing over the live execCtx.
    execCtx.topLevelCallbacks = [];
    if (registerTopLevelCallbacks) {
      await registerTopLevelCallbacks(execCtx);
    }
    // ...existing (externally-passed callbacks merging, abortSignal, etc.)
  }
  ```

- [ ] **Step 6: Update `respondToInterrupts` in `lib/runtime/interrupts.ts`**

  Find `export async function respondToInterrupts(args: {...})` (~line 331). It also produces an `execCtx`. Mirror the same logic: accept `registerTopLevelCallbacks`, clear the array, call the registrar.

  **Sanity check:** AGENTS.md flags handlers as safety infrastructure not serialized in checkpoints. `respondToInterrupts` should already re-establish handler state via the normal step-driven flow when resumed code re-enters its frames. Confirm that adding the top-level-callbacks re-registration does not change the lifecycle of `__ctx.handlers` (which is rebuilt via `pushHandler()` from generated code, not via this preamble). One-line verification: read the start of `respondToInterrupts` and confirm there's no handlers-related preamble that the new code might collide with.

  Then in the generated `main`-module code, find where `respondToInterrupts` is invoked. Today the compiled file has:

  ```js
  const respondToInterrupts = (interrupts, responses, opts) =>
    _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata });
  ```

  Update the emit to also pass `registerTopLevelCallbacks: __registerTopLevelCallbacks`. Same for `rewindFrom` if it has the same resume-style entry.

  **Decision:** if `respondToInterrupts` and `rewindFrom` share an internal helper that creates the execCtx, plumb the param there once instead of in both call sites.

- [ ] **Step 7: Verify by rebuilding and running the failing test**

  ```bash
  make
  pnpm run a test tests/agency/callback-resume.agency 2>&1 | tail -15
  ```

  Expected: PASS — `"fired,"` appears in the output now.

- [ ] **Step 8: Verify all callback agency tests still pass**

  ```bash
  for t in callback-basic callback-scoped callback-nested callback-toplevel callback-recursion callback-cleanup callback-block-shares-frame callback-function-forms callback-interrupt-handled callback-resume; do
    echo "=== $t ==="
    pnpm run a test "tests/agency/$t.agency" 2>&1 | tail -3
  done 2>&1 | tee /tmp/task2-callbacks.log
  ```

- [ ] **Step 9: Verify the full suite is green**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/task2.log | tail -10
  ```

  **Expected churn:** many debugger test fixtures will be regenerated because every compiled `.js` file now contains an extra `__registerTopLevelCallbacks` function and an extra param on the generated `main()` call. That's expected. If any test fixture fails, regenerate it (`make fixtures`) and confirm the diff is purely additive.

- [ ] **Step 10: Commit**

  ```bash
  git add -A
  git commit -m "Split __initializeGlobals: re-register top-level callbacks on every run/resume"
  ```

---

## Task 3 — Verify capture-check works automatically (no implementation)

**Goal:** Confirm that the preprocessor-lifted body, when typechecked as a normal top-level function, gets the existing "Variable 'x' is not defined" diagnostic from `undefinedVariableDiagnostic.ts` whenever a callback body captures an enclosing local. No new code — just a negative test.

**Why this is free:** Task 4 lifts `callback("onX") as data { … counter + 1 … }` (inside `def wrap() { let counter = 0; … }`) into a top-level `def __cb_wrap_0(data: any) { … counter + 1 … }`. The lifted def is now a sibling of `wrap` at module level; `counter` doesn't resolve there. The existing typechecker pass that produces "Variable 'counter' is not defined" runs over the lifted def the same way it runs over any other function, and emits a diagnostic with `loc` pointing at the original `counter` reference in the user's source (because Task 4 preserves `loc` during the rewrite).

### Steps

- [ ] **Step 1: Verify the `undefinedVariables` setting is enabled in the relevant test config**

  ```bash
  grep -rn "undefinedVariables" lib/ tests/ | head
  ```

  The check is gated by `config.typechecker?.undefinedVariables` (default `"silent"`). For the integration test below to produce an error, the test's agency.json (or the per-test config) must set `"undefinedVariables": "error"`. Check what `tests/agency/` uses by default; if it's silent, either flip the default or add a per-test override.

  **If the default is `"silent"`:** the lifted-body capture will compile cleanly and break silently at runtime (the lifted function references a name that doesn't exist in module scope). This is the same outcome users would hit if they wrote `let foo = bar` at module level with `bar` undefined. Either:
  - (a) Change the default for `tests/agency/` to `"error"` for the integration test, OR
  - (b) Accept that without explicit `undefinedVariables: error`, capture violations only fail at JS-compile/runtime, not at typecheck. Document accordingly.

- [ ] **Step 2: Create the integration test**

  `tests/agency/callback-captures-local-error.agency`:

  ```agency
  def wrap() {
    let counter = 0
    callback("onNodeStart") as data {
      counter = counter + 1
    }
  }

  node main() {
    wrap()
    return 1
  }
  ```

  `tests/agency/callback-captures-local-error.test.json`:

  ```json
  {
    "tests": [{
      "nodeName": "main",
      "input": "",
      "expectedOutput": "ERROR",
      "evaluationCriteria": [{ "type": "compile-error", "pattern": "Variable 'counter' is not defined" }],
      "description": "callback body cannot capture enclosing local"
    }]
  }
  ```

  Verify `compile-error` is supported in `evaluationCriteria.type`. If not, write a unit test in `lib/compiler/compile.test.ts` instead.

- [ ] **Step 3: Run + verify**

  ```bash
  pnpm run a test tests/agency/callback-captures-local-error.agency 2>&1 | tail -10
  ```

  Expected: compile fails with the undefined-variable diagnostic.

- [ ] **Step 4: Audit existing callback tests**

  Before Task 4 lands, confirm no existing `tests/agency/callback-*.agency` test captures an enclosing local. The current tests appear to use module-level globals deliberately (e.g. `let log: string = ""` at top level). Verify by reading each:

  ```bash
  ls tests/agency/callback-*.agency | while read t; do
    echo "=== $t ==="
    cat "$t"
  done | less
  ```

  Refactor any that violate (use module globals or callback params instead).

- [ ] **Step 5: Commit**

  ```bash
  git add tests/agency/callback-captures-local-error.*
  git commit -m "Add capture-check negative test (free via undefined-variable diagnostic)"
  ```

---

## Appendix A — Original codegen-level Task 3 spec (for reference only, not to be implemented)

*This was the pre-preprocessor design. The preprocessor approach makes this entire task unnecessary — the typechecker pass below was replaced by the existing `undefinedVariableDiagnostic` pass running over the lifted defs. Kept here only as a paste-bin if we ever decide to refactor and want a richer "callback-aware" diagnostic message.*

<details>
<summary>Original Task 3 spec (collapsed)</summary>

**Goal:** Reject any callback body that references a name resolving to a local/param of an enclosing function or node. Catches the bug we'd otherwise hit in Task 4 when the lifted body has no JS-lexical access to the enclosing `__stack`.

**Files:**
- Create: `lib/typeChecker/callbackCaptureCheck.ts` (the new pass)
- Create: `lib/typeChecker/callbackCaptureCheck.test.ts` (unit tests)
- Modify: `lib/typeChecker/typeChecker.ts` (or wherever the existing checker entry point is — wire the new pass in)
- Create: `tests/agency/callback-captures-local-error.agency` (integration negative test)
- Create: `tests/agency/callback-captures-local-error.test.json`

### Design decision: where does the check live?

The existing type checker walks the program with scope awareness. The cleanest integration is a dedicated pass that:

1. Walks the program looking for every `functionCall` whose `functionName === "callback"`.
2. For each one with a `block`, walks the block body collecting every identifier reference.
3. For each identifier reference, asks the existing scope resolver: "does this name resolve to a local/param of an enclosing function or node?"
4. If yes, emit a typechecker error pointing at the identifier's source location.

### What counts as "allowed" inside a callback body

- The callback's own parameter (`as data` → `data`, or named-fn params)
- The callback's own `let`/`const` locals
- Module-level imports (the auto-imported `print`, `range`, etc.)
- Module-level functions defined in the same file
- Module-level constants
- Globals (top-level `let`/`const` — these become `__ctx.globals.get(...)` at runtime, fine)

### What is rejected

- Function/node-level `let`/`const` declared in the enclosing scope
- Function/node parameters from the enclosing scope
- Block-scoped `let`/`const` in any block containing the callback

### Steps

- [ ] **Step 1: Write unit tests in `lib/typeChecker/callbackCaptureCheck.test.ts`**

  ```ts
  import { describe, it, expect } from "vitest";
  import { parseAgency } from "../parser.js";
  import { checkCallbackCaptures } from "./callbackCaptureCheck.js";

  function check(src: string): string[] {
    const result = parseAgency(src);
    if (!result.success) throw new Error("parse failed");
    return checkCallbackCaptures(result.result).map((d) => d.message);
  }

  describe("callback body capture check", () => {
    it("rejects capture of enclosing function local", () => {
      const errors = check(`
        def wrap() {
          let counter = 0
          callback("onNodeStart") as data {
            counter = counter + 1
          }
        }
      `);
      expect(errors.some((m) => /counter/.test(m))).toBe(true);
    });

    it("rejects capture of enclosing function param", () => {
      const errors = check(`
        def wrap(arg: number) {
          callback("onNodeStart") as data {
            print(arg)
          }
        }
      `);
      expect(errors.some((m) => /arg/.test(m))).toBe(true);
    });

    it("rejects capture of enclosing node local", () => {
      const errors = check(`
        node main() {
          let counter = 0
          callback("onNodeStart") as data {
            counter = counter + 1
          }
          return counter
        }
      `);
      expect(errors.some((m) => /counter/.test(m))).toBe(true);
    });

    it("allows module-level globals", () => {
      const errors = check(`
        let log: string = ""
        node main() {
          callback("onNodeStart") as data {
            log = log + ","
          }
          return log
        }
      `);
      expect(errors).toEqual([]);
    });

    it("allows the callback's own parameter", () => {
      const errors = check(`
        node main() {
          callback("onNodeStart") as data {
            print(data.nodeName)
          }
          return 1
        }
      `);
      expect(errors).toEqual([]);
    });

    it("allows the callback's own local", () => {
      const errors = check(`
        node main() {
          callback("onNodeStart") as data {
            let msg = data.nodeName
            print(msg)
          }
          return 1
        }
      `);
      expect(errors).toEqual([]);
    });

    it("allows auto-imported stdlib functions", () => {
      const errors = check(`
        node main() {
          callback("onNodeStart") as data {
            print(data.nodeName)
          }
          return 1
        }
      `);
      expect(errors).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Run; verify all fail**

  ```bash
  pnpm test:run lib/typeChecker/callbackCaptureCheck.test.ts 2>&1 | tail -10
  ```

- [ ] **Step 3: Implement `lib/typeChecker/callbackCaptureCheck.ts`**

  Sketch — exact API depends on the existing typeChecker conventions. **Read `lib/typeChecker/scope.ts` and one existing checker pass before writing this** to match the codebase style:

  ```ts
  import type { AgencyProgram, AgencyNode } from "../types.js";
  import type { SourceLocation } from "../types/baseNode.js";

  export type CaptureDiagnostic = {
    severity: "error";
    message: string;
    loc?: SourceLocation;
    variableName: string;
  };

  /** Walk the program looking for callback(...) calls with block bodies;
   *  for each one, verify the body does not reference enclosing function/
   *  node locals or params. Returns an array of diagnostics. */
  export function checkCallbackCaptures(program: AgencyProgram): CaptureDiagnostic[] {
    const diagnostics: CaptureDiagnostic[] = [];

    // Walk the program. Maintain a stack of enclosing scopes (function/
    // node), each tracking its locals + params. Top-level statements have
    // no enclosing scope, so callbacks at top level are trivially safe.
    walkWithScope(program.nodes, {
      enterFunctionLike(scope) { /* push scope */ },
      exitFunctionLike() { /* pop */ },
      onFunctionCall(node, enclosingScopes) {
        if (node.functionName !== "callback") return;
        if (!node.block) return;
        const enclosingLocals = new Set<string>();
        for (const s of enclosingScopes) {
          for (const n of s.locals) enclosingLocals.add(n);
          for (const p of s.params) enclosingLocals.add(p);
        }
        // Walk node.block.body collecting identifier references.
        // For each, skip if it's the callback's own param or local;
        // skip if it resolves to module-level (search program.nodes
        // for matching top-level binding); else report.
        for (const id of collectIdentifierRefs(node.block)) {
          if (isCallbackOwn(id, node.block)) continue;
          if (isModuleLevel(id, program)) continue;
          if (enclosingLocals.has(id.name)) {
            diagnostics.push({
              severity: "error",
              message:
                `Callback body cannot capture enclosing local '${id.name}'. ` +
                `Use a global, or pass the value through the callback's parameter.`,
              loc: id.loc,
              variableName: id.name,
            });
          }
        }
      },
    });

    return diagnostics;
  }
  ```

  Don't actually implement `walkWithScope` from scratch if the type checker already has one. Search:

  ```bash
  grep -rn "walkWithScope\|Scope\.\|enterScope\|exitScope" lib/typeChecker/ | head
  ```

  Use the existing infrastructure.

- [ ] **Step 4: Run unit tests; verify they pass**

- [ ] **Step 5: Wire into the typechecker entry point**

  Find where the existing type checker is run (look in `lib/compiler/compile.ts` for type-check invocation, or in `lib/typeChecker/typeChecker.ts`). Add a call:

  ```ts
  const captureDiagnostics = checkCallbackCaptures(program);
  diagnostics.push(...captureDiagnostics);
  ```

  Where `diagnostics` is the existing diagnostic accumulator. Make sure these are surfaced as compile errors, not warnings.

- [ ] **Step 6: Create the negative integration test**

  `tests/agency/callback-captures-local-error.agency`:

  ```agency
  def wrap() {
    let counter = 0
    callback("onNodeStart") as data {
      counter = counter + 1
    }
  }

  node main() {
    wrap()
    return 1
  }
  ```

  `tests/agency/callback-captures-local-error.test.json` — same pattern as Task 1's redefinition test; expect a compile error matching `/cannot capture enclosing local/`.

- [ ] **Step 7: Run + verify**

  ```bash
  pnpm test:run lib/typeChecker/callbackCaptureCheck.test.ts 2>&1 | tail -5
  pnpm run a test tests/agency/callback-captures-local-error.agency 2>&1 | tail -5
  ```

- [ ] **Step 8: Audit existing tests for accidental violations**

  Before considering this task done, search for callback bodies that *currently* capture enclosing locals — those tests would now fail to compile after Task 4.

  ```bash
  grep -rn "callback(" tests/agency/*.agency examples/ stdlib/ 2>/dev/null | head -20
  ```

  Manually inspect each and either:
  - Refactor to use a module-level global instead, or
  - Leave the test alone if it's already correct (only uses callback's own param / module-level names).

  The existing `tests/agency/callback-*.agency` tests committed so far use module-level globals (e.g., `log` declared at top level) intentionally for exactly this reason. Verify by reading each.

- [ ] **Step 9: Full suite**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/task3.log | tail -10
  ```

- [ ] **Step 10: Commit**

  ```bash
  git commit -am "Typechecker: forbid callback bodies from capturing enclosing locals"
  ```

</details>

---

## Task 4 — Preprocessor: lift callback block bodies to module-level `def`s

**Goal:** Every `callback("onX") as data { … }` (or `callback("onX") { … }`) becomes, *before* `buildCompilationUnit` runs, a synthesized top-level `def __cb_<scope>_<n>(data: any) { … }` plus a `callback("onX", __cb_<scope>_<n>)` call. Named-fn form `callback("onX", myFn)` passes through unchanged.

The transformation is **AST-to-AST**. The codegen, typechecker, and runtime all see the rewritten program and have no idea callbacks were ever a block form.

**Files:**
- Create: `lib/preprocessors/liftCallbacks.ts` (~100 lines)
- Create: `lib/preprocessors/liftCallbacks.test.ts` (unit tests; ~120 lines)
- Modify: `lib/compiler/compile.ts` (1 import + 1 line inserting `liftCallbackBlocks` between `resolveImports` and `buildCompilationUnit`)

### Design decisions

- **Naming:** `__cb_<scope>_<n>` where `<scope>` is the enclosing `def`/`node` name (or `top` for module-level) and `<n>` is a module-monotonic counter. Example: `__cb_main_0`, `__cb_wrap_1`, `__cb_top_2`. The counter is module-wide (not per-scope) so two scopes sharing a name can't collide.
- **Source locations preserved.** Every statement in the lifted body must keep its original `loc`. Otherwise the "Variable 'x' is not defined" diagnostic from Task 3 points at the wrong place. The block-arg's own `loc` becomes the `loc` of the synthesized `def`.
- **Block params → def params.** `as data` (or `(data, extra) =>`) maps directly to `def __cb_xxx(data: any, extra: any)`. Since `callback`'s signature is `(name: string, fn: any)`, there's no block-type info to propagate; all params get `any`. Easy.
- **Bare-body form `callback("onX") { … }` (no `as` clause).** Lift to `def __cb_xxx(data: any) { … }` (ignore the param). Verify against parser to confirm what `block.params` looks like in this case.
- **Named-fn form passes through.** `callback("onX", myFn)` has no `block`, so the walker skips it.
- **The lifted def is auto-registered in `__toolRegistry` via the normal user-`def` codegen path.** No special handling; `function` AST nodes are already emitted as registered AgencyFunctions.

### Sketch

```ts
// lib/preprocessors/liftCallbacks.ts
import type { AgencyProgram, AgencyNode, FunctionDefinition } from "@/types.js";
import type { FunctionCall } from "@/types/functionCall.js";

let counter = 0;
function nextName(scope: string): string {
  return `__cb_${scope}_${counter++}`;
}
export function resetCounter(): void { counter = 0; }  // for deterministic tests

export function liftCallbackBlocks(program: AgencyProgram): AgencyProgram {
  const lifted: FunctionDefinition[] = [];
  const newNodes: AgencyNode[] = [];

  for (const node of program.nodes) {
    newNodes.push(transformNode(node, "top", lifted));
  }

  // Prepend lifted defs so they appear before any caller in the module.
  // (Hoisting isn't required for correctness — codegen registers all defs
  // at module-load time before anything runs — but it keeps the AST tidy
  // and matches what a hand-written program would look like.)
  return { ...program, nodes: [...lifted, ...newNodes] };
}

// transformNode recursively walks function/node bodies, calling
// transformCallExpr on every functionCall and accumulating lifted defs
// in `lifted`. Block-body callbacks become a synthetic def + a
// transformed call expression with the second arg replaced by a
// variableName reference to the lifted def.
function transformNode(
  node: AgencyNode, enclosingScope: string, lifted: FunctionDefinition[],
): AgencyNode { /* ... */ }

function liftCallbackCall(
  call: FunctionCall, enclosingScope: string, lifted: FunctionDefinition[],
): FunctionCall {
  if (call.functionName !== "callback" || !call.block) return call;
  const name = nextName(enclosingScope);
  lifted.push(synthesizeDef(name, call.block, call.loc));
  // Replace `callback("onX") { ... }` with `callback("onX", __cb_xxx)`.
  return {
    ...call,
    block: undefined,
    args: [
      ...call.args,  // existing "onX" arg
      { type: "variableName", value: name, loc: call.loc } as any,
    ],
  };
}
```

The exact shape of `synthesizeDef` and the call-args rewrite depends on the current AST types — read [`lib/types/functionCall.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/functionCall.ts) and [`lib/types/function.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/function.ts) before writing.

### Steps

- [ ] **Step 1: Write unit tests in `lib/preprocessors/liftCallbacks.test.ts`**

  Test the AST-to-AST transformation directly. Each test parses source, runs `liftCallbackBlocks`, and inspects the resulting AST:

  - Top-level `callback("onX") as data { … }` produces a `__cb_top_0` def and rewrites the call to `callback("onX", __cb_top_0)`.
  - Scoped `def wrap() { callback("onX") as data { … } }` produces a sibling `__cb_wrap_0` def and rewrites the call inside `wrap`.
  - Named-fn form `callback("onX", myFn)` passes through unchanged (no new def, no rewrite).
  - Nested: `def outer() { def inner() { callback("onX") { … } } }` — actually, agency doesn't support nested defs at parser level, so this test verifies that callbacks inside scoped blocks (`if`, `for`, etc.) still use the enclosing function's name as scope.
  - Multiple callbacks in one scope produce monotonically named defs.
  - The lifted def's `loc` matches the original block-arg's `loc`.
  - Identifier refs inside the lifted body keep their original `loc`.

  Use `resetCounter()` between tests for determinism.

- [ ] **Step 2: Run unit tests; they should fail (preprocessor doesn't exist yet)**

- [ ] **Step 3: Implement `liftCallbacks.ts`**

  Use [`parallelDesugar.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/preprocessors/parallelDesugar.ts) as the structural template (it walks function/node bodies, produces a new program). Key differences:
  - This preprocessor adds NEW top-level nodes (the lifted defs); `parallelDesugar` doesn't.
  - This preprocessor must recurse into nested blocks (`if`, `for`, `while`, `handle`) but the enclosing-scope NAME is set by the nearest enclosing `def`/`node`/`top`, not by every block.

- [ ] **Step 4: Wire into `lib/compiler/compile.ts`**

  ```diff
    const resolvedProgram = resolveImports(reExportedProgram, symbolTable, syntheticPath);

  + // Lift callback block bodies to top-level defs. Must run BEFORE
  + // buildCompilationUnit (so the lifted defs appear in functionDefinitions)
  + // and BEFORE typeCheck (so undefinedVariableDiagnostic catches captures).
  + const liftedProgram = liftCallbackBlocks(resolvedProgram);

  - const info = buildCompilationUnit(resolvedProgram, ...);
  + const info = buildCompilationUnit(liftedProgram, ...);
  ```

  Then use `liftedProgram` throughout the rest of the function (steps 5, 6, 7 in `compile.ts`). Easiest: rename `resolvedProgram` to `liftedProgram` and reassign.

- [ ] **Step 5: Run unit tests; verify they pass**

  ```bash
  pnpm test:run lib/preprocessors/liftCallbacks.test.ts 2>&1 | tail -10
  ```

- [ ] **Step 6: Run callback agency tests**

  ```bash
  for t in callback-basic callback-scoped callback-nested callback-toplevel callback-recursion callback-cleanup callback-block-shares-frame callback-function-forms callback-interrupt-handled callback-resume; do
    echo "=== $t ==="
    pnpm run a test "tests/agency/$t.agency" 2>&1 | tail -3
  done 2>&1 | tee /tmp/task4-callbacks.log
  ```

  All should pass. If any fail, debug — most likely culprits:
  - The lifted def doesn't get registered in `__toolRegistry` (verify by compiling one test and inspecting generated `.js` for `__registerTool(__cb_xxx)`).
  - The call-args rewrite produces an invalid AST (verify with `pnpm run ast` on a compiled file).
  - The lifted def's params don't match what `callback`'s body expects.

- [ ] **Step 7: Inspect a generated `.ts` to confirm the shape**

  ```bash
  pnpm run compile tests/agency/callback-basic.agency 2>&1 | head -100
  ```

  Expected:
  - A synthesized `async function __cb_<scope>_<n>(data) { ... }` (or `__AgencyFunction.create(...)` wrapper, depending on user-`def` codegen) appears at module top.
  - The call site reads `callback("onX", __cb_<scope>_<n>)`.
  - **No inline `__AgencyFunction.create({ fn: async (data) => ... })` at the call site.**

- [ ] **Step 8: Full suite + regenerate fixtures**

  ```bash
  make
  pnpm test:run 2>&1 | tee /tmp/task4-full.log | tail -10
  ```

  **Expected fixture churn:** every `tests/typescriptGenerator/` fixture with a block-form `callback(...) { ... }` will produce a different compiled output (lifted def at top + `callback("onX", __cb_xxx)` call). `make fixtures` regenerates them. Inspect one diff manually to verify it's additive + correct, then accept the rest.

- [ ] **Step 9: Commit**

  ```bash
  git add -A
  git commit -m "Preprocessor: lift callback block bodies to module-level defs"
  ```

---

## Task 5 — Scoped callbacks survive resume

**Goal:** A scoped callback registered inside `def foo() { callback("onX") as data { ... } ... bar() }` where `bar()` throws an interrupt — after resume, the callback fires correctly during the rest of `foo`'s execution.

This task should be a **near-trivial verification** at this point, because:
1. Task 4 made the callback function a registered AgencyFunction with a stable module-level name.
2. `State.toJSON`/`fromJSON` (lib/runtime/state/stateStack.ts:165-230) already serializes `scopedCallbacks` and passes `fn` through to the outer serializer, which uses `nativeTypeReplacer` for AgencyFunction registry refs (verify this in `lib/runtime/revivers/index.ts`).

So the path is "verify it just works; if it doesn't, debug + fix."

**Files:**
- Possibly modify: `lib/runtime/state/stateStack.ts:175-181, 212-216` (the `fn: cb.fn` passthrough — maybe needs explicit handling)
- Possibly modify: `lib/runtime/revivers/index.ts` (if AgencyFunction passthrough has gaps)
- Create: `tests/agency/callback-scoped-resume.agency`
- Create: `tests/agency/callback-scoped-resume.test.json`

### Steps

- [ ] **Step 1: Write the scoped-resume integration test**

  Create `tests/agency/callback-scoped-resume.agency`:

  ```agency
  let log: string = ""

  def doWork() {
    interrupt myapp::pause("paused", {})
  }

  def wrap() {
    callback("onFunctionEnd") as data {
      log = log + "fired:" + data.functionName + ","
    }
    doWork()
    doWork()
  }

  node main(): string {
    wrap()
    return log
  }
  ```

  Create `tests/agency/callback-scoped-resume.test.json`:

  ```json
  {
    "tests": [{
      "nodeName": "main",
      "input": "",
      "interrupts": [{ "kind": "myapp::pause", "response": "approve" }, { "kind": "myapp::pause", "response": "approve" }],
      "expectedOutput": "\"fired:doWork,fired:doWork,fired:wrap,\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "scoped callback survives interrupt + resume"
    }]
  }
  ```

  **Note:** check existing tests with `"interrupts"` in their `.test.json` to confirm the exact shape — `tests/agency/callback-resume.test.json` is the obvious reference. Use the same shape.

  **Hook-semantics caveat:** the `expectedOutput` above assumes `onFunctionEnd` fires once per `doWork()` call AND once for `wrap` itself. Before relying on that exact string, read `lib/runtime/hooks.ts`'s `onFunctionEnd` firing logic and inspect a compiled `.js` for `wrap` to confirm `onFunctionEnd` fires in the `finally` block AFTER any interrupt-halt-return (i.e. does NOT fire when the function halts with an interrupt). If `wrap` halts and re-enters, the order or count of `fired:wrap` entries in `log` may differ. Adjust `expectedOutput` to whatever the runtime actually produces — the point of this test is just "scoped callbacks fire after resume at all", not asserting a specific count.

- [ ] **Step 2: Run it; observe result**

  ```bash
  pnpm run a test tests/agency/callback-scoped-resume.agency 2>&1 | tee /tmp/task5-scoped.log | tail -20
  ```

  Three possible outcomes:

  **A. PASS.** Task 4 already wired everything correctly via the registry. Go to Step 6.

  **B. FAIL — output is empty or partial after resume.** The `scopedCallbacks` serialization didn't include the registered AgencyFunction name. Inspect `State.toJSON` output by adding a temporary `console.log(JSON.stringify(json.scopedCallbacks, ..., 2))` and see what `fn` serialized as. Most likely fix: explicitly call `cb.fn.toJSON?.()` or rely on `nativeTypeReplacer` more aggressively in the JSON.stringify call inside `interrupts.ts`.

  **C. CRASH.** The reviver isn't finding the function in `__toolRegistry`. Inspect the registry on resume — is the module's `__toolRegistry` populated by the time the reviver runs? It should be, because the generated `.js` module top-level code that calls `__registerTool(...)` runs as soon as the module loads.

- [ ] **Step 3: If B or C, debug**

  Likely fix candidates:
  - In `lib/runtime/state/stateStack.ts:178-181`, replace the `fn: cb.fn` passthrough with a proper serialization:
    ```ts
    json.scopedCallbacks = this.scopedCallbacks.map((cb) => ({
      name: cb.name,
      fn: AgencyFunction.isAgencyFunction(cb.fn)
        ? { __agencyFnRef: cb.fn.name, __agencyFnModule: cb.fn.module }
        : cb.fn,
    }));
    ```
  - Corresponding revive path in `fromJSON`:
    ```ts
    state.scopedCallbacks = json.scopedCallbacks.map((cb) => ({
      name: cb.name,
      fn: cb.fn?.__agencyFnRef
        ? functionRefReviver.lookup(cb.fn.__agencyFnRef)
        : cb.fn,
    }));
    ```

  But ideally these don't need explicit handling because the outer `nativeTypeReplacer`/`nativeTypeReviver` already does this for any AgencyFunction it encounters. Verify before adding explicit code.

- [ ] **Step 4: Add a unit test for the serialization round-trip**

  Add to `lib/runtime/state/stateStack.test.ts`:

  ```ts
  it("scopedCallbacks round-trip via JSON when fn is a registered AgencyFunction", () => {
    const registry: any = {};
    const fn = AgencyFunction.create({
      name: "__cb_test_0",
      module: "test.agency",
      fn: async (data: any) => {},
      params: [{ name: "data", hasDefault: false, defaultValue: undefined, variadic: false }],
      toolDefinition: null,
    }, registry);
    const state = new State();
    state.addScopedCallback("onNodeStart", fn);

    // Simulate the full serialize-then-revive path that resume goes through.
    const json = JSON.parse(JSON.stringify(state.toJSON(), nativeTypeReplacer));
    // ... revive registry ...
    const revived = State.fromJSON(JSON.parse(JSON.stringify(json), (k, v) => nativeTypeReviver(k, v)));
    expect(revived.scopedCallbacks).toHaveLength(1);
    expect(AgencyFunction.isAgencyFunction(revived.scopedCallbacks![0].fn)).toBe(true);
  });
  ```

- [ ] **Step 5: Run + commit if changes**

  ```bash
  pnpm test:run lib/runtime/state/stateStack.test.ts 2>&1 | tail -10
  ```

- [ ] **Step 6: Full suite + final check**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/task5-full.log | tail -10
  for t in callback-resume callback-scoped-resume; do
    pnpm run a test "tests/agency/$t.agency" 2>&1 | tail -3
  done
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add -A
  git commit -m "Scoped callbacks survive interrupt resume via registry-based serialization"
  ```

---

## Task 6 — Documentation + final cleanup

**Goal:** Doc the new behavior; confirm everything's green; clean up any remaining oddities.

**Files:**
- Modify: `docs/site/guide/` — find the callbacks doc page (or create one if missing); document:
  - `callback` is a reserved name
  - Callback bodies cannot capture enclosing locals; use a global or the callback's own param
  - Top-level callbacks fire for the entire run including across resume
  - Scoped callbacks fire for the dynamic extent of the registering function, including across resume
- Possibly delete: `stdlib/agency.agency`'s `callback` definition (now redundant since auto-imported). **Defer this decision** — leaving it in is harmless backward compat; removing it breaks any existing user code that explicitly imports from `std::agency`. Recommendation: leave alone for this PR; deprecate in a follow-up.

### Steps

- [ ] **Step 1: Find/update the callbacks doc**

  ```bash
  grep -rln "callback" docs/site/guide/ | head
  ```

  Update or create as needed.

- [ ] **Step 2: Update CHANGELOG.md**

  Add an entry under the next-version heading:

  ```markdown
  ### Callbacks
  - `callback` is now auto-imported in every .agency file; explicit `import { callback } from "std::agency"` is no longer needed (but still works).
  - `callback` is a reserved name and cannot be redefined.
  - Callback bodies cannot reference enclosing function/node locals (compile error). Use a global or the callback's own parameter.
  - Top-level and scoped callbacks now survive interrupt + resume.
  ```

- [ ] **Step 3: Final green sweep**

  ```bash
  make
  pnpm run typecheck
  pnpm run lint:structure
  pnpm test:run 2>&1 | tee /tmp/final.log | tail -10
  ```

- [ ] **Step 4: Run every callback agency test**

  ```bash
  ls tests/agency/callback-*.agency | while read t; do
    name=$(basename "$t" .agency)
    echo "=== $name ==="
    pnpm run a test "$t" 2>&1 | tail -3
  done 2>&1 | tee /tmp/all-callback-tests.log
  ```

  All should pass.

- [ ] **Step 5: Commit**

  ```bash
  git commit -am "Docs + changelog for callback lifting work"
  ```

  **Do not `git push` without explicit user confirmation** (AGENTS.md rule). After committing, ask the user whether to push and update the PR description (link the original PR #180 or open a new one referencing this plan).

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Lifting misses a callback registered indirectly (e.g. `let myCb = "callback"; (myCb)(...)`) | Low | We only support the direct call-site form `callback("onX", ...)`. Variable-indirected calls go through the unlifted path. Document as a non-feature. |
| Preprocessor mutates a node it shouldn't (e.g. mistakes another function named `callback` from a non-stdlib import) | Low | Task 1 reserves the name globally — there is no other `callback`. Defensive: assert during the rewrite that the call's resolved import (if any) points at the stdlib `callback`. |
| Lifted def doesn't get registered in `__toolRegistry` because codegen treats it differently | Low | The preprocessor produces a normal `function` AST node. Codegen has one path for `function` nodes. Verify by inspecting one compiled `.ts` (Task 4 Step 7). |
| Source locations in the lifted body are wrong, producing confusing diagnostics | Medium | Task 4 Step 1 explicitly tests `loc` preservation. The preprocessor must do a shallow clone of each body node (don't recreate from scratch). |
| `undefinedVariables` check is `"silent"` by default, so the capture check from Task 3 doesn't actually fire | Medium | Task 3 Step 1 verifies this. Either flip the default for `tests/agency/`, or accept that captures fail at JS-compile/runtime with a worse message. Document. |
| Scoped callback test (Task 5) reveals deeper closure issues not anticipated | Low (lower than before) | With preprocessor lifting, the `fn` is now a registered AgencyFunction — the existing `nativeTypeReplacer`/`nativeTypeReviver` should just work. Task 5 is mostly a verification step. |
| Existing fixtures in `tests/typescriptGenerator/` and `tests/debugger/` need extensive regeneration | High | `make fixtures` handles most; inspect one diff manually to verify additivity, then accept the rest. Save before/after of one fixture file for the PR description. |
| `evaluationCriteria.type === "compile-error"` doesn't exist in the test harness | Medium | Fall back to unit tests for compile-error scenarios. Check `docs/misc/TESTING.md` early. |
| Preprocessor order matters — running `liftCallbacks` AFTER `resolveImports` but BEFORE `buildCompilationUnit` | Low | Encoded in Task 4 Step 4 explicitly. Pipeline order is small and inspectable in `lib/compiler/compile.ts`. |

---

## Done criteria

- [ ] `tests/agency/callback-resume.agency` passes.
- [ ] `tests/agency/callback-scoped-resume.agency` passes.
- [ ] `tests/agency/callback-captures-local-error.agency` errors at compile time with `"Variable 'counter' is not defined"` (or equivalent).
- [ ] All other `tests/agency/callback-*.agency` continue to pass.
- [ ] `lib/typeChecker/reservedNameDeclaration.test.ts` covers `callback` and passes.
- [ ] `lib/preprocessors/liftCallbacks.test.ts` covers all design-decision scenarios and passes.
- [ ] Auto-imported `callback` does NOT trip the reserved-name check (sanity check from Task 1 Step 4).
- [ ] `callback` is defined once, in `stdlib/index.agency`; the duplicate in `stdlib/agency.agency` is gone.
- [ ] No explicit `import { callback } from "std::agency"` remains in `tests/`, `examples/`, or `stdlib/`.
- [ ] Inspecting a compiled `tests/agency/callback-basic.agency` shows: NO inline `__AgencyFunction.create({ fn: async (data) => ... })` at the call site; a top-level `__cb_<scope>_<n>` def exists; the call site reads `callback("onX", __cb_<scope>_<n>)`.
- [ ] `pnpm test:run` is green.
- [ ] `pnpm run typecheck` is clean.
- [ ] `pnpm run lint:structure` is clean.
- [ ] `make` rebuilds cleanly.
- [ ] CHANGELOG.md has an entry summarizing the new behavior.
- [ ] Callbacks doc page mentions: "callback bodies cannot reference enclosing function/node locals — the compiler will emit an undefined-variable error if you try."
