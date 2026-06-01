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
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { resolveReExports } from "../preprocessors/resolveReExports.js";
import {
  buildInitDepGraphs,
  collectFreeIdentifiers,
  makeKey,
  type ImportAliasResolver,
  type InitDepGraph,
  type InitVarNode,
  StaticReferencesGlobalError,
} from "./initDepGraph.js";
import { topSortInitGraph, type CycleError } from "./topSortInitGraph.js";
import {
  getStdlibDir,
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
  entryFile: string,
  config: AgencyConfig,
): CompiledClosure {
  const entryModuleId = path.resolve(entryFile);
  // SymbolTable must come first: it's the source of truth for re-export
  // relationships, and parseClosure needs it to expand each parsed file
  // via `resolveReExports` so the dep graph sees synthesized wrapper
  // statics (`static const x = _reexport_x`) at re-exporters. Without
  // that, re-export chains like a→b→c produce wrappers in a.js / b.js
  // whose `__initializeStatic` never gets awaited because the dep graph
  // collapses straight to c.
  const symbolTable = SymbolTable.build(entryModuleId, config);
  const programs = parseClosure(entryModuleId, config, symbolTable);

  let staticGraph: InitDepGraph;
  let globalGraph: InitDepGraph;
  let resolver: ImportAliasResolver;
  try {
    const r = buildInitDepGraphs(programs, symbolTable, entryModuleId);
    staticGraph = r.staticGraph;
    globalGraph = r.globalGraph;
    resolver = r.resolver;
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

  const plans = buildPlans(
    Object.keys(programs),
    staticGraph,
    staticOrder,
    globalGraph,
    globalOrder,
    resolver,
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
  entryModuleId: string,
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
  const queue: string[] = [entryModuleId];
  const stdlibDir = getStdlibDir();
  const stdlibIndex = path.join(stdlibDir, "index.agency");

  while (queue.length > 0) {
    const moduleId = queue.shift()!;
    if (visited[moduleId]) continue;
    visited[moduleId] = true;

    if (!fs.existsSync(moduleId)) {
      throw new CompileClosureError(
        `Error: Input file '${moduleId}' not found`,
      );
    }
    const source = fs.readFileSync(moduleId, "utf-8");
    const applyTemplate = moduleId !== stdlibIndex;
    const result = parseAgency(source, config, applyTemplate);
    if (!result.success) {
      throw new CompileClosureError(
        `Failed to parse ${moduleId}: ${result.message ?? "unknown parse error"}`,
      );
    }
    raw[moduleId] = result.result;

    for (const target of agencyImportTargets(result.result, moduleId)) {
      if (!visited[target]) queue.push(target);
    }
  }

  const out: Record<string, AgencyProgram> = {};
  for (const [moduleId, program] of Object.entries(raw)) {
    out[moduleId] = resolveReExports(program, symbolTable, moduleId);
  }
  return out;
}

function agencyImportTargets(
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
    // Skip synthetic bare-statement nodes — they're emitted inline by
    // the existing sectionAssembler path; the plan currently only
    // sequences named decls.
    if (node.varName.startsWith("__bareStmt_")) continue;
    localOrder.push(node.varName);
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
): ModuleInitPhasePlan {
  const base = phasePlanFor(moduleId, globalGraph, globalOrder);
  const awaitModulesSet: Record<string, true> = {};
  for (const m of base.awaitModules) awaitModulesSet[m] = true;

  for (const key of Object.keys(globalGraph.nodes)) {
    const node = globalGraph.nodes[key];
    if (!node || node.moduleId !== moduleId) continue;
    for (const refName of collectFreeIdentifiers(node.initExpr)) {
      if (refName === node.varName) continue;
      const aliased = resolver.resolve(refName, moduleId);
      const refKey = aliased
        ? makeKey(aliased.sourceModuleId, aliased.sourceName)
        : makeKey(moduleId, refName);
      const staticNode = staticGraph.nodes[refKey];
      if (!staticNode || staticNode.moduleId === moduleId) continue;
      awaitModulesSet[staticNode.moduleId] = true;
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
