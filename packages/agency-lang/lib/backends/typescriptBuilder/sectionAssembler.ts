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
  const staticInitStatements: TsNode[] = [];
  const globalInitStatements: TsNode[] = [];
  const topLevelStatements: TsNode[] = [];

  // Pre-scan imports: names imported from JS modules (anything that is
  // NOT an agency import — no `.agency` suffix, no `std::`, no `pkg::`)
  // are eagerly initialized at JS-module-load time. That means a static
  // const that just aliases one of these names (e.g.
  // `export static const min = _min`) can be hoisted to a direct
  // top-level `const` instead of going through the async __initializeStatic
  // ceremony, which is important so that downstream modules see the
  // binding as defined at THEIR load time (e.g. inside an `__agency_descriptor`
  // literal). Aliases of agency-module-imported names stay on the lazy
  // path because those sources themselves init lazily.
  const jsImportedNames = collectJsImportedNames(program);

  for (const node of program.nodes) {
    const staticAssign = unwrapStaticAssignment(node);
    if (staticAssign) {
      const { stmt, handlerName } = staticAssign;

      // Hoist trivial JS-import aliases out of __initializeStatic so they
      // are bound at module-load time (see comment above).
      if (
        !handlerName &&
        stmt.value &&
        (stmt.value as { type?: string }).type === "variableName" &&
        jsImportedNames.has((stmt.value as { value: string }).value)
      ) {
        const valueNode = deps.processNodeInGlobalInit(stmt.value);
        const decl = ts.constDecl(stmt.variableName, valueNode);
        topLevelStatements.push(stmt.exported ? ts.export(decl) : decl);
        continue;
      }

      staticVarNames.add(stmt.variableName);
      if (stmt.exported) exportedStaticVarNames.add(stmt.variableName);

      const valueNode = deps.processNodeInGlobalInit(stmt.value);
      const frozenAssign = ts.assign(
        ts.id(stmt.variableName),
        ts.call(ts.id("__deepFreeze"), [valueNode]),
      );
      staticInitStatements.push(
        handlerName
          ? ts.withHandler(deps.buildHandlerArrow(handlerName), frozenAssign)
          : frozenAssign,
      );
      continue;
    }

    const globalAssign = unwrapGlobalAssignment(node);
    if (globalAssign) {
      const { stmt, handlerName } = globalAssign;
      const valueNode = deps.processNodeInGlobalInit(stmt.value);
      const setNode = ts.globalSet(deps.moduleId, stmt.variableName, valueNode);
      globalInitStatements.push(
        handlerName
          ? ts.withHandler(deps.buildHandlerArrow(handlerName), setNode)
          : setNode,
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
    staticInitStatements,
    globalInitStatements,
    topLevelStatements,
  };
}

/**
 * Collect the local names of every plain `import { … }` statement that
 * pulls from a non-agency module (i.e. a plain JS / TS file, not an
 * `.agency`, `std::`, or `pkg::` source). These bindings exist as soon
 * as the JS module is evaluated, so a `static const x = importedName`
 * alias can be hoisted to a direct top-level `const` declaration
 * instead of going through the lazy `__initializeStatic` ceremony.
 */
function collectJsImportedNames(program: AgencyProgram): Set<string> {
  const out = new Set<string>();
  for (const node of program.nodes) {
    if (node.type !== "importStatement") continue;
    const stmt = node as Extract<AgencyNode, { type: "importStatement" }>;
    if (stmt.isAgencyImport) continue;
    for (const entry of stmt.importedNames) {
      if (entry.type === "namedImport") {
        for (const name of entry.importedNames) {
          out.add(entry.aliases[name] ?? name);
        }
      } else if (
        entry.type === "namespaceImport" ||
        entry.type === "defaultImport"
      ) {
        out.add(entry.importedNames);
      }
    }
  }
  return out;
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

  if (opts.staticVarNames.size > 0) {
    sections.push(...buildStaticVarSetup(opts));
  }

  sections.push(buildInitializeGlobalsFn(opts));

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
  const staticLetDecls = [...opts.staticVarNames].map((name) =>
    opts.exportedStaticVarNames.has(name)
      ? ts.export(ts.letDecl(name))
      : ts.letDecl(name),
  );

  out.push(ts.statements([
    ts.letDecl("__staticInitPromise", ts.raw("null")),
    ...staticLetDecls,
  ]));

  // Promise-based guard: concurrent callers await the same init promise.
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
          ts.iife({ async: true, body: opts.staticInitStatements }),
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
  const body: TsNode[] = [
    // Mark this module as initialized BEFORE running init statements.
    // This prevents infinite recursion when a global init expression
    // calls a function defined in the same module (which would trigger
    // __initializeGlobals again via the isInitialized check).
    ts.methodCall(
      ts.prop(ts.runtime.ctx, "globals"),
      "markInitialized",
      [ts.str(opts.moduleId)],
    ),
  ];

  if (opts.staticVarNames.size > 0) {
    body.push(
      ts.awaitCall(ts.id("__initializeStatic"), [ts.runtime.ctx]),
      ts.awaitMethodCall(ts.runtime.ctx, "writeStaticStateToTrace", [
        ts.methodCall(ts.runtime.globalCtx, "getStaticVars"),
      ]),
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
