/**
 * Per-variable initialization dependency graphs.
 *
 * Walks every top-level declaration + bare statement in a set of
 * pre-collected agency programs (the entry's full import closure) and
 * produces two independent dep graphs:
 *
 *   - `staticGraph` — one node per top-level `static const`, edges from
 *     each node to every other init-var node its initializer references.
 *     Sorted by `topSortInitGraph` to drive Phase A (once per process).
 *   - `globalGraph` — one node per non-static `const` / `let` /
 *     unscoped assignment, plus one node per bare top-level statement
 *     (function call etc., keyed by a synthetic `__bareStmt_…` name).
 *     Drives Phase B (every run).
 *
 * Edges are derived only from *direct* free-variable references in the
 * initializer expression. Function references (`def foo`, `node foo`)
 * are NOT edges — the dep graph orders *values*, not callable code.
 * The runtime read-before-init trap (PR 1) catches the residual case
 * where an initializer indirectly reads an unset static through a
 * function call.
 *
 * Cross-module references are resolved through the shared
 * {@link ImportAliasResolver}, which walks `export { x } from "y"`
 * chains to the ultimate source. The same resolver is reused by the
 * codegen wrap site (Task 4) to thread the source `moduleId` into the
 * PR-1 trap message — there is exactly one re-export resolver in the
 * codebase.
 *
 * **Closed interface:** consumers see only `nodes + edges` per graph;
 * file-import depth and source line are baked into each node's
 * `sequenceHint` at build time so the topsort has one ordering rule.
 *
 * **Closure walking is NOT done here.** The caller (Task 3's
 * `compileClosure`) is responsible for parsing every reachable module
 * once and passing the full `programs` map in. Keeps this module pure
 * and testable.
 *
 * Phase coupling rules enforced by this builder:
 *   - A static initializer that references a global → throws
 *     `StaticReferencesGlobalError` (the global doesn't exist yet at
 *     Phase A).
 *   - A global initializer that references a static → allowed,
 *     no edge (statics are already initialized at Phase B time).
 */

import type { AgencyProgram, AgencyNode, Expression } from "../types.js";
import type { Assignment } from "../types.js";
import type { SourceLocation } from "../types/base.js";
import type { SymbolTable } from "../symbolTable.js";
import {
  isAgencyImport,
  resolveAgencyImportPath,
} from "../importPaths.js";
import { walkNodes } from "../utils/node.js";

export type InitVarKind = "static" | "global";

/**
 * One node in an init dep graph — corresponds to a single top-level
 * declaration (or, for the global graph only, a single bare top-level
 * statement).
 *
 * `moduleId` is the absolute path of the source file the var was
 * declared in (NOT the file that imports it). For re-exports, the
 * canonical node lives in the originating source module — re-exporters
 * do not get their own node.
 *
 * `sequenceHint` packs `(fileImportDepth, sourceLine)` into one number
 * so the topsort can break ties deterministically with a single key.
 * Lower wins (initializes earlier).
 */
export type InitVarNode = {
  moduleId: string;
  varName: string;
  kind: InitVarKind;
  /** For bare statements (global graph only) this is the wrapping
   * statement node; for assignments it's the right-hand side. */
  initExpr: Expression | AgencyNode;
  loc?: SourceLocation;
  exported: boolean;
  sequenceHint: number;
  /** Set when the source wrapped the decl/statement in `with approve`.
   * `handle { ... }` blocks are NOT legal at module top level, so this
   * single optional flag covers the full top-level handler surface. */
  withApprove?: boolean;
};

/** Composite key for indexing init-var nodes: `${moduleId}::${varName}`. */
export type InitVarKey = string;

export function makeKey(moduleId: string, varName: string): InitVarKey {
  return `${moduleId}::${varName}`;
}

/**
 * Edges go from a node to every other node its initializer references.
 * `topSortInitGraph` uses these to compute initialization order; cycles
 * produce a `CycleError`.
 */
export type InitDepGraph = {
  nodes: Record<InitVarKey, InitVarNode>;
  edges: Record<InitVarKey, InitVarKey[]>;
};

export type BuildInitDepGraphsResult = {
  staticGraph: InitDepGraph;
  globalGraph: InitDepGraph;
  /** Reused by codegen (Task 4) for PR-1 thread-through. */
  resolver: ImportAliasResolver;
};

/**
 * Compile-time error: a `static` initializer references a `global`. The
 * global doesn't exist yet at Phase A time, so this is unsatisfiable.
 */
export class StaticReferencesGlobalError extends Error {
  constructor(
    public readonly staticNode: InitVarNode,
    public readonly globalNode: InitVarNode,
  ) {
    super(
      `Static '${staticNode.varName}' (${staticNode.moduleId}:${staticNode.loc?.line ?? "?"}) ` +
        `references global '${globalNode.varName}' (${globalNode.moduleId}:${globalNode.loc?.line ?? "?"}). ` +
        `Static initializers run before any global init — they cannot read globals.`,
    );
    this.name = "StaticReferencesGlobalError";
  }
}

/**
 * Resolves a locally-bound name (used inside an initializer in some
 * module) to the `(moduleId, name)` pair that defines the value, walking
 * `export { x } from "y"` chains to the ultimate source.
 *
 * `resolveNamespace` covers the `import * as bar from "./bar.agency"`
 * shape: given the local prefix `bar`, returns the source module so
 * `bar.barStatic` can be resolved as `(bar.agency, barStatic)`. Returns
 * null when no namespace import bound that prefix in this module.
 *
 * Built once per `compileClosure` call; cached internally so a name
 * lookup is O(1) after first use per module.
 */
export type ImportAliasResolver = {
  resolve(
    localName: string,
    inModuleId: string,
  ): { sourceModuleId: string; sourceName: string } | null;
  resolveNamespace(
    prefix: string,
    inModuleId: string,
  ): { sourceModuleId: string } | null;
};

export function makeImportAliasResolver(
  programs: Record<string, AgencyProgram>,
  symbolTable: SymbolTable | undefined,
): ImportAliasResolver {
  const cache: Record<
    string,
    Record<string, { sourceModuleId: string; sourceName: string }>
  > = {};
  const nsCache: Record<string, Record<string, { sourceModuleId: string }>> = {};

  function buildFor(moduleId: string): Record<
    string,
    { sourceModuleId: string; sourceName: string }
  > {
    const map: Record<
      string,
      { sourceModuleId: string; sourceName: string }
    > = {};
    const program = programs[moduleId];
    if (!program || !symbolTable) return map;
    for (const node of program.nodes) {
      if (node.type !== "importStatement") continue;
      if (!isAgencyImport(node.modulePath)) continue;
      // Resolve ONE hop only. We intentionally don't follow re-export
      // chains all the way to the ultimate source here — each
      // intermediate re-exporter has a synthesized wrapper static
      // (`static const x = _reexport_x`) emitted by `resolveReExports`
      // that needs to be initialized at runtime, and one-hop edges let
      // the dep graph cascade through every wrapper automatically:
      // foo → reexport_a → reexport_b → bar.
      for (const resolved of symbolTable.resolveImport(node, moduleId)) {
        map[resolved.localName] = {
          sourceModuleId: resolved.file,
          sourceName: resolved.originalName,
        };
      }
    }
    return map;
  }

  function buildNamespaceFor(
    moduleId: string,
  ): Record<string, { sourceModuleId: string }> {
    const map: Record<string, { sourceModuleId: string }> = {};
    const program = programs[moduleId];
    if (!program) return map;
    for (const node of program.nodes) {
      if (node.type !== "importStatement") continue;
      if (!isAgencyImport(node.modulePath)) continue;
      for (const nameType of node.importedNames) {
        if (nameType.type !== "namespaceImport") continue;
        map[nameType.importedNames] = {
          sourceModuleId: resolveAgencyImportPath(node.modulePath, moduleId),
        };
      }
    }
    return map;
  }

  return {
    resolve(localName, inModuleId) {
      const moduleCache =
        cache[inModuleId] ?? (cache[inModuleId] = buildFor(inModuleId));
      return moduleCache[localName] ?? null;
    },
    resolveNamespace(prefix, inModuleId) {
      const moduleCache =
        nsCache[inModuleId] ??
        (nsCache[inModuleId] = buildNamespaceFor(inModuleId));
      return moduleCache[prefix] ?? null;
    },
  };
}

/**
 * Build the two phase-separated dep graphs from the entry's full
 * pre-parsed import closure.
 *
 * `programs` maps absolute module paths to their parsed AST and MUST
 * already contain every module reachable from `entryModuleId`. We do
 * not re-walk imports — the entry point (`compileClosure`) owns that.
 *
 * `symbolTable`, when provided, enables re-export chain resolution.
 * Without it, re-exporters appear as unresolved local names and produce
 * no edge — fine for the simplest unit tests but pulls the
 * `importedAlias` codegen path into the same starvation case the
 * PR-1 trap covers, so production callers should always pass one.
 */
export function buildInitDepGraphs(
  programs: Record<string, AgencyProgram>,
  symbolTable: SymbolTable | undefined,
  entryModuleId: string,
): BuildInitDepGraphsResult {
  const resolver = makeImportAliasResolver(programs, symbolTable);
  const sequenceHints = computeSequenceHintBase(programs, entryModuleId);

  // ── 1. Collect every node, routing each into the static or global graph.
  const staticNodes: Record<InitVarKey, InitVarNode> = {};
  const globalNodes: Record<InitVarKey, InitVarNode> = {};

  for (const moduleId of Object.keys(programs)) {
    const program = programs[moduleId];
    if (!program) continue;
    const depthBase = sequenceHints[moduleId] ?? 0;

    for (const node of program.nodes) {
      const varNode = nodeFromTopLevel(node, moduleId, depthBase);
      if (!varNode) continue;
      const target = varNode.kind === "static" ? staticNodes : globalNodes;
      target[makeKey(varNode.moduleId, varNode.varName)] = varNode;
    }
  }

  // ── 2. Compute edges within each graph by walking each node's
  //       initializer expression for free identifier references.
  const staticEdges = computeEdges(staticNodes, resolver);
  const globalEdges = computeEdgesGlobal(
    globalNodes,
    staticNodes,
    resolver,
  );

  // ── 3. Phase-coupling validation: a static reading a global is a
  //       compile error. (Global reading static is fine — handled in
  //       computeEdgesGlobal which skips static refs as deps.)
  rejectStaticReferencesGlobal(staticNodes, globalNodes, resolver);

  return {
    staticGraph: { nodes: staticNodes, edges: staticEdges },
    globalGraph: { nodes: globalNodes, edges: globalEdges },
    resolver,
  };
}

// ── Node extraction ──

/**
 * Convert a top-level program node into an `InitVarNode` if it's
 * something that participates in either init graph. Returns `null` for
 * top-level constructs that don't (functions, graph nodes, imports,
 * type aliases, comments, …).
 */
function nodeFromTopLevel(
  node: AgencyNode,
  moduleId: string,
  depthBase: number,
): InitVarNode | null {
  const { stmt, withApprove } = unwrapWithApprove(node);

  if (stmt.type === "assignment") {
    const line = stmt.loc?.line ?? 0;
    return {
      moduleId,
      varName: stmt.variableName,
      kind: stmt.static ? "static" : "global",
      initExpr: stmt.value as Expression,
      loc: stmt.loc,
      exported: !!stmt.exported,
      sequenceHint: depthBase + line,
      ...(withApprove && { withApprove: true }),
    };
  }

  // Bare top-level statements (function calls, etc.) participate in the
  // GLOBAL graph only. PR 3's `static` keyword unlocks static bare
  // statements; until then statics are decl-only.
  if (isBareTopLevelStatement(stmt)) {
    const line = stmt.loc?.line ?? 0;
    return {
      moduleId,
      varName: `__bareStmt_${moduleId}_${line}`,
      kind: "global",
      initExpr: stmt,
      loc: stmt.loc,
      exported: false,
      sequenceHint: depthBase + line,
      ...(withApprove && { withApprove: true }),
    };
  }

  return null;
}

/**
 * Unwrap a `<stmt> with approve` modifier into its inner statement +
 * the flag. Returns the original node unchanged if there's no modifier.
 * `handle { ... }` blocks are rejected by the parser at top level, so
 * the only modifier shape we need to handle is `withModifier`.
 */
function unwrapWithApprove(node: AgencyNode): {
  stmt: AgencyNode;
  withApprove: boolean;
} {
  if (node.type === "withModifier") {
    return { stmt: node.statement, withApprove: true };
  }
  return { stmt: node, withApprove: false };
}

/**
 * True for nodes that are bare top-level statements with side effects we
 * need to sequence (function calls, interrupts, etc.). Excludes
 * declarations, imports, comments, and other non-running constructs.
 */
function isBareTopLevelStatement(node: AgencyNode): boolean {
  switch (node.type) {
    case "functionCall":
    case "interruptStatement":
      return true;
    default:
      return false;
  }
}

// ── Edge computation ──

function computeEdges(
  nodes: Record<InitVarKey, InitVarNode>,
  resolver: ImportAliasResolver,
): Record<InitVarKey, InitVarKey[]> {
  const edges: Record<InitVarKey, InitVarKey[]> = {};
  for (const [key, node] of Object.entries(nodes)) {
    edges[key] = depsFor(node, nodes, resolver);
  }
  return edges;
}

/**
 * Global-graph edges: a global node depends on another global node it
 * references. References to STATIC nodes are intentionally NOT edges —
 * statics are fully initialized before any global init runs (cross-phase
 * allowance, not a cross-graph edge).
 */
function computeEdgesGlobal(
  globalNodes: Record<InitVarKey, InitVarNode>,
  staticNodes: Record<InitVarKey, InitVarNode>,
  resolver: ImportAliasResolver,
): Record<InitVarKey, InitVarKey[]> {
  const edges: Record<InitVarKey, InitVarKey[]> = {};
  for (const [key, node] of Object.entries(globalNodes)) {
    edges[key] = depsFor(node, globalNodes, resolver, staticNodes);
  }
  return edges;
}

/**
 * For one node, find every other node in `lookupSet` its initializer
 * directly references and return their keys (no duplicates, no
 * self-edges). `skipSet`, if provided, is the set of nodes whose
 * references should be silently skipped (used to skip static refs when
 * computing global edges).
 */
function depsFor(
  node: InitVarNode,
  lookupSet: Record<InitVarKey, InitVarNode>,
  resolver: ImportAliasResolver,
  skipSet?: Record<InitVarKey, InitVarNode>,
): InitVarKey[] {
  const seen: Record<InitVarKey, true> = {};
  const out: InitVarKey[] = [];
  for (const ref of collectFreeIdentifiers(node.initExpr)) {
    if (ref.kind === "name" && ref.name === node.varName) continue;
    const refKey = resolveFreeRef(ref, node.moduleId, resolver);
    if (!refKey) continue;
    if (skipSet?.[refKey]) continue;
    if (!lookupSet[refKey] || seen[refKey]) continue;
    seen[refKey] = true;
    out.push(refKey);
  }
  return out;
}

/**
 * Resolve a free reference (simple name or namespace member) used
 * inside `inModuleId`'s code to a canonical `${moduleId}::${name}`
 * key. Same-module references resolve directly; cross-module
 * references go through the alias resolver; `bar.barStatic`-style
 * accesses go through the namespace resolver. Returns `null` for
 * names not bound by any of those paths.
 */
function resolveFreeRef(
  ref: FreeRef,
  inModuleId: string,
  resolver: ImportAliasResolver,
): InitVarKey | null {
  if (ref.kind === "name") {
    const aliased = resolver.resolve(ref.name, inModuleId);
    if (aliased) return makeKey(aliased.sourceModuleId, aliased.sourceName);
    return makeKey(inModuleId, ref.name);
  }
  // member access: `prefix.member`. Only register an edge if the
  // prefix matches a namespace import — otherwise it could be a
  // local variable / object access we have no business sequencing.
  const ns = resolver.resolveNamespace(ref.prefix, inModuleId);
  if (!ns) return null;
  return makeKey(ns.sourceModuleId, ref.member);
}

// ── Phase-coupling validation ──

function rejectStaticReferencesGlobal(
  staticNodes: Record<InitVarKey, InitVarNode>,
  globalNodes: Record<InitVarKey, InitVarNode>,
  resolver: ImportAliasResolver,
): void {
  for (const node of Object.values(staticNodes)) {
    for (const ref of collectFreeIdentifiers(node.initExpr)) {
      if (ref.kind === "name" && ref.name === node.varName) continue;
      const refKey = resolveFreeRef(ref, node.moduleId, resolver);
      if (!refKey) continue;
      const offender = globalNodes[refKey];
      if (offender) throw new StaticReferencesGlobalError(node, offender);
    }
  }
}

// ── Free-identifier collection ──

/**
 * A single free reference inside an initializer expression:
 *   - `name`: a bare identifier like `barStatic` (resolved via the
 *     `resolve` alias map).
 *   - `member`: a two-part reference of the form `prefix.member`
 *     where `prefix` is bound by a local declaration. The dep graph
 *     treats it as an edge target only when `prefix` was bound by a
 *     namespace import (`import * as bar from "./bar.agency"`), in
 *     which case it resolves to `(bar.agency, member)` — the same
 *     edge a named import would have produced. Local-variable
 *     member accesses (`person.name`) produce no edge.
 */
export type FreeRef =
  | { kind: "name"; name: string }
  | { kind: "member"; prefix: string; member: string };

/**
 * Collect every free reference in `expr`, declaratively, via the
 * shared `walkNodes` walker. Skips identifiers that appear inside
 * nested name-binding constructs (`function`, `graphNode`) by checking
 * the ancestor stack — those bodies don't execute during the outer
 * initializer evaluation.
 *
 * Surfaces both bare identifiers (`barStatic`) and `prefix.member`
 * patterns (`bar.barStatic`) so the dep graph can resolve namespace
 * imports as cross-module edges. When a variableName is the base of
 * a `prefix.member`-shape valueAccess we skip its standalone yield;
 * the member form supersedes it.
 *
 * Exported so callers outside this module (e.g. `compileClosure`) can
 * reuse the same free-reference discipline when computing additional
 * cross-phase await dependencies that aren't representable as edges in
 * either single-phase graph.
 */
export function collectFreeIdentifiers(
  expr: Expression | AgencyNode,
): FreeRef[] {
  const out: FreeRef[] = [];
  for (const { node, ancestors } of walkNodes([expr as AgencyNode])) {
    if (
      ancestors.some(
        (a) => a.type === "function" || a.type === "graphNode",
      )
    ) {
      continue;
    }
    if (
      node.type === "valueAccess" &&
      node.base.type === "variableName" &&
      node.chain[0]?.kind === "property"
    ) {
      out.push({
        kind: "member",
        prefix: (node.base as { value: string }).value,
        member: node.chain[0].name,
      });
      continue;
    }
    if (node.type !== "variableName") continue;
    // Skip variableName when it's the base of a `prefix.member`
    // valueAccess — already emitted above as a `member` ref.
    const parent = ancestors[ancestors.length - 1];
    if (
      parent &&
      parent.type === "valueAccess" &&
      (parent as { base: AgencyNode }).base === node &&
      (parent as { chain: { kind: string }[] }).chain[0]?.kind === "property"
    ) {
      continue;
    }
    out.push({ kind: "name", name: node.value });
  }
  return out;
}

// ── Sequence-hint computation ──

/**
 * Compute each module's `(fileImportDepth × 1e6)` base value. Leaves of
 * the file-import DAG get 0; modules importing them get higher values;
 * file-import cycles (allowed by design — the router pattern) tolerated
 * by assigning leftover modules the tail of the ordering. Each node's
 * final `sequenceHint = depthBase + sourceLine` is computed by the
 * caller. Lower hint → initializes earlier.
 */
function computeSequenceHintBase(
  programs: Record<string, AgencyProgram>,
  entryModuleId: string,
): Record<string, number> {
  // file-import DAG: module → modules it agency-imports.
  const fileImports: Record<string, string[]> = {};
  const modules = new Set<string>([entryModuleId]);
  for (const moduleId of Object.keys(programs)) modules.add(moduleId);
  for (const moduleId of modules) {
    fileImports[moduleId] = agencyImportTargets(
      programs[moduleId],
      moduleId,
    ).filter((m) => modules.has(m));
  }

  // Kahn over the reversed DAG: leaves (no imports) come first.
  const inDeg: Record<string, number> = {};
  const dependents: Record<string, string[]> = {};
  for (const m of modules) {
    inDeg[m] = 0;
    dependents[m] = [];
  }
  for (const m of modules) {
    for (const imp of fileImports[m]) {
      dependents[imp].push(m);
      inDeg[m]++;
    }
  }

  const depth: Record<string, number> = {};
  let counter = 0;
  const ready = [...modules].filter((m) => inDeg[m] === 0).sort();
  while (ready.length > 0) {
    const m = ready.shift()!;
    depth[m] = counter++;
    for (const dep of dependents[m]) {
      inDeg[dep]--;
      if (inDeg[dep] === 0) {
        ready.push(dep);
        ready.sort();
      }
    }
  }
  // file-import cycle leftovers → tail of the ordering, deterministically.
  for (const m of [...modules].sort()) {
    if (depth[m] === undefined) depth[m] = counter++;
  }

  const SCALE = 1_000_000;
  const out: Record<string, number> = {};
  for (const m of modules) out[m] = depth[m] * SCALE;
  return out;
}

function agencyImportTargets(
  program: AgencyProgram | undefined,
  moduleId: string,
): string[] {
  if (!program) return [];
  const out: string[] = [];
  for (const node of program.nodes) {
    const target = agencyImportTarget(node);
    if (!target) continue;
    out.push(resolveAgencyImportPath(target, moduleId));
  }
  return out;
}

function agencyImportTarget(node: AgencyNode): string | null {
  if (node.type === "importStatement" && isAgencyImport(node.modulePath)) {
    return node.modulePath;
  }
  if (node.type === "importNodeStatement") {
    return node.agencyFile;
  }
  if (
    node.type === "exportFromStatement" &&
    isAgencyImport(node.modulePath)
  ) {
    return node.modulePath;
  }
  return null;
}
