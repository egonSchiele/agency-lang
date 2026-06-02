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
import type { FunctionDefinition } from "../types/function.js";
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
  /** Look-up `(name | namespace.member) → top-level FunctionDefinition`,
   * scoped to the importing module. PR-2.5 uses it to drive depth-1
   * expansion of init-expression deps through direct function calls. */
  functionDefs: FunctionDefLookup;
};

/**
 * Resolves a name used inside one module to the top-level Agency
 * function definition that backs it. Returns the function's home
 * `moduleId` alongside the AST so callers can resolve free identifiers
 * *inside* the function body against the function's own import surface
 * — not the caller's.
 *
 * `find` handles bare-name calls (`getBar()`). `findNamespaceMember`
 * handles namespace-prefixed calls (`bar.getBar()`).
 *
 * Returns `null` for names that don't resolve to an Agency function we
 * have AST for — stdlib calls, function values stored in variables,
 * unknown names, etc. The depth-1 expansion treats those as "no
 * expansion", and the runtime read-before-init trap (PR 1) remains the
 * safety net for anything the static analysis can't see.
 *
 * Built once per `compileClosure` call; cached per importing module so
 * a lookup is O(1) after first use per module.
 */
export type FunctionDefLookup = {
  find(
    name: string,
    inModuleId: string,
  ): { moduleId: string; def: FunctionDefinition } | null;
  findNamespaceMember(
    prefix: string,
    member: string,
    inModuleId: string,
  ): { moduleId: string; def: FunctionDefinition } | null;
};

/**
 * Build a `FunctionDefLookup` over the entry's full import closure.
 *
 * Two layers of cache:
 *   - `localDefsByModule[moduleId]` — name → FunctionDefinition for all
 *     top-level `def` statements declared in that module. Populated
 *     lazily; same shape used as the destination of both bare-name and
 *     namespace-member lookups.
 *   - `cache[inModuleId]` — name → resolved `(moduleId, def)` for the
 *     importing module's view (local defs + named-import aliases of
 *     functions declared elsewhere). Populated lazily on first lookup.
 */
export function makeFunctionDefLookup(
  programs: Record<string, AgencyProgram>,
  resolver: ImportAliasResolver,
  symbolTable: SymbolTable | undefined,
): FunctionDefLookup {
  const localDefsByModule: Record<
    string,
    Record<string, FunctionDefinition>
  > = {};

  function localDefsFor(
    moduleId: string,
  ): Record<string, FunctionDefinition> {
    const cached = localDefsByModule[moduleId];
    if (cached) return cached;
    const map: Record<string, FunctionDefinition> = {};
    const program = programs[moduleId];
    if (program) {
      for (const node of program.nodes) {
        if (node.type !== "function") continue;
        map[node.functionName] = node;
      }
    }
    localDefsByModule[moduleId] = map;
    return map;
  }

  /**
   * Follow a re-export chain to the module that owns the real `def`.
   *
   * `ImportAliasResolver.resolve` only walks one hop because the
   * synthesized wrapper *static* at each re-exporter needs its own
   * `__initializeStatic` to run — collapsing the chain in the
   * resolver would lose those wrappers. **Functions don't have that
   * constraint:** `resolveReExports` emits a wrapper function whose
   * body is just `return _reexport_<orig>(...args)`, which the
   * depth-1 free-identifier walker cannot see through (function-call
   * names are not surfaced as free refs). Following the chain here
   * gives the depth-1 expansion the *real* body to walk, so a single
   * direct call in user source contributes the right edges even when
   * the call resolves through one or more re-export hops.
   *
   * Defensive cap (`MAX_HOPS`) protects against an unforeseen
   * cyclic SymbolTable entry — `SymbolTable.build` rejects ambiguous
   * re-exports but a future bug there shouldn't hang this loop.
   */
  function resolveToUltimateDef(
    moduleId: string,
    name: string,
  ): { moduleId: string; def: FunctionDefinition } | null {
    const MAX_HOPS = 32;
    let curModule = moduleId;
    let curName = name;
    for (let i = 0; i < MAX_HOPS; i++) {
      const sym = symbolTable?.getFile(curModule)?.[curName];
      if (sym && sym.reExportedFrom) {
        curModule = sym.reExportedFrom.sourceFile;
        curName = sym.reExportedFrom.originalName;
        continue;
      }
      const def = localDefsFor(curModule)[curName];
      if (!def) return null;
      return { moduleId: curModule, def };
    }
    return null;
  }

  const cache: Record<
    string,
    Record<string, { moduleId: string; def: FunctionDefinition }>
  > = {};

  function buildFor(
    inModuleId: string,
  ): Record<string, { moduleId: string; def: FunctionDefinition }> {
    const map: Record<string, { moduleId: string; def: FunctionDefinition }> =
      {};
    // Local defs win — same-file `def foo` is reachable as bare `foo`.
    for (const [name, def] of Object.entries(localDefsFor(inModuleId))) {
      map[name] = { moduleId: inModuleId, def };
    }
    // Named imports of functions defined in other modules.
    const program = programs[inModuleId];
    if (program) {
      for (const node of program.nodes) {
        if (node.type !== "importStatement") continue;
        if (!isAgencyImport(node.modulePath)) continue;
        for (const nameType of node.importedNames) {
          if (nameType.type !== "namedImport") continue;
          for (const original of nameType.importedNames) {
            // Walk through the local alias the importer uses, not the
            // original name — that's how the importer references it.
            const localAlias =
              (nameType.aliases && nameType.aliases[original]) ?? original;
            const aliased = resolver.resolve(localAlias, inModuleId);
            if (!aliased) continue;
            const ultimate = resolveToUltimateDef(
              aliased.sourceModuleId,
              aliased.sourceName,
            );
            if (!ultimate) continue;
            map[localAlias] = ultimate;
          }
        }
      }
    }
    return map;
  }

  return {
    find(name, inModuleId) {
      const moduleCache =
        cache[inModuleId] ?? (cache[inModuleId] = buildFor(inModuleId));
      return moduleCache[name] ?? null;
    },
    findNamespaceMember(prefix, member, inModuleId) {
      const ns = resolver.resolveNamespace(prefix, inModuleId);
      if (!ns) return null;
      return resolveToUltimateDef(ns.sourceModuleId, member);
    },
  };
}

/**
 * Compile-time error: a `static` initializer references a `global`. The
 * global doesn't exist yet at Phase A time, so this is unsatisfiable.
 *
 * Surface format prefers human-readable names: `static const x` is shown
 * as `static const 'x'`, while a `static <bare>` whose synthetic varName
 * starts with `__bareStmt_` is shown as `static <bare statement>`. Line
 * numbers fall back to `?` only when neither the static wrapper nor the
 * dep node has a usable `loc`.
 */
export class StaticReferencesGlobalError extends Error {
  constructor(
    public readonly staticNode: InitVarNode,
    public readonly globalNode: InitVarNode,
  ) {
    const staticDesc = describeInitNode(staticNode);
    const globalDesc = describeInitNode(globalNode, "global");
    super(
      `${staticDesc} references ${globalDesc}. ` +
        `Static initializers run during Phase A (process startup), ` +
        `before any global is initialized in Phase B — so the global ` +
        `does not exist yet. Either mark the global as \`static\`, or ` +
        `move the read out of the static initializer.`,
    );
    this.name = "StaticReferencesGlobalError";
  }
}

function describeInitNode(node: InitVarNode, kindLabel?: string): string {
  const where = `${node.moduleId}:${node.loc?.line ?? "?"}`;
  if (node.varName.startsWith("__bareStmt_")) {
    return `static bare statement at ${where}`;
  }
  const label = kindLabel ?? (node.kind === "static" ? "static const" : "global");
  return `${label} '${node.varName}' (${where})`;
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
  const functionDefs = makeFunctionDefLookup(programs, resolver, symbolTable);
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
  //       initializer expression for free identifier references —
  //       plus PR-2.5 depth-1 expansion through direct function calls.
  const staticEdges = computeEdges(staticNodes, resolver, functionDefs);
  const globalEdges = computeEdgesGlobal(
    globalNodes,
    staticNodes,
    resolver,
    functionDefs,
  );

  // ── 3. Phase-coupling validation: a static reading a global is a
  //       compile error. (Global reading static is fine — handled in
  //       computeEdgesGlobal which skips static refs as deps.)
  rejectStaticReferencesGlobal(
    staticNodes,
    globalNodes,
    resolver,
    functionDefs,
  );

  return {
    staticGraph: { nodes: staticNodes, edges: staticEdges },
    globalGraph: { nodes: globalNodes, edges: globalEdges },
    resolver,
    functionDefs,
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
  const { stmt: afterApprove, withApprove } = unwrapWithApprove(node);
  const {
    stmt,
    isStaticBare,
    wrapperLoc: staticWrapperLoc,
  } = unwrapStaticStatement(afterApprove);

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

  // Bare top-level statements (function calls, etc.) participate in
  // one of the two graphs depending on whether they were prefixed
  // with `static` at the source. Without `static` they live in the
  // GLOBAL graph (Phase B, every run); with `static` they live in
  // the STATIC graph (Phase A, once per process).
  //
  // `varName` is synthetic — the actual InitVarKey is already
  // `${moduleId}::${varName}`, so we keep the name module-local for
  // readable cycle / debug output. `line_col` (not just `line`)
  // because `foo(); bar()` on a single source line would otherwise
  // collide and one node would overwrite the other in the dep graph.
  //
  // For a `static <bare>`, prefer the wrapper's loc (the `static`
  // keyword itself) over the inner statement's loc. The inner
  // sub-parsers (functionCallParser, valueAccessParser, …) do not
  // emit `loc` themselves — only the outer `withLoc(staticStatement)`
  // does — so falling back to the inner would yield a missing line
  // number in compile-time error messages.
  if (isStaticBare || isBareTopLevelStatement(stmt)) {
    const effectiveLoc = staticWrapperLoc ?? stmt.loc;
    const line = effectiveLoc?.line ?? 0;
    const col = effectiveLoc?.col ?? 0;
    return {
      moduleId,
      varName: `__bareStmt_${line}_${col}`,
      kind: isStaticBare ? "static" : "global",
      initExpr: stmt,
      loc: effectiveLoc,
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
 * Unwrap a `static <bare-statement>` wrapper. The parser only emits
 * `staticStatement` at module top level wrapping a bare expression
 * (function call, value access, interrupt) — never an assignment, never
 * recursively — so a single unwrap is enough.
 *
 * Returns the wrapper's own `loc` separately so callers can prefer
 * it for diagnostics. The inner statement's sub-parsers
 * (functionCallParser, valueAccessParser, interruptStatementParser)
 * do not emit `loc` themselves — only the outer `withLoc(...)` on
 * `staticStatementParser` does — so the wrapper loc is the authoritative
 * source location for the whole `static <expr>` form.
 */
function unwrapStaticStatement(node: AgencyNode): {
  stmt: AgencyNode;
  isStaticBare: boolean;
  wrapperLoc: AgencyNode["loc"];
} {
  if (node.type === "staticStatement") {
    return {
      stmt: node.statement,
      isStaticBare: true,
      wrapperLoc: node.loc,
    };
  }
  return { stmt: node, isStaticBare: false, wrapperLoc: undefined };
}

/**
 * True for nodes that are bare top-level statements with side effects we
 * need to sequence (function calls, interrupts, etc.). Excludes
 * declarations, imports, comments, and other non-running constructs.
 *
 * `valueAccess` is admitted because the `static` parser accepts forms
 * like `static logger.flush()` whose method call lives inside a value
 * access chain — without this branch the wrapped statement would
 * produce no init node and the dep graph would lose visibility of its
 * cross-module reads.
 */
function isBareTopLevelStatement(node: AgencyNode): boolean {
  switch (node.type) {
    case "functionCall":
    case "interruptStatement":
    case "valueAccess":
      return true;
    default:
      return false;
  }
}

// ── Edge computation ──

function computeEdges(
  nodes: Record<InitVarKey, InitVarNode>,
  resolver: ImportAliasResolver,
  functionDefs: FunctionDefLookup,
): Record<InitVarKey, InitVarKey[]> {
  const edges: Record<InitVarKey, InitVarKey[]> = {};
  for (const [key, node] of Object.entries(nodes)) {
    edges[key] = depsFor(node, nodes, resolver, functionDefs);
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
  functionDefs: FunctionDefLookup,
): Record<InitVarKey, InitVarKey[]> {
  const edges: Record<InitVarKey, InitVarKey[]> = {};
  for (const [key, node] of Object.entries(globalNodes)) {
    edges[key] = depsFor(
      node,
      globalNodes,
      resolver,
      functionDefs,
      staticNodes,
    );
  }
  return edges;
}

/**
 * For one node, find every other node in `lookupSet` its initializer
 * references — either directly or via a depth-1 call into a top-level
 * Agency function whose body reads the target.
 *
 * `skipSet`, if provided, is the set of nodes whose references should
 * be silently skipped (used to skip static refs when computing global
 * edges).
 *
 * **Depth-1 expansion:** when a free reference in the init expression
 * resolves to a top-level function definition (via `functionDefs`), we
 * walk that function's body for free identifiers and resolve each one
 * in the *function's* home module. The runtime read-before-init trap
 * (PR 1) still covers depth-2+, function values, and any other case
 * the static analysis can't see.
 *
 * `collectFreeIdentifiers` already skips identifiers inside nested
 * `function` / `graphNode` bodies — that gives us the depth-1
 * boundary for free. Blocks (`map(arr) as x { ... }`) are NOT skipped:
 * they're not nested functions, they're inline code that runs in the
 * outer function's scope, so any free refs inside a block body inside
 * the called function still contribute deps.
 */
function depsFor(
  node: InitVarNode,
  lookupSet: Record<InitVarKey, InitVarNode>,
  resolver: ImportAliasResolver,
  functionDefs: FunctionDefLookup,
  skipSet?: Record<InitVarKey, InitVarNode>,
): InitVarKey[] {
  const seen: Record<InitVarKey, true> = {};
  const out: InitVarKey[] = [];
  const addRef = (refKey: InitVarKey | null): void => {
    if (!refKey) return;
    if (skipSet?.[refKey]) return;
    if (!lookupSet[refKey] || seen[refKey]) return;
    seen[refKey] = true;
    out.push(refKey);
  };
  for (const ref of collectFreeIdentifiers(node.initExpr)) {
    if (ref.kind === "name" && ref.name === node.varName) continue;
    addRef(resolveFreeRef(ref, node.moduleId, resolver));
  }
  // Depth-1 expansion: for every direct call in the init expression
  // that resolves to a top-level Agency function we have AST for,
  // contribute the deps from one walk of the function's body. Inner
  // refs resolve in the function's home module.
  for (const fnMatch of collectDirectCalls(
    node.initExpr,
    node.moduleId,
    functionDefs,
  )) {
    for (const innerRef of collectFunctionBodyFreeRefs(fnMatch.def)) {
      addRef(resolveFreeRef(innerRef, fnMatch.moduleId, resolver));
    }
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
  functionDefs: FunctionDefLookup,
): void {
  for (const node of Object.values(staticNodes)) {
    const check = (refKey: InitVarKey | null): void => {
      if (!refKey) return;
      const offender = globalNodes[refKey];
      if (offender) throw new StaticReferencesGlobalError(node, offender);
    };
    for (const ref of collectFreeIdentifiers(node.initExpr)) {
      if (ref.kind === "name" && ref.name === node.varName) continue;
      check(resolveFreeRef(ref, node.moduleId, resolver));
    }
    // Depth-1: any direct call (bare or namespace) into a top-level
    // Agency function whose body reads a global also makes the
    // enclosing static reference that global. Same rejection rule
    // applies.
    for (const fnMatch of collectDirectCalls(
      node.initExpr,
      node.moduleId,
      functionDefs,
    )) {
      for (const innerRef of collectFunctionBodyFreeRefs(fnMatch.def)) {
        check(resolveFreeRef(innerRef, fnMatch.moduleId, resolver));
      }
    }
  }
}

/**
 * Walk an init expression for **direct call sites** — both bare-name
 * calls (`getBar()`) and namespace-method calls (`bar.getBar()`) — and
 * return the FunctionDefinitions they resolve to, paired with the
 * function's home module. Used by the depth-1 expansion to discover
 * which functions to look inside.
 *
 * Skips identifiers inside nested `function` / `graphNode` bodies via
 * the same ancestor check `collectFreeIdentifiers` uses, so when we
 * are already mid-walk of one function's body we don't accidentally
 * descend into another function defined alongside it.
 *
 * `collectFreeIdentifiers` cannot do this job because `walkNodes`'s
 * `functionCall` branch deliberately does not yield the function name
 * as a `variableName` (the call's identifier isn't a value
 * reference). Method-call chain elements (`obj.method()`) likewise
 * don't surface as `member` free refs — they're `methodCall` chain
 * entries, not `property` chain entries.
 */
export function collectDirectCalls(
  expr: Expression | AgencyNode,
  inModuleId: string,
  functionDefs: FunctionDefLookup,
): { moduleId: string; def: FunctionDefinition }[] {
  const out: { moduleId: string; def: FunctionDefinition }[] = [];
  for (const { node, ancestors } of walkNodes([expr as AgencyNode])) {
    if (
      ancestors.some(
        (a) => a.type === "function" || a.type === "graphNode",
      )
    ) {
      continue;
    }
    if (node.type === "functionCall") {
      // Skip a functionCall that lives inside a valueAccess methodCall
      // chain (`x.foo()`) — handled by the valueAccess branch below
      // where we have the namespace prefix to drive the lookup.
      const parent = ancestors[ancestors.length - 1];
      const isMethodCall =
        parent &&
        parent.type === "valueAccess" &&
        (parent as { chain: { kind: string; functionCall?: unknown }[] }).chain.some(
          (c) => c.kind === "methodCall" && (c as { functionCall: unknown }).functionCall === node,
        );
      if (isMethodCall) continue;
      const match = functionDefs.find(node.functionName, inModuleId);
      if (match) out.push(match);
      continue;
    }
    if (node.type === "valueAccess" && node.base.type === "variableName") {
      const prefix = (node.base as { value: string }).value;
      for (const elem of node.chain) {
        if (elem.kind !== "methodCall") continue;
        const match = functionDefs.findNamespaceMember(
          prefix,
          elem.functionCall.functionName,
          inModuleId,
        );
        if (match) out.push(match);
      }
    }
  }
  return out;
}

/**
 * Collect every free identifier in a function body, treating each top-
 * level statement of the body independently so the function's *own*
 * `function` node isn't on the ancestor stack (which would cause
 * `collectFreeIdentifiers` to skip everything by design). The result
 * still skips any further nested `function` / `graphNode` bodies — the
 * depth-1 boundary holds.
 *
 * **Parameter-shadow filtering.** Drops refs whose name (or `prefix`,
 * for member refs) matches one of the function's parameter names.
 * Otherwise a parameter that happens to share a name with a top-level
 * decl (e.g. `def readG(g: string) { return g }` when a top-level
 * `g` exists) would resolve through the import alias resolver to the
 * top-level binding and produce a spurious init edge or false
 * `StaticReferencesGlobalError`.
 */
export function collectFunctionBodyFreeRefs(def: FunctionDefinition): FreeRef[] {
  const paramNames: Record<string, true> = {};
  for (const param of def.parameters) paramNames[param.name] = true;
  const out: FreeRef[] = [];
  for (const stmt of def.body) {
    for (const ref of collectFreeIdentifiers(stmt)) {
      if (ref.kind === "name" && paramNames[ref.name]) continue;
      if (ref.kind === "member" && paramNames[ref.prefix]) continue;
      out.push(ref);
    }
  }
  return out;
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
