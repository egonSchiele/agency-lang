import type { AgencyNode, AgencyProgram } from "../../types.js";
import type { TsNode } from "../../ir/tsIR.js";
import { ts } from "../../ir/builders.js";
import { InitGetterRewriter } from "./initGetterRewriter.js";

/**
 * Two helpers for the orchestration phase of `TypeScriptBuilder.build()`:
 *
 *   1. {@link partitionProgram} — single pass over the program nodes
 *      that sorts them into the buckets the output assembly cares
 *      about (static-var init, global init, top-level declarations).
 *   2. {@link assembleSections} — concatenates the already-built
 *      pieces (imports, builtins, type aliases, init functions,
 *      generated statements, sourcemap) into the final TsNode in the
 *      correct, fixed order.
 *
 * Both are functions, not classes — they hold no state of their own;
 * the builder still owns all of the shared scratch state. Pulling
 * them out makes `build()` read declaratively as
 * "partition → assemble" rather than ~180 lines of inline glue.
 */

// ── Partition ──

export type PartitionDeps = {
  processNode: (node: AgencyNode) => TsNode;
  processNodeInGlobalInit: (node: AgencyNode) => TsNode;
  /**
   * Process the RHS of a `static const X = …` declaration in a
   * static-init context. The callback is responsible for:
   *  - Marking codegen state so reads of imported / same-module top
   *    level statics inside the value expression are rewritten to
   *    `await __init_<dep>(__ctx)` (the getter cascade that fixes the
   *    cross-module init ordering bug #232).
   *  - Restoring codegen state on return (try/finally).
   * The `varName` arg is the var currently being initialized — used by
   * the rewriter to avoid emitting a self-call for the trivially-cyclic
   * (and therefore disallowed) case of `static const X = X + 1`.
   */
  processStaticInitValue: (varName: string, node: AgencyNode) => TsNode;
  buildHandlerArrow: (handlerName: string) => TsNode;
  isTopLevelDeclaration: (node: AgencyNode) => boolean;
  moduleId: string;
  /**
   * Invoked once with the set of every same-module top-level static
   * var name BEFORE any RHS is processed via `processStaticInitValue`.
   * Lets the caller register names with its init-getter rewriter so
   * forward references (`static const A = B + 1` where B is declared
   * later) rewrite correctly. Optional: callers that don't need the
   * rewrite (e.g. one-shot inspection of partition output) can omit it.
   */
  onStaticVarNamesCollected?: (names: ReadonlySet<string>) => void;
};

/**
 * Compiled per-variable init spec. One produced per top-level
 * `static const`. The codegen turns this into:
 *
 *   let X;            // or `export let X;` if `exported`
 *   const __init_X = __initVar("<moduleId>:X", async (__ctx) => {
 *     ...computeBody  // typically: X = __deepFreeze(<rewritten rhs>); return X;
 *   });
 *
 * The compute body owns both the assignment to the module-level `let`
 * AND the `return` of the value (so callers of `__init_X` get the
 * populated value back). Putting the assignment + return inside the
 * same closure means concurrent callers all observe the same final
 * value because `__initVar` memoizes on its compute's promise.
 */
export type InitVarSpec = {
  varName: string;
  exported: boolean;
  computeBody: TsNode[];
};

export type ProgramPartition = {
  /** Names of `static` variables declared at module level. */
  staticVarNames: Set<string>;
  /** Subset of `staticVarNames` that are `export`-ed. */
  exportedStaticVarNames: Set<string>;
  /**
   * Per-variable init specs in source declaration order. Source order
   * does NOT determine init order at runtime — the getter cascade does
   * — but it's the order they'll appear in `__MY_INIT_GETTERS`, which
   * pins iteration order for trace/checkpoint replay determinism.
   */
  staticInitVars: InitVarSpec[];
  /** Statements that initialize global variables / run top-level code per execution. */
  globalInitStatements: TsNode[];
  /** Top-level declarations (functions, graph nodes, type aliases, classes). */
  topLevelStatements: TsNode[];
  /**
   * Top-level `callback(...)` registration calls. Kept separate from
   * `globalInitStatements` so the codegen can emit them inside a
   * rerunnable `__registerTopLevelCallbacks(__ctx)` helper that fires on
   * every fresh run AND every resume. Globals are checkpointed and
   * restored on resume; the `topLevelCallbacks` array on the runtime
   * context is not — so the callbacks must be re-registered on every
   * resume cycle.
   *
   * Critical ordering: resume paths (`respondToInterrupts`,
   * `rewindFrom`) call `registerTopLevelCallbacks(execCtx)` BEFORE
   * `restoreState(...)`. The `_callbackImpl` stdlib helper routes a
   * registration to `ctx.topLevelCallbacks` only when the state stack is
   * empty (i.e., the call is happening at module-init / top-level
   * position); once `restoreState` has rebuilt a non-empty stack, the
   * same registration call would be misrouted as a scoped callback on
   * the wrong frame. If you change the order of these two calls, every
   * top-level callback registered after the first interrupt cycle will
   * either silently land on a foreign frame or not fire at all.
   */
  topLevelCallbackStatements: TsNode[];
};

/**
 * Walk the program once and route each node into the right bucket:
 *
 *   - `static` assignments (and `with handler { static x = ... }`)
 *     contribute names + frozen init statements.
 *   - `global` assignments (and their `with handler` form) contribute
 *     `__ctx.globals.set(...)` calls.
 *   - Top-level declarations (per `isTopLevelDeclaration`) become
 *     module-scope generated statements.
 *   - Anything else (bare expressions, function calls, …) goes into
 *     `__initializeGlobals` so it can access `__ctx`.
 */
export function partitionProgram(
  program: AgencyProgram,
  deps: PartitionDeps,
): ProgramPartition {
  const staticVarNames = new Set<string>();
  const exportedStaticVarNames = new Set<string>();
  const staticInitVars: InitVarSpec[] = [];
  const globalInitStatements: TsNode[] = [];
  const topLevelStatements: TsNode[] = [];
  const topLevelCallbackStatements: TsNode[] = [];

  // First pass: collect every same-module top-level static var name
  // and surface them via the optional callback BEFORE any RHS is
  // processed. Required so `processStaticInitValue` rewrites forward
  // references between statics correctly (`static const A = B + 1`
  // where B is declared further down). Cheap — only inspects each
  // node's shape, never recurses into expressions.
  for (const node of program.nodes) {
    const staticAssign = unwrapStaticAssignment(node);
    if (staticAssign) staticVarNames.add(staticAssign.stmt.variableName);
  }
  deps.onStaticVarNamesCollected?.(staticVarNames);

  for (const node of program.nodes) {
    if (isTopLevelCallbackCall(node)) {
      topLevelCallbackStatements.push(deps.processNodeInGlobalInit(node));
      continue;
    }

    const staticAssign = unwrapStaticAssignment(node);
    if (staticAssign) {
      const { stmt, handlerName } = staticAssign;
      // `staticVarNames` was already populated in the first pass —
      // skipping the redundant `.add()` here keeps the data flow
      // obvious (one writer per set).
      if (stmt.exported) exportedStaticVarNames.add(stmt.variableName);

      // Process the rhs inside a static-init context so reads of
      // imported / same-module top-level statics get rewritten to
      // `await __init_<dep>(__ctx)` (the getter cascade — see
      // `processStaticInitValue` docstring above).
      const valueNode = deps.processStaticInitValue(stmt.variableName, stmt.value);
      const frozenAssign = ts.assign(
        ts.id(stmt.variableName),
        ts.call(ts.id("__deepFreeze"), [valueNode]),
      );
      const assignStmt = handlerName
        ? ts.withHandler(deps.buildHandlerArrow(handlerName), frozenAssign)
        : frozenAssign;
      staticInitVars.push({
        varName: stmt.variableName,
        exported: !!stmt.exported,
        computeBody: [assignStmt, ts.return(ts.id(stmt.variableName))],
      });
      continue;
    }

    const globalAssign = unwrapGlobalAssignment(node);
    if (globalAssign) {
      const { stmt, handlerName } = globalAssign;
      const valueNode = deps.processNodeInGlobalInit(stmt.value);
      // These statements are emitted inside `__initializeGlobals(__ctx)`
      // (see buildInitializeGlobalsFn below). `__ctx` is the parameter
      // there — no ALS frame is installed by the caller — so pass the
      // lexical `__ctx` identifier as the receiver instead of letting
      // globalSet default to `getRuntimeContext().ctx`.
      const setNode = ts.globalSet(
        deps.moduleId,
        stmt.variableName,
        valueNode,
        ts.id("__ctx"),
      );
      globalInitStatements.push(
        handlerName
          ? ts.withHandler(deps.buildHandlerArrow(handlerName), setNode)
          : setNode,
      );
      continue;
    }

    // Bare top-level `<expr> with handler` (the form not caught by
    // `unwrapStaticAssignment` / `unwrapGlobalAssignment` because the
    // wrapped statement isn't an assignment). Without this branch, the
    // `withModifier` falls through to `processNodeInGlobalInit` →
    // `processNode` → `processWithModifier`, which calls
    // `stepPathTracker.currentId()` against an empty stack and throws
    // the cryptic internal invariant `StepPathTracker: currentId()
    // called with empty path` (issue #229). Emit the same lightweight
    // pushHandler/popHandler wrapper that the static/global assignment
    // cases above use — `withHandler` deliberately doesn't need a step
    // id, and `__initializeGlobals` already runs under
    // `runInBootstrapFrame(...)` so the handler stack is live. Resume
    // semantics match the rest of globalInit: this is a fresh-run
    // side effect, not re-executed on interrupt resume.
    if (node.type === "withModifier") {
      const innerStmt = deps.processNodeInGlobalInit(node.statement);
      globalInitStatements.push(
        ts.withHandler(deps.buildHandlerArrow(node.handlerName), innerStmt),
      );
      continue;
    }

    if (deps.isTopLevelDeclaration(node)) {
      topLevelStatements.push(deps.processNode(node));
    } else {
      // Top-level statements (function calls, etc.) need __ctx access,
      // so they live inside __initializeGlobals.
      globalInitStatements.push(deps.processNodeInGlobalInit(node));
    }
  }

  return {
    staticVarNames,
    exportedStaticVarNames,
    staticInitVars,
    globalInitStatements,
    topLevelStatements,
    topLevelCallbackStatements,
  };
}

/**
 * Detect a top-level statement that registers a callback via the stdlib
 * `callback(name, fn)` function. After the `liftCallbackBlocks`
 * preprocessor runs, block-form callbacks have already been rewritten
 * into named-fn calls of this shape, so this single shape covers both
 * source forms.
 *
 * Handler-wrapped top-level forms — `callback(...) with myHandler` and a
 * `handle { callback(...) } with (...)` block at module scope — are NOT
 * matched here. The `with`-modifier form is rejected at compile time by
 * `assertNoWrappedTopLevelCallbacks` in `liftCallbackBlocks` (it would
 * silently drop on resume). The `handle { ... }` form at module scope
 * is a pre-existing top-level-handle limitation that crashes the
 * typescriptBuilder via `StepPathTracker: currentId() called with empty
 * path`. Until top-level `handle` is supported, register top-level
 * callbacks at module scope without a wrapping handler, or move the
 * registration into a node body where the handle machinery works.
 */
function isTopLevelCallbackCall(node: AgencyNode): boolean {
  return node.type === "functionCall" && node.functionName === "callback";
}

/** If `node` is a `static x = ...` (optionally wrapped in `with handler`), return its parts. */
function unwrapStaticAssignment(node: AgencyNode):
  | { stmt: Extract<AgencyNode, { type: "assignment" }>; handlerName?: string }
  | null {
  if (node.type === "assignment" && node.scope === "static") {
    return { stmt: node };
  }
  if (
    node.type === "withModifier" &&
    node.statement.type === "assignment" &&
    node.statement.scope === "static"
  ) {
    return { stmt: node.statement, handlerName: node.handlerName };
  }
  return null;
}

/** If `node` is a `global x = ...` (optionally wrapped in `with handler`), return its parts. */
function unwrapGlobalAssignment(node: AgencyNode):
  | { stmt: Extract<AgencyNode, { type: "assignment" }>; handlerName?: string }
  | null {
  if (node.type === "assignment" && node.scope === "global") {
    return { stmt: node };
  }
  if (
    node.type === "withModifier" &&
    node.statement.type === "assignment" &&
    node.statement.scope === "global"
  ) {
    return { stmt: node.statement, handlerName: node.handlerName };
  }
  return null;
}

// ── Assemble ──

export type AssembleSectionsOpts = {
  moduleId: string;
  preprocess: TsNode[];
  importStatements: TsNode[];
  /** Raw string output of `generateImports()`. Already-rendered template. */
  generatedImports: string;
  /** Raw string output of `generateBuiltins()`. Already-rendered template. */
  generatedBuiltins: string;
  toolRegistrations: TsNode[];
  typeAliases: TsNode[];
  staticVarNames: Set<string>;
  exportedStaticVarNames: Set<string>;
  /**
   * Per-variable static init specs. Each spec becomes one `let X;` +
   * `const __init_X = __initVar(...)` pair plus an entry in
   * `__MY_INIT_GETTERS`. See {@link InitVarSpec} for the contract.
   */
  staticInitVars: InitVarSpec[];
  globalInitStatements: TsNode[];
  topLevelCallbackStatements: TsNode[];
  generatedStatements: TsNode[];
  postprocess: TsNode[];
  /** JSON-stringified source map, embedded into the generated module. */
  sourceMapJson: string;
};

/**
 * Concatenate the per-section outputs into the final generated module,
 * in the canonical order:
 *
 *   preprocess
 *   importStatements
 *   generated imports (template)
 *   generated builtins (template)
 *   tool registrations
 *   type aliases
 *   static-var let decls + per-var __init_X getters + __MY_INIT_GETTERS
 *     + __initializeStatic + __getStaticVars (always emitted; the
 *     no-statics case degrades to empty array + no-op for-loop)
 *   __runImperatives
 *   __initializeGlobals (backward-compat shim)
 *   __registerTopLevelCallbacks
 *   module self-registration with the init orchestrator
 *   generated statements
 *   postprocess
 *   __sourceMap export
 */
export function assembleSections(opts: AssembleSectionsOpts): TsNode {
  const sections: TsNode[] = [];

  sections.push(...opts.preprocess);

  if (opts.importStatements.length > 0) {
    sections.push(ts.statements(opts.importStatements));
  }

  if (opts.generatedImports.trim() !== "") {
    sections.push(ts.raw(opts.generatedImports));
  }

  if (opts.generatedBuiltins.trim() !== "") {
    sections.push(ts.raw(opts.generatedBuiltins));
  }

  if (opts.toolRegistrations.length > 0) {
    sections.push(ts.statements(opts.toolRegistrations));
  }

  for (const alias of opts.typeAliases) {
    sections.push(alias);
  }

  // Always emit (the no-statics case folds to `__MY_INIT_GETTERS = []`
  // + an empty for-loop). Skipping the `if (size > 0)` guard avoids a
  // useless special case and lets the entry orchestrator iterate
  // unconditionally.
  sections.push(...buildStaticVarSetup(opts));

  sections.push(buildRunImperativesFn(opts));

  sections.push(buildInitializeGlobalsFn(opts));

  sections.push(buildRegisterTopLevelCallbacksFn(opts));

  // Self-register with the cross-module orchestrator. This runs at
  // module-load time (a side effect of being ES-imported). ES module
  // loading is post-order DFS over static imports, so deps register
  // before their importers — exactly the order we want
  // `__getRegisteredModules` to yield for the entry-time orchestration.
  // The exported __moduleId / __initializeStatic / __runImperatives
  // are the only Agency-side contract the orchestrator depends on.
  sections.push(
    ts.raw(
      `__registerModule({ __moduleId: ${JSON.stringify(opts.moduleId)}, ` +
      `__initializeStatic, __runImperatives });`,
    ),
  );

  sections.push(ts.statements(opts.generatedStatements));

  if (opts.postprocess.length > 0) {
    sections.push(ts.statements(opts.postprocess));
  }

  sections.push(
    ts.raw(`export const __sourceMap = ${opts.sourceMapJson};`),
  );

  return ts.statements(sections);
}

/**
 * Emit (per the cross-module init-order design — see
 * `docs/superpowers/plans/2026-05-30-cross-module-init-order.md`):
 *
 *   [export] let x;          ←─── one per static var
 *   const __init_x = __initVar("modId:x", async (__ctx) => {
 *     x = __deepFreeze(<rewritten rhs>);
 *     return x;
 *   });
 *   ...
 *   export { __init_x, ... };  ←─── exported so cross-module init
 *                                   reads can `import { __init_x }`
 *                                   without leaking the value let
 *                                   binding name itself.
 *
 *   // IMPORTANT: sequential `for await` — DO NOT switch to
 *   // Promise.all (breaks trace/checkpoint replay determinism).
 *   const __MY_INIT_GETTERS = [__init_x, ...];
 *   async function __initializeStatic(__ctx) {
 *     for (const init of __MY_INIT_GETTERS) await init(__ctx);
 *     await __ctx.writeStaticStateToTrace(__getStaticVars());
 *   }
 *   function __getStaticVars() { return { x, … } }
 *   __globalCtx.getStaticVars = __getStaticVars;
 *
 * Always emitted; modules with zero statics still produce an empty
 * `__MY_INIT_GETTERS` and a no-op `__initializeStatic` so the
 * orchestrator can iterate without a presence check (drops the prior
 * `if (staticVarNames.size > 0)` guard).
 */
function buildStaticVarSetup(opts: AssembleSectionsOpts): TsNode[] {
  const out: TsNode[] = [];
  const ctxParam = ts.id("__ctx");

  // `let X` (or `export let X`) for every static. Source order; matches
  // the order they appear in `staticInitVars`. Always emitted (an
  // empty `ts.statements([])` is a no-op — no special case needed).
  const staticLetDecls = opts.staticInitVars.map((iv) =>
    iv.exported ? ts.export(ts.letDecl(iv.varName)) : ts.letDecl(iv.varName),
  );
  out.push(ts.statements(staticLetDecls));

  // Per-var getter pair:
  //   async function __init_X_compute(__ctx) { ...computeBody }
  //   const __init_X = __initVar("modId:X", __init_X_compute);
  //
  // We use a NAMED function declaration for the compute (not an
  // anonymous arrow) so V8's stack traces show `__init_X_compute`
  // frames at every level of a cyclic / cascading init chain. The
  // `__initVar` error message says "every frame named `__init_*` is
  // a participating variable" — that promise only holds if the
  // closures are actually named, which an anonymous arrow inside the
  // `__initVar` call expression is not.
  //
  // The compute body owns both assignment to the module-level `let X`
  // and returning the value, so callers awaiting __init_X get the
  // final populated value. Naming goes through `InitGetterRewriter`
  // so the convention has one owner.
  const initVarDecls: TsNode[] = [];
  for (const iv of opts.staticInitVars) {
    initVarDecls.push(
      ts.functionDecl(
        InitGetterRewriter.computeName(iv.varName),
        [{ name: "__ctx" }],
        ts.statements(iv.computeBody),
        { async: true },
      ),
      ts.constDecl(
        InitGetterRewriter.getterName(iv.varName),
        ts.call(ts.id("__initVar"), [
          ts.str(`${opts.moduleId}:${iv.varName}`),
          ts.id(InitGetterRewriter.computeName(iv.varName)),
        ]),
      ),
    );
  }
  out.push(ts.statements(initVarDecls));

  // Export the `__init_X` getters so importers can call them in their
  // own init contexts. Empty `export { };` is valid ES — no guard
  // needed.
  const exportList = opts.staticInitVars
    .map((iv) => InitGetterRewriter.getterName(iv.varName))
    .join(", ");
  out.push(ts.raw(`export { ${exportList} };`));

  // `__MY_INIT_GETTERS = [__init_A, __init_B, ...]`. Source-order
  // pinning — does NOT affect correctness (the cascade handles deps)
  // but does affect WHICH chain gets kicked off first by the
  // orchestrator. Deterministic order keeps trace/checkpoint replays
  // stable.
  out.push(
    ts.constDecl(
      "__MY_INIT_GETTERS",
      ts.arr(
        opts.staticInitVars.map((iv) =>
          ts.id(InitGetterRewriter.getterName(iv.varName)),
        ),
      ),
    ),
  );

  // `__initializeStatic`: sequential for-await over __MY_INIT_GETTERS.
  // IMPORTANT: keep this sequential — `Promise.all` would break trace
  // and checkpoint replay determinism (the order in which dep chains
  // get fired off varies otherwise).
  //
  // markInitialized is called BEFORE iterating the getters so that
  // function-mediated init reads work: a `static const X = computeX()`
  // where `computeX` is a top-level `def` would otherwise re-enter
  // `__initializeGlobals` via the lazy first-call init check at
  // `typescriptBuilder.ts:~1660` and deadlock on the in-flight
  // __init_X promise. Marking up front matches the pre-#232 design's
  // semantics: "this module's init has started; don't re-enter it
  // from below". The orchestrator guarantees Phase 2 (`__runImperatives`)
  // runs for every reachable module so global-init side effects still
  // happen even though the lazy-init check now short-circuits.
  const initStaticBody: TsNode[] = [
    ts.methodCall(
      ts.prop(ctxParam, "globals"),
      "markInitialized",
      [ts.str(opts.moduleId)],
    ),
    ts.forOf(
      "init",
      ts.id("__MY_INIT_GETTERS"),
      ts.await(ts.call(ts.id("init"), [ctxParam])),
    ),
  ];
  // Trace capture (once per module per fresh init cycle, as before).
  // `__initVar` memoization makes subsequent calls cheap, but we still
  // want one trace event per module to record the populated static
  // state.
  if (opts.staticInitVars.length > 0) {
    initStaticBody.push(
      ts.awaitMethodCall(ctxParam, "writeStaticStateToTrace", [
        ts.methodCall(ts.runtime.globalCtx, "getStaticVars"),
      ]),
    );
  }
  out.push(
    ts.functionDecl(
      "__initializeStatic",
      [{ name: "__ctx" }],
      ts.statements(initStaticBody),
      { async: true },
    ),
  );

  // `__getStaticVars` + `__globalCtx.getStaticVars` registration:
  // unchanged from the previous design. Used by the trace writer to
  // snapshot top-level statics on each init cycle.
  const staticVarObj = ts.obj(
    opts.staticInitVars.map((iv) => ts.set(iv.varName, ts.id(iv.varName))),
  );
  out.push(ts.statements([
    ts.functionDecl("__getStaticVars", [], ts.return(staticVarObj)),
    ts.assign(
      ts.prop(ts.runtime.globalCtx, "getStaticVars"),
      ts.id("__getStaticVars"),
    ),
  ]));

  return out;
}

/**
 * Emit:
 *   async function __runImperatives(__ctx) {
 *     …globalInitStatements   // top-level let X = expr → globals.set,
 *                             //   bare top-level calls, etc.
 *   }
 *
 * This is the second phase of init. Static-var population is in
 * `__initializeStatic`; imperative side effects live here so the
 * orchestrator can fan static init across every reachable module
 * BEFORE any imperative observes a potentially-undefined cross-module
 * static read. (See the inline phase-invariant comment in
 * `buildInitializeGlobalsFn` below.)
 *
 * NO idempotency guard inside this function — `markInitialized` lives
 * at the top of `__initializeStatic` instead (so the lazy first-call
 * check at function entry short-circuits without ever calling
 * `__runImperatives` twice for the same execCtx). The orchestrator
 * (`__initializeGlobals`) is the single-flight caller, and it fires
 * at most once per execCtx — re-entering `__runImperatives` outside
 * that orchestrator would re-run side effects.
 */
function buildRunImperativesFn(opts: AssembleSectionsOpts): TsNode {
  void opts.moduleId; // satisfies eslint; opts.moduleId not needed here
  return ts.functionDecl(
    "__runImperatives",
    [{ name: "__ctx" }],
    ts.statements(opts.globalInitStatements),
    { async: true },
  );
}

/**
 * Emit:
 *   async function __initializeGlobals(__ctx) {
 *     // === Init phase invariant ===
 *     // Phase 1 (all modules' __initializeStatic) MUST fully complete
 *     // before Phase 2 (all modules' __runImperatives) begins on ANY
 *     // module. Top-level imperatives may read static/global values
 *     // declared in OTHER modules; those must be populated before any
 *     // imperative anywhere observes them. Interleaving phases per
 *     // module (or inlining a Phase-2 step into Phase 1) WILL
 *     // re-introduce the cross-module-undefined bug this subsystem
 *     // exists to prevent (#232).
 *     // ============================
 *     const registered = __getRegisteredModules();
 *     for (const mod of registered) await mod.__initializeStatic(__ctx);
 *     for (const mod of registered) await mod.__runImperatives(__ctx);
 *   }
 *
 * Kept as a single function so the existing callers continue to work
 * unchanged:
 *   - The lazy first-call init at `typescriptBuilder.ts:~1502`
 *     (`if (!__ctx.globals.isInitialized(...)) await __initializeGlobals(...)`)
 *     fires when any node in this module starts.
 *   - `runtime/interrupts.ts` and `runtime/rewind.ts` call
 *     `__initializeGlobals` on resume; `__initVar` memoization +
 *     `globals.isInitialized` idempotency make this free on second+
 *     invocations.
 *   - The eager docstring-interpolation path at `typescriptBuilder.ts:~3326`
 *     also still works — the shim runs both phases.
 *
 * `__initializeGlobals` does NOT mark this module as initialized
 * directly. Per-module marking happens at the TOP of each module's
 * `__initializeStatic` (see `buildStaticVarSetup`) — placed there so
 * that function-mediated init reads (a `static const X = computeX()`
 * where `computeX` is a top-level `def`) cannot re-enter
 * `__initializeGlobals` via the lazy first-call check and deadlock
 * on the in-flight `__init_X` promise. Marking up front also gives
 * fresh callers driving in via any entry point the same per-module
 * idempotency.
 */
function buildInitializeGlobalsFn(opts: AssembleSectionsOpts): TsNode {
  // Inside this function body `__ctx` is the parameter (no ALS frame
  // installed by the caller), so every receiver must be `ts.id("__ctx")`
  // — NOT `ts.runtime.ctx` (which is now the `__ctx()` accessor and
  // would read from ALS instead of the parameter).
  const ctxParam = ts.id("__ctx");
  const body: TsNode[] = [
    ts.constDecl("__registered", ts.call(ts.id("__getRegisteredModules"), [])),
    // Phase 1: every registered module's static phase. Each module's
    // __initializeStatic iterates __MY_INIT_GETTERS sequentially; the
    // per-var getters cascade through their deps via inline awaits.
    // Memoization in __initVar makes redundant calls free.
    ts.forOf(
      "mod",
      ts.id("__registered"),
      ts.awaitMethodCall(ts.id("mod"), "__initializeStatic", [ctxParam]),
    ),
    // Phase 2: every registered module's top-level imperative
    // statements, in import order. IMPORTANT: sequential for-await —
    // DO NOT switch to Promise.all (breaks trace/checkpoint replay
    // determinism, AND breaks the phase invariant if any Promise.all
    // entry resolves before another).
    ts.forOf(
      "mod",
      ts.id("__registered"),
      ts.awaitMethodCall(ts.id("mod"), "__runImperatives", [ctxParam]),
    ),
  ];
  // Reference opts.moduleId / opts.staticInitVars to keep eslint happy
  // about the unused parameter (the moduleId is consumed indirectly
  // via __runImperatives' own markInitialized call).
  void opts.moduleId;
  void opts.staticInitVars;
  return ts.functionDecl(
    "__initializeGlobals",
    [{ name: "__ctx" }],
    ts.statements(body),
    { async: true },
  );
}

/**
 * Emit:
 *   async function __registerTopLevelCallbacks(__ctx) {
 *     __ctx.topLevelCallbacks = []
 *     …topLevelCallbackStatements
 *   }
 *
 * The body clears any previously-registered top-level callbacks before
 * re-registering so this is safe to call on every fresh run and every
 * resume without accumulating duplicate registrations across restores.
 * Always emitted (even when empty) so the calling runtime can call it
 * unconditionally — generated modules don't have to detect the no-op
 * case.
 */
function buildRegisterTopLevelCallbacksFn(opts: AssembleSectionsOpts): TsNode {
  // Same parameter-context rule as buildInitializeGlobalsFn — `__ctx`
  // here is the function parameter, not an ALS-installed value.
  const body: TsNode[] = [
    ts.assign(
      ts.prop(ts.id("__ctx"), "topLevelCallbacks"),
      ts.arr([]),
    ),
    ...opts.topLevelCallbackStatements,
  ];
  return ts.functionDecl(
    "__registerTopLevelCallbacks",
    [{ name: "__ctx" }],
    ts.statements(body),
    { async: true },
  );
}
