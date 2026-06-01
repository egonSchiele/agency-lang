import type { AgencyNode, AgencyProgram } from "../../types.js";
import type { TsNode } from "../../ir/tsIR.js";
import { ts } from "../../ir/builders.js";

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
  buildHandlerArrow: (handlerName: string) => TsNode;
  isTopLevelDeclaration: (node: AgencyNode) => boolean;
  moduleId: string;
  /**
   * Optional per-phase initialization plan from `compileClosure`. When
   * present, local var assignments are emitted in `localOrder` rather
   * than source order, ensuring cross-module dependencies (Example 1
   * from `agent-init-design.md`) resolve before reads. Bare top-level
   * statements stay in source order.
   *
   * When absent (legacy callers that bypass `compileClosure`), partition
   * falls back to source order. The lazy isInitialized guards remain the
   * safety net for that path.
   */
  staticOrder?: string[];
  globalOrder?: string[];
};

export type ProgramPartition = {
  /** Names of `static` variables declared at module level. */
  staticVarNames: Set<string>;
  /** Subset of `staticVarNames` that are `export`-ed. */
  exportedStaticVarNames: Set<string>;
  /** Statements that initialize static variables, run once. */
  staticInitStatements: TsNode[];
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
  // Tag each init statement with its var name (null = bare/anonymous)
  // so the partition can optionally reorder per the topsort plan
  // without re-walking the AST. Bare statements keep source order
  // because they have no name to key on.
  const staticInitTagged: { varName: string | null; node: TsNode }[] = [];
  const globalInitTagged: { varName: string | null; node: TsNode }[] = [];
  const topLevelStatements: TsNode[] = [];
  const topLevelCallbackStatements: TsNode[] = [];

  for (const node of program.nodes) {
    if (isTopLevelCallbackCall(node)) {
      topLevelCallbackStatements.push(deps.processNodeInGlobalInit(node));
      continue;
    }

    const staticAssign = unwrapStaticAssignment(node);
    if (staticAssign) {
      const { stmt, handlerName } = staticAssign;
      staticVarNames.add(stmt.variableName);
      if (stmt.exported) exportedStaticVarNames.add(stmt.variableName);

      const valueNode = deps.processNodeInGlobalInit(stmt.value);
      const frozenAssign = ts.assign(
        ts.id(stmt.variableName),
        ts.call(ts.id("__deepFreeze"), [valueNode]),
      );
      staticInitTagged.push({
        varName: stmt.variableName,
        node: handlerName
          ? ts.withHandler(deps.buildHandlerArrow(handlerName), frozenAssign)
          : frozenAssign,
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
      globalInitTagged.push({
        varName: stmt.variableName,
        node: handlerName
          ? ts.withHandler(deps.buildHandlerArrow(handlerName), setNode)
          : setNode,
      });
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
      globalInitTagged.push({
        varName: null,
        node: ts.withHandler(deps.buildHandlerArrow(node.handlerName), innerStmt),
      });
      continue;
    }

    if (deps.isTopLevelDeclaration(node)) {
      topLevelStatements.push(deps.processNode(node));
    } else {
      // Top-level statements (function calls, etc.) need __ctx access,
      // so they live inside __initializeGlobals.
      globalInitTagged.push({
        varName: null,
        node: deps.processNodeInGlobalInit(node),
      });
    }
  }

  return {
    staticVarNames,
    exportedStaticVarNames,
    staticInitStatements: reorderTagged(staticInitTagged, deps.staticOrder),
    globalInitStatements: reorderTagged(globalInitTagged, deps.globalOrder),
    topLevelStatements,
    topLevelCallbackStatements,
  };
}

/**
 * Apply the topsort plan's `localOrder` to tagged init statements.
 *
 * Bare (unnamed) statements are anchored to their source position —
 * each occupies exactly the slot where it originally appeared. Named
 * statements are reordered per the plan, with the k-th name in
 * `localOrder` filling the k-th named slot in source order. This
 * preserves side-effect ordering for patterns like `foo(); const x =
 * ...; bar();` while still letting topsort sequence the named decls.
 *
 * No plan → source order, unchanged.
 */
function reorderTagged(
  tagged: { varName: string | null; node: TsNode }[],
  order: string[] | undefined,
): TsNode[] {
  if (!order || order.length === 0) {
    return tagged.map((t) => t.node);
  }
  const byName: Record<string, TsNode> = {};
  for (const { varName, node } of tagged) {
    if (varName) byName[varName] = node;
  }
  // Walk tagged once. Bare slots emit their own node immediately.
  // Named slots are placeholders to be filled from `order` in
  // top-to-bottom order — only names that have a matching tagged
  // node count, so cross-module-only names in `order` are skipped.
  const planNamesInTagged = order.filter((n) => byName[n]);
  const out: TsNode[] = [];
  let namedSlotIdx = 0;
  for (const { varName, node } of tagged) {
    if (varName) {
      const fillName = planNamesInTagged[namedSlotIdx++];
      if (fillName) out.push(byName[fillName]!);
    } else {
      out.push(node);
    }
  }
  return out;
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
  staticInitStatements: TsNode[];
  globalInitStatements: TsNode[];
  topLevelCallbackStatements: TsNode[];
  generatedStatements: TsNode[];
  postprocess: TsNode[];
  /** JSON-stringified source map, embedded into the generated module. */
  sourceMapJson: string;
  /**
   * Per-phase cross-module dependencies sourced from the topsort plan.
   * For each entry, the generated `__initializeStatic` /
   * `__initializeGlobals` body awaits the corresponding function on
   * that source module before running its own assignments. Together with
   * `reorderTagged` (which orders local statements by topsort) this is
   * what makes Example 1 (`fooStatic = barStatic + "!"`) yield "hello!"
   * instead of throwing the read-before-init trap.
   *
   * Empty / absent when the legacy callers bypass `compileClosure`.
   */
  staticAwaitModules?: { localImport: string; sourceModuleId: string }[];
  globalAwaitModules?: { localImport: string; sourceModuleId: string }[];
  /**
   * Absolute moduleId used as the registry key for
   * `__registerStaticInit` / `__registerGlobalsInit`. Falls back to
   * `moduleId` when the plan didn't supply one (legacy callers); in
   * that case cross-module awaits won't find this module's init in the
   * registry, but the lazy isInitialized guard still keeps things
   * correct for same-module flows.
   */
  registryModuleId?: string;
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
 *   static-var declarations + __initializeStatic + __getStaticVars (if any)
 *   __initializeGlobals
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

  // Registry id is the absolute path; matches the `sourceModuleId`
  // other modules' `awaitModules` carry. Fall back to `opts.moduleId`
  // (cwd-relative) when no plan provided — that path won't get
  // cross-module awaits, but local init still works.
  const registryId = opts.registryModuleId ?? opts.moduleId;

  if (opts.staticVarNames.size > 0) {
    sections.push(...buildStaticVarSetup(opts));
    // Register this module's static-init under its absolute moduleId
    // so other modules can `await __awaitStaticInit(...)` it. Only
    // needed when the module actually has statics — otherwise nobody
    // will look it up.
    sections.push(
      ts.raw(
        `__registerStaticInit(${JSON.stringify(registryId)}, __initializeStatic);`,
      ),
    );
  }

  sections.push(buildInitializeGlobalsFn(opts));
  // Same idea for globals init.
  sections.push(
    ts.raw(
      `__registerGlobalsInit(${JSON.stringify(registryId)}, __initializeGlobals);`,
    ),
  );

  sections.push(buildRegisterTopLevelCallbacksFn(opts));

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
 * Emit:
 *   let __staticInitPromise = null
 *   [export] let x        ←─── one per static var
 *   async function __initializeStatic(__ctx) {
 *     if (__staticInitPromise) return __staticInitPromise
 *     __staticInitPromise = (async () => { …staticInitStatements })()
 *     return __staticInitPromise
 *   }
 *   function __getStaticVars() { return { x, … } }
 *   __globalCtx.getStaticVars = __getStaticVars;
 */
function buildStaticVarSetup(opts: AssembleSectionsOpts): TsNode[] {
  const out: TsNode[] = [];
  // Initialize each static `let` to the sentinel `__UNINIT_STATIC`
  // so that any read of the variable before its initializer has run
  // is caught by the `__readStatic` wrapper (emitted around static
  // reads by the pretty-printer). Without this initializer the
  // binding would be `undefined`, which collides with legitimate user
  // values and produced silent bugs like `fooStatic = barStatic + "!"`
  // evaluating to `"undefined!"` when bar's init had not yet run.
  const sentinel = ts.id("__UNINIT_STATIC");
  const staticLetDecls = [...opts.staticVarNames].map((name) =>
    opts.exportedStaticVarNames.has(name)
      ? ts.export(ts.letDecl(name, sentinel))
      : ts.letDecl(name, sentinel),
  );

  out.push(ts.statements([
    ts.letDecl("__staticInitPromise", ts.raw("null")),
    ...staticLetDecls,
  ]));

  // Promise-based guard: concurrent callers await the same init promise.
  // Body starts with awaits on any modules whose statics are
  // referenced by this module's static initializers — topsort guarantees
  // those dependencies have no cycles, so the await chain terminates.
  // Local assignments then run in topsort-order (sectionAssembler's
  // `reorderTagged` did that ordering during partition).
  const awaitPrelude = (opts.staticAwaitModules ?? []).map((m) =>
    ts.raw(
      `await __awaitStaticInit(${JSON.stringify(m.sourceModuleId)}, __ctx);`,
    ),
  );
  out.push(
    ts.functionDecl(
      "__initializeStatic",
      [{ name: "__ctx" }],
      ts.statements([
        ts.if(
          ts.id("__staticInitPromise"),
          ts.return(ts.id("__staticInitPromise")),
        ),
        ts.assign(
          ts.id("__staticInitPromise"),
          ts.iife({
            async: true,
            body: [...awaitPrelude, ...opts.staticInitStatements],
          }),
        ),
        ts.return(ts.id("__staticInitPromise")),
      ]),
      { async: true },
    ),
  );

  const staticVarObj = ts.obj(
    [...opts.staticVarNames].map((n) => ts.set(n, ts.id(n))),
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
 *   async function __initializeGlobals(__ctx) {
 *     __ctx.globals.markInitialized(moduleId)
 *     [await __initializeStatic(__ctx)]  ← only if there are static vars
 *     [await __ctx.writeStaticStateToTrace(__globalCtx.getStaticVars())]
 *     …globalInitStatements
 *   }
 */
function buildInitializeGlobalsFn(opts: AssembleSectionsOpts): TsNode {
  // Inside this function body `__ctx` is the parameter (no ALS frame
  // installed by the caller), so every receiver must be `ts.id("__ctx")`
  // — NOT `ts.runtime.ctx` (which is now the `__ctx()` accessor and
  // would read from ALS instead of the parameter).
  const ctxParam = ts.id("__ctx");
  const body: TsNode[] = [
    // Mark this module as initialized BEFORE running init statements.
    // This prevents infinite recursion when a global init expression
    // calls a function defined in the same module (which would trigger
    // __initializeGlobals again via the isInitialized check).
    ts.methodCall(
      ts.prop(ctxParam, "globals"),
      "markInitialized",
      [ts.str(opts.moduleId)],
    ),
  ];

  if (opts.staticVarNames.size > 0) {
    body.push(
      ts.awaitCall(ts.id("__initializeStatic"), [ctxParam]),
      ts.awaitMethodCall(ctxParam, "writeStaticStateToTrace", [
        ts.methodCall(ts.runtime.globalCtx, "getStaticVars"),
      ]),
    );
  }

  // Await per-phase imported modules' globals init. Same logic as the
  // static prelude — topsort guarantees no cycles among the awaits.
  for (const m of opts.globalAwaitModules ?? []) {
    body.push(
      ts.raw(
        `await __awaitGlobalsInit(${JSON.stringify(m.sourceModuleId)}, __ctx);`,
      ),
    );
  }

  body.push(...opts.globalInitStatements);

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
