/**
 * Single owner of multi-file compilation. Parses every reachable agency
 * file from an entry, builds a shared SymbolTable, runs the per-variable
 * dep graphs (static + global) plus topological sort, and produces an
 * `InitPlan` per module that codegen consumes to drive its centralized
 * init.
 *
 * Both `lib/cli/commands.ts:compile()` (CLI: writes files to disk) and
 * `lib/compiler/compile.ts:compileSource()` (in-memory: returns a string)
 * call this helper, then walk the result's modules and codegen each. The
 * recursive `compile()` cascade that used to re-enter per file is gone —
 * the closure is built once, in one place.
 *
 * Errors surface as exceptions of type `CompileClosureError`. The CLI
 * path turns them into stderr + `process.exit(1)`; the in-memory path
 * returns them as `CompileFailure`.
 */

import * as fs from "fs";
import * as path from "path";
import type { AgencyProgram, AgencyNode } from "../types.js";
import { AgencyConfig } from "../config.js";
import { parseAgencyFileCached } from "../parseCache.js";
import { SymbolTable } from "../symbolTable.js";
import { resolveReExports } from "../preprocessors/resolveReExports.js";
import {
  buildInitDepGraphs,
  collectDirectCalls,
  collectFreeIdentifiers,
  collectFunctionBodyFreeRefs,
  makeKey,
  type FunctionDefLookup,
  type ImportAliasResolver,
  type InitDepGraph,
  type InitVarNode,
  StaticReferencesGlobalError,
} from "./initDepGraph.js";
import { topSortInitGraph, type CycleError } from "./topSortInitGraph.js";
import {
  isNonTemplatedStdlib,
  isAgencyImport,
  isPkgImport,
  isStdlibImport,
  resolveAgencyImportPath,
} from "../importPaths.js";

export class CompileClosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileClosureError";
  }
}

/**
 * The per-module init plan codegen consumes. For Phase A (static) and
 * Phase B (global), captures:
 *   - `localOrder`: the topsort-ordered subset of local var names in
 *     this module. Codegen emits assignments in this order rather than
 *     source order.
 *   - `awaitModules`: other modules whose init must complete before
 *     this module's local init body runs. Computed from cross-module
 *     edges in the dep graph. Codegen emits an `await
 *     <importedModule>.__initializeStatic(ctx)` at the head of this
 *     module's `__initializeStatic` for each entry.
 */
export type ModuleInitPhasePlan = {
  localOrder: string[];
  awaitModules: string[];
};

export type ModuleInitPlan = {
  moduleId: string;
  static: ModuleInitPhasePlan;
  global: ModuleInitPhasePlan;
};

export type CompiledClosure = {
  /** Map from absolute module path to parsed program. */
  programs: Record<string, AgencyProgram>;
  /** Shared symbol table for the entire closure. */
  symbolTable: SymbolTable;
  /** The entry module's absolute path. */
  entryModuleId: string;
  /** Static dep graph (Phase A). */
  staticGraph: InitDepGraph;
  /** Global dep graph (Phase B). */
  globalGraph: InitDepGraph;
  /** Resolver used by codegen for PR-1 thread-through. */
  resolver: ImportAliasResolver;
  /** Topsort-derived per-module init plans. Keyed by moduleId. */
  plans: Record<string, ModuleInitPlan>;
};

/**
 * Parse + analyze the entry's full import closure. Throws
 * `CompileClosureError` for parse failures, cycle errors, or
 * static-references-global violations. The caller decides how to
 * surface the error (CLI: exit; in-memory: collect).
 */
export function buildCompiledClosure(
  entryFile: string | string[],
  config: AgencyConfig,
): CompiledClosure {
  // Accept one entry (the common single-file compile) or many (a whole
  // directory). With many, the closure covers the union of every entry's
  // imports, so shared modules are analyzed once instead of once per
  // entry. `entryModuleId` is kept as metadata (the first entry); the dep
  // graph derives everything it needs from `programs`, which holds the
  // full union regardless of which entry rooted it.
  const entryFiles = (Array.isArray(entryFile) ? entryFile : [entryFile]).map(
    (f) => path.resolve(f),
  );
  const entryModuleId = entryFiles[0];
  // SymbolTable must come first: it's the source of truth for re-export
  // relationships, and parseClosure needs it to expand each parsed file
  // via `resolveReExports` so the dep graph sees synthesized wrapper
  // statics (`static const x = _reexport_x`) at re-exporters. Without
  // that, re-export chains like a→b→c produce wrappers in a.js / b.js
  // whose `__initializeStatic` never gets awaited because the dep graph
  // collapses straight to c.
  const symbolTable = SymbolTable.build(entryFiles, config);
  const programs = parseClosure(entryFiles, config, symbolTable);

  let staticGraph: InitDepGraph;
  let globalGraph: InitDepGraph;
  let resolver: ImportAliasResolver;
  let functionDefs: FunctionDefLookup;
  try {
    const r = buildInitDepGraphs(programs, symbolTable, entryModuleId);
    staticGraph = r.staticGraph;
    globalGraph = r.globalGraph;
    resolver = r.resolver;
    functionDefs = r.functionDefs;
  } catch (e) {
    // Re-throw analysis-time validation errors (currently only
    // `StaticReferencesGlobalError`) under the closure-error banner so
    // call sites have a single error type to catch.
    if (e instanceof StaticReferencesGlobalError) {
      throw new CompileClosureError(e.message);
    }
    throw e;
  }

  const staticOrder = sortOrThrow(staticGraph, "static");
  const globalOrder = sortOrThrow(globalGraph, "global");

  // Reject intra-file use-before-def in either phase. Same-file named
  // decls whose plan order disagrees with source order would otherwise
  // be silently reordered by the section assembler — that is a
  // surprising behavior for users reading top-to-bottom. Cross-file
  // reorder is still allowed (there is no canonical "source order"
  // across files).
  assertNoIntraFileUseBeforeDef(
    Object.keys(programs),
    staticGraph,
    staticOrder,
    "static",
    symbolTable,
  );
  assertNoIntraFileUseBeforeDef(
    Object.keys(programs),
    globalGraph,
    globalOrder,
    "global",
    symbolTable,
  );

  const plans = buildPlans(
    Object.keys(programs),
    staticGraph,
    staticOrder,
    globalGraph,
    globalOrder,
    resolver,
    functionDefs,
  );

  return {
    programs,
    symbolTable,
    entryModuleId,
    staticGraph,
    globalGraph,
    resolver,
    plans,
  };
}

/**
 * BFS the entry's full agency-import closure. Parses each file once.
 * Stdlib (`std::...`) and pkg (`pkg::...`) imports skipped — the
 * dep-graph machinery only cares about user-controlled .agency files.
 * Non-agency imports (.js/.ts) are likewise out of scope.
 *
 * Parse failures throw `CompileClosureError` with the path + message;
 * callers translate that into their preferred surface.
 */
function parseClosure(
  entryModuleIds: string[],
  config: AgencyConfig,
  symbolTable: SymbolTable,
): Record<string, AgencyProgram> {
  // Two-phase: parse raw to discover the closure (raw still carries
  // `exportFromStatement` nodes that the closure walker needs to follow
  // re-export chains), then expand each parsed program with
  // `resolveReExports` so the dep-graph builder sees synthesized wrapper
  // statics. Order matters — `resolveReExports` strips
  // `exportFromStatement` nodes, so doing it before closure-walking
  // would lose re-export edges.
  const raw: Record<string, AgencyProgram> = {};
  const visited: Record<string, true> = {};
  const queue: string[] = [...entryModuleIds];

  while (queue.length > 0) {
    const moduleId = queue.shift()!;
    if (visited[moduleId]) continue;
    visited[moduleId] = true;

    const { program, importTargets } = loadModule(moduleId, config);
    raw[moduleId] = program;

    for (const target of importTargets) {
      if (!visited[target]) queue.push(target);
    }
  }

  const out: Record<string, AgencyProgram> = {};
  for (const [moduleId, program] of Object.entries(raw)) {
    out[moduleId] = resolveReExports(program, symbolTable, moduleId);
  }
  return out;
}

/**
 * Read + parse one .agency module and report its agency-import
 * targets. Module-private: kept inside `compileClosure.ts` until a
 * second caller appears (PR 5's `agency explain-init` is the planned
 * client). Exporting prematurely would freeze the signature before the
 * second caller has a chance to drive its shape.
 *
 * The non-templated stdlib carve-out (skip template application for
 * `index.agency` / `array.agency`, via `isNonTemplatedStdlib`) is applied
 * here because it's a per-file decision both phases of closure walking —
 * and any future one-off loader — need.
 */
function loadModule(
  moduleId: string,
  config: AgencyConfig,
): { program: AgencyProgram; importTargets: string[] } {
  if (!fs.existsSync(moduleId)) {
    throw new CompileClosureError(
      `Error: Input file '${moduleId}' not found`,
    );
  }
  const applyTemplate = !isNonTemplatedStdlib(moduleId);
  const result = parseAgencyFileCached(moduleId, config, applyTemplate);
  if (!result.success) {
    throw new CompileClosureError(
      `Failed to parse ${moduleId}: ${result.message ?? "unknown parse error"}`,
    );
  }
  return {
    program: result.result,
    importTargets: agencyImportTargets(result.result, moduleId),
  };
}

export function agencyImportTargets(
  program: AgencyProgram,
  moduleId: string,
): string[] {
  const out: string[] = [];
  for (const node of program.nodes) {
    const target = agencyImportTarget(node);
    if (!target) continue;
    if (isStdlibImport(target) || isPkgImport(target)) continue;
    if (!isAgencyImport(target)) continue;
    out.push(resolveAgencyImportPath(target, moduleId));
  }
  return out;
}

function agencyImportTarget(node: AgencyNode): string | null {
  if (node.type === "importStatement") return node.modulePath;
  if (node.type === "importNodeStatement") return node.agencyFile;
  if (node.type === "exportFromStatement") return node.modulePath;
  return null;
}

/**
 * True when the program has any pkg:: import edge. Routed through the
 * SAME extraction as the closure walker (agencyImportTarget), which
 * recognizes importStatement, importNodeStatement, AND
 * exportFromStatement — a hand-rolled importStatement-only scan would let
 * `export { x } from "pkg::…"` escape the incremental-build never-skip.
 * One source of truth for "what is an import edge".
 */
export function programHasPkgImport(program: AgencyProgram): boolean {
  for (const node of program.nodes) {
    const target = agencyImportTarget(node);
    if (target !== null && isPkgImport(target)) {
      return true;
    }
  }
  return false;
}

/**
 * Reject same-file, named, user-authored decls whose plan order
 * disagrees with source order. Walks each module's projection of the
 * plan order in order; the first pair `(prev, cur)` where
 * `cur.loc.line < prev.loc.line` is the use-before-def. The earlier
 * line in source consumed a value defined at the later line — silent
 * reordering would hide that.
 *
 * Excluded from the check:
 *   - bare statements (synthetic `__bareStmt_*` names): they're anchored
 *     by the section assembler to their source position; topsort never
 *     moves them, so they can't trigger a false positive.
 *   - re-export wrapper statics (synthesized by `resolveReExports` —
 *     `static const x = _reexport_x`): identified via the
 *     `reExportedFrom` marker SymbolTable sets when the importing
 *     module's `export { x } from "..."` was resolved. The wrapper has
 *     no user-controlled source position the user could reorder, and
 *     the section assembler is free to slot it in dep-first order.
 *
 * Applies separately to the static and global graphs (same as cycle
 * detection): a static use-before-def and a global use-before-def are
 * independent violations.
 */
function assertNoIntraFileUseBeforeDef(
  moduleIds: string[],
  graph: InitDepGraph,
  order: string[],
  phaseName: "static" | "global",
  symbolTable: SymbolTable,
): void {
  for (const moduleId of moduleIds) {
    let prev: InitVarNode | null = null;
    for (const key of order) {
      const node = graph.nodes[key];
      if (!node || node.moduleId !== moduleId) continue;
      if (node.varName.startsWith("__bareStmt_")) continue;
      if (isReExportWrapper(node, symbolTable)) continue;
      const curLine = node.loc?.line ?? 0;
      const prevLine = prev?.loc?.line ?? 0;
      if (prev && curLine < prevLine) {
        // `prev` is the dep (defined later in source, earlier in plan).
        // `node` is the consumer (defined earlier in source, later in
        // plan). The user-facing message attributes the violation to
        // the consumer, since that's the line the user can directly
        // see is "wrong."
        const fileName = path.basename(moduleId);
        throw new CompileClosureError(
          `Error: ${capitalize(phaseName)} '${node.varName}' (${fileName}:${curLine}) references '${prev.varName}' (${fileName}:${prevLine}) which is declared later in the same file.\n` +
            `Reorder the declarations so '${prev.varName}' appears before '${node.varName}'.`,
        );
      }
      prev = node;
    }
  }
}

/**
 * True for the synthetic constant wrappers `resolveReExports` emits at
 * re-exporting modules (`static const x = _reexport_x`). The check
 * goes through `SymbolTable` rather than the wrapper's right-hand-side
 * shape because `_reexport_` is not a reserved language prefix — user
 * code could in principle write `static const x = _reexport_y`. The
 * `reExportedFrom` marker is set authoritatively by SymbolTable.build
 * for every symbol that entered the file via an `export ... from "..."`
 * statement, so it always identifies the same set of wrappers
 * `resolveReExports` later synthesizes.
 */
function isReExportWrapper(
  node: InitVarNode,
  symbolTable: SymbolTable,
): boolean {
  const sym = symbolTable.getFile(node.moduleId)?.[node.varName];
  return !!sym?.reExportedFrom;
}

/**
 * Sort one graph; turn `CycleError` into a `CompileClosureError`
 * carrying the formatted decl pair list. `phaseName` ("static" /
 * "global") parameterizes the error message so cycle in either graph
 * surfaces consistently.
 */
function sortOrThrow(
  graph: InitDepGraph,
  phaseName: "static" | "global",
): string[] {
  const r = topSortInitGraph(graph);
  if (r.kind === "ok") return r.order;
  throw new CompileClosureError(formatCycleError(r, phaseName));
}

function formatCycleError(
  err: CycleError,
  phaseName: "static" | "global",
): string {
  const lines: string[] = [
    `Error: Circular ${phaseName} dependency`,
  ];
  for (let i = 0; i < err.cycle.length; i++) {
    const cur = err.cycle[i];
    const next = err.cycle[(i + 1) % err.cycle.length];
    lines.push(
      `  ${displayKey(cur)} (${cur.moduleId}:${cur.loc?.line ?? "?"}) depends on ${displayKey(next)}`,
    );
  }
  lines.push(
    `${capitalize(phaseName)} vars cannot depend on each other in a cycle. ` +
      `Break the cycle by extracting one into a third file or computing from a literal.`,
  );
  return lines.join("\n");
}

function displayKey(node: InitVarNode): string {
  const moduleName = path.basename(node.moduleId, ".agency");
  return `${moduleName}.${node.varName}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Project the topsorted variable list per module:
 *   - `localOrder`: the topsort-ordered subset of vars defined in this
 *     module.
 *   - `awaitModules`: distinct source modules (other than this one) of
 *     the cross-module dep edges out of any local node. Computed
 *     directly from the dep graph's edges.
 */
function buildPlans(
  moduleIds: string[],
  staticGraph: InitDepGraph,
  staticOrder: string[],
  globalGraph: InitDepGraph,
  globalOrder: string[],
  resolver: ImportAliasResolver,
  functionDefs: FunctionDefLookup,
): Record<string, ModuleInitPlan> {
  const plans: Record<string, ModuleInitPlan> = {};
  for (const moduleId of moduleIds) {
    plans[moduleId] = {
      moduleId,
      static: phasePlanFor(moduleId, staticGraph, staticOrder),
      global: globalPhasePlanFor(
        moduleId,
        globalGraph,
        globalOrder,
        staticGraph,
        resolver,
        functionDefs,
      ),
    };
  }
  return plans;
}

function phasePlanFor(
  moduleId: string,
  graph: InitDepGraph,
  order: string[],
): ModuleInitPhasePlan {
  const localOrder: string[] = [];
  const awaitModulesSet: Record<string, true> = {};

  for (const key of order) {
    const node = graph.nodes[key];
    if (!node || node.moduleId !== moduleId) continue;
    // Synthetic bare-statement nodes never enter `localOrder` — the
    // section assembler emits them inline at their source position.
    // They STILL must contribute their cross-module edges to
    // `awaitModules`: a bare `show(helper.helperGlobal)` needs
    // `helper.agency`'s globals init awaited before it runs, same as
    // any named decl that references an imported global.
    const isBare = node.varName.startsWith("__bareStmt_");
    if (!isBare) localOrder.push(node.varName);
    for (const depKey of graph.edges[key] ?? []) {
      const depNode = graph.nodes[depKey];
      if (!depNode || depNode.moduleId === moduleId) continue;
      awaitModulesSet[depNode.moduleId] = true;
    }
  }

  return {
    localOrder,
    awaitModules: Object.keys(awaitModulesSet).sort(),
  };
}

/**
 * Build the Phase B (global) plan for one module.
 *
 * Starts from the standard edge-derived `awaitModules` (other modules'
 * GLOBAL inits that this module's globals depend on) and then augments
 * with cross-phase deps: any module whose STATIC this module's globals
 * read. The global graph deliberately drops static refs as edges (cycle
 * detection lives in single-phase graphs), but at runtime those statics
 * must still be initialized before this module's globals run — so the
 * generated `__initializeGlobals` needs an `await __awaitStaticInit(...)`
 * for each such source module. Without this, a `const g = importedStatic`
 * pattern hits the PR-1 read-before-init trap.
 *
 * Same-module statics need no await — `buildInitializeGlobalsFn` already
 * emits an `await __initializeStatic(__ctx)` for the local module before
 * any global init runs.
 */
function globalPhasePlanFor(
  moduleId: string,
  globalGraph: InitDepGraph,
  globalOrder: string[],
  staticGraph: InitDepGraph,
  resolver: ImportAliasResolver,
  functionDefs: FunctionDefLookup,
): ModuleInitPhasePlan {
  const base = phasePlanFor(moduleId, globalGraph, globalOrder);
  const awaitModulesSet: Record<string, true> = {};
  for (const m of base.awaitModules) awaitModulesSet[m] = true;

  // Same per-ref scan as before, but with PR-2.5 depth-1 expansion:
  // when a free ref names a top-level Agency function, walk that
  // function's body once and resolve its inner refs in the function's
  // home module. Any cross-module static the function reads through a
  // single hop contributes an await here.
  const recordStatic = (refKey: string): void => {
    const staticNode = staticGraph.nodes[refKey];
    if (!staticNode || staticNode.moduleId === moduleId) return;
    awaitModulesSet[staticNode.moduleId] = true;
  };
  const resolveAndRecord = (
    ref: { kind: "name"; name: string } | { kind: "member"; prefix: string; member: string },
    inModuleId: string,
  ): void => {
    if (ref.kind === "name") {
      const aliased = resolver.resolve(ref.name, inModuleId);
      recordStatic(
        aliased
          ? makeKey(aliased.sourceModuleId, aliased.sourceName)
          : makeKey(inModuleId, ref.name),
      );
      return;
    }
    const ns = resolver.resolveNamespace(ref.prefix, inModuleId);
    if (!ns) return;
    recordStatic(makeKey(ns.sourceModuleId, ref.member));
  };

  for (const key of Object.keys(globalGraph.nodes)) {
    const node = globalGraph.nodes[key];
    if (!node || node.moduleId !== moduleId) continue;
    for (const ref of collectFreeIdentifiers(node.initExpr)) {
      if (ref.kind === "name" && ref.name === node.varName) continue;
      resolveAndRecord(ref, moduleId);
    }
    // Depth-1: each direct call (bare or namespace) in this global's
    // initializer contributes the body's free refs, resolved in the
    // callee's home module. Mirrors `depsFor`'s expansion so a global
    // that reads a cross-module static through one function hop still
    // awaits the source module's static init.
    for (const fnMatch of collectDirectCalls(
      node.initExpr,
      moduleId,
      functionDefs,
    )) {
      for (const innerRef of collectFunctionBodyFreeRefs(fnMatch.def)) {
        resolveAndRecord(innerRef, fnMatch.moduleId);
      }
    }
  }

  return {
    localOrder: base.localOrder,
    awaitModules: Object.keys(awaitModulesSet).sort(),
  };
}

/**
 * Convenience: build the closure and look up one module's plan, or an
 * empty default if the module isn't in the closure. Used by codegen
 * entry points that already have a CompiledClosure on hand.
 */
export function planFor(
  closure: CompiledClosure,
  moduleId: string,
): ModuleInitPlan {
  return (
    closure.plans[moduleId] ?? {
      moduleId,
      static: { localOrder: [], awaitModules: [] },
      global: { localOrder: [], awaitModules: [] },
    }
  );
}
