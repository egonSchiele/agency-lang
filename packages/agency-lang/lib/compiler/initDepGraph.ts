/**
 * Per-variable initialization dependency graph.
 *
 * Walks every top-level `static const` and (non-static) `const` / `let` /
 * bare assignment in the entry module's full import closure. For each
 * declaration it creates a node keyed by `${moduleId}::${varName}` and
 * adds an edge from that node to every other init-var node referenced
 * by its initializer expression.
 *
 * Cross-module references are resolved via the import statements in the
 * referencing module: a local name `x` brought in by
 * `import { x } from "./bar.agency"` resolves to bar's `x` node.
 * Re-exports (`export { x } from "y"`) are followed transitively until
 * the ultimate source module — the canonical init node for a re-exported
 * binding lives in its source module, never in the re-exporter.
 *
 * Function references (`def foo`, `node foo`) are intentionally NOT
 * treated as edges: the dep graph orders *values*, not callable code.
 * The runtime read-before-init trap (PR 1) catches the residual case
 * where an initializer indirectly reads an unset static through a
 * function call.
 *
 * Task 2 (`topSortInitGraph.ts`) consumes this graph; Task 3 hooks the
 * combined builder + sort into the compile flow.
 */

import * as path from "path";
import type { AgencyProgram, AgencyNode, Expression } from "../types.js";
import type { Assignment } from "../types.js";
import type { SourceLocation } from "../types/base.js";
import type { SymbolTable } from "../symbolTable.js";
import {
  isAgencyImport,
  resolveAgencyImportPath,
} from "../importPaths.js";

export type InitVarKind = "static" | "global";

/**
 * One node in the init dep graph — corresponds to a single top-level
 * `static const`, `const`, `let`, or unscoped assignment in some module.
 *
 * `moduleId` is the absolute path of the source file the var was declared
 * in (NOT the file that imports it). For re-exports, the canonical node
 * lives in the originating source module — re-exporters do not get their
 * own node.
 */
export type InitVarNode = {
  moduleId: string;
  varName: string;
  kind: InitVarKind;
  initExpr: Expression;
  loc?: SourceLocation;
  exported: boolean;
};

/** Composite key for indexing init-var nodes: `${moduleId}::${varName}`. */
export type InitVarKey = string;

export function makeKey(moduleId: string, varName: string): InitVarKey {
  return `${moduleId}::${varName}`;
}

/**
 * Edges go from a node to every node its initializer references. The
 * topsort uses these to compute initialization order; cycles produce a
 * `CycleError` from Task 2.
 *
 * `fileImports` is the module-level import DAG (each module → list of
 * agency modules it imports directly). Used by the topsort as a
 * deterministic tiebreaker for nodes the var-edge graph leaves unordered
 * (motivating case: `fooStatic = getBarStatic() + "!"` — no direct var
 * edge, but bar must init before foo because foo imports bar).
 */
export type InitDepGraph = {
  nodes: Record<InitVarKey, InitVarNode>;
  edges: Record<InitVarKey, InitVarKey[]>;
  fileImports: Record<string, string[]>;
};

/**
 * Build a per-variable init dep graph from the closure of `entryModuleId`.
 *
 * `programs` maps absolute module paths to their parsed AST. The caller
 * is responsible for parsing every reachable file before calling this —
 * we don't re-parse to keep the function pure and testable.
 *
 * `symbolTable` is consulted to resolve `export { x } from "y"`
 * re-exports transitively. If omitted, re-exports aren't followed
 * (re-exporter shows up as an unrecognized local name and is silently
 * skipped) — this is fine for tests that don't involve re-exports.
 */
export function buildInitDepGraph(
  programs: Record<string, AgencyProgram>,
  symbolTable: SymbolTable | undefined,
  entryModuleId: string,
): InitDepGraph {
  const reachable = walkClosure(entryModuleId, programs);

  // 1. Collect every top-level init-var node from every reachable module.
  //    `static` here is recognized via the parser-set `node.static` flag —
  //    NOT `node.scope === "static"`, which is only assigned later by the
  //    typescriptPreprocessor (which runs per-module during codegen).
  const nodes: Record<InitVarKey, InitVarNode> = {};
  for (const moduleId of reachable) {
    const program = programs[moduleId];
    if (!program) continue;
    for (const node of program.nodes) {
      const v = unwrapTopLevelInitVar(node);
      if (!v) continue;
      nodes[makeKey(moduleId, v.variableName)] = {
        moduleId,
        varName: v.variableName,
        kind: v.static ? "static" : "global",
        initExpr: v.value as Expression,
        loc: v.loc,
        exported: !!v.exported,
      };
    }
  }

  // 2. Build a per-module import-alias map so we can resolve a referenced
  //    local name back to its (sourceModuleId, sourceVarName). The
  //    alias map follows `import { x as y }` and chases re-export chains
  //    to the ultimate source.
  const aliasMaps: Record<string, Record<string, { sourceModuleId: string; sourceName: string }>> = {};
  const fileImports: Record<string, string[]> = {};
  for (const moduleId of reachable) {
    const program = programs[moduleId];
    if (!program) {
      aliasMaps[moduleId] = {};
      fileImports[moduleId] = [];
      continue;
    }
    aliasMaps[moduleId] = buildAliasMap(program, moduleId, symbolTable);
    fileImports[moduleId] = collectFileImports(program, moduleId);
  }

  // 3. For each init-var node, walk its initializer and add an edge to
  //    every referenced init-var node we recognize.
  const edges: Record<InitVarKey, InitVarKey[]> = {};
  for (const [key, node] of Object.entries(nodes)) {
    const aliasMap = aliasMaps[node.moduleId] ?? {};
    const refs = collectFreeIdentifiers(node.initExpr);
    const depKeys: string[] = [];
    const seen: Record<string, true> = {};
    for (const refName of refs) {
      // Skip self-references (a static can't depend on itself).
      if (refName === node.varName) continue;

      // Same-module reference? Check our own nodes table first.
      const localKey = makeKey(node.moduleId, refName);
      if (nodes[localKey] && !seen[localKey]) {
        seen[localKey] = true;
        depKeys.push(localKey);
        continue;
      }

      // Cross-module reference via an import alias.
      const aliased = aliasMap[refName];
      if (aliased) {
        const remoteKey = makeKey(aliased.sourceModuleId, aliased.sourceName);
        if (nodes[remoteKey] && !seen[remoteKey]) {
          seen[remoteKey] = true;
          depKeys.push(remoteKey);
        }
      }
    }
    edges[key] = depKeys;
  }

  return { nodes, edges, fileImports };
}

/**
 * Walk the import closure from `entryModuleId`, returning every reachable
 * module path. Follows both `import` and `export ... from` statements.
 * Non-agency imports (stdlib, pkg::, .js, .ts) are skipped.
 */
function walkClosure(
  entryModuleId: string,
  programs: Record<string, AgencyProgram>,
): string[] {
  const out: string[] = [];
  const visited: Record<string, true> = {};
  const queue: string[] = [entryModuleId];
  while (queue.length > 0) {
    const moduleId = queue.shift()!;
    if (visited[moduleId]) continue;
    visited[moduleId] = true;
    out.push(moduleId);
    const program = programs[moduleId];
    if (!program) continue;
    for (const node of program.nodes) {
      const imported = getAgencyImportTarget(node);
      if (!imported) continue;
      const absPath = resolveAgencyImportPath(imported, moduleId);
      if (!visited[absPath]) queue.push(absPath);
    }
  }
  return out;
}

function getAgencyImportTarget(node: AgencyNode): string | null {
  if (node.type === "importStatement" && isAgencyImport(node.modulePath)) {
    return node.modulePath;
  }
  if (node.type === "importNodeStatement") {
    return node.agencyFile;
  }
  if (node.type === "exportFromStatement" && isAgencyImport(node.modulePath)) {
    return node.modulePath;
  }
  return null;
}

/**
 * For every named import in `program`, build a map from the local name
 * (the name used in this module) to the ultimate source (moduleId,
 * originalName), chasing `export { x } from "y"` chains via the
 * SymbolTable's `reExportedFrom` metadata.
 */
function buildAliasMap(
  program: AgencyProgram,
  moduleId: string,
  symbolTable: SymbolTable | undefined,
): Record<string, { sourceModuleId: string; sourceName: string }> {
  const out: Record<string, { sourceModuleId: string; sourceName: string }> = {};
  for (const node of program.nodes) {
    if (node.type !== "importStatement") continue;
    if (!isAgencyImport(node.modulePath)) continue;
    const importedFrom = resolveAgencyImportPath(node.modulePath, moduleId);
    for (const named of node.importedNames) {
      if (named.type !== "namedImport") continue;
      for (const originalName of named.importedNames) {
        const localName = named.aliases[originalName] ?? originalName;
        const resolved = resolveThroughReExports(
          importedFrom,
          originalName,
          symbolTable,
        );
        out[localName] = resolved;
      }
    }
  }
  return out;
}

/**
 * Walk re-export chains until we hit a symbol that lives in the file
 * that defines it. Returns `(definingModuleId, originalNameThere)`.
 *
 * Falls back to `(importedFrom, originalName)` if the chain can't be
 * walked (no symbol table, missing symbol, etc.).
 */
function resolveThroughReExports(
  startFile: string,
  startName: string,
  symbolTable: SymbolTable | undefined,
): { sourceModuleId: string; sourceName: string } {
  if (!symbolTable) {
    return { sourceModuleId: startFile, sourceName: startName };
  }
  let curFile = startFile;
  let curName = startName;
  // Cap iterations defensively; the SymbolTable already rejects re-export
  // cycles when it builds, so this should never spin in practice.
  for (let i = 0; i < 64; i++) {
    const sym = symbolTable.getFile(curFile)?.[curName];
    if (!sym || !sym.reExportedFrom) {
      return { sourceModuleId: curFile, sourceName: curName };
    }
    curFile = sym.reExportedFrom.sourceFile;
    curName = sym.reExportedFrom.originalName;
  }
  return { sourceModuleId: curFile, sourceName: curName };
}

function collectFileImports(
  program: AgencyProgram,
  moduleId: string,
): string[] {
  const out: string[] = [];
  const seen: Record<string, true> = {};
  for (const node of program.nodes) {
    const target = getAgencyImportTarget(node);
    if (!target) continue;
    const abs = resolveAgencyImportPath(target, moduleId);
    if (!seen[abs]) {
      seen[abs] = true;
      out.push(abs);
    }
  }
  return out;
}

/**
 * Unwrap a top-level node into an Assignment if it represents a value-init
 * declaration the dep graph should track. Skips non-assignments and
 * assignments that are statements inside blocks (those aren't top-level).
 *
 * Bare top-level statements (function calls etc) are NOT tracked here —
 * they're sequenced by source order within their module and don't have
 * a name to depend on. Task 3 attaches them to the init plan separately.
 */
function unwrapTopLevelInitVar(node: AgencyNode): Assignment | null {
  // Top-level assignments come out of the parser without a `scope` field
  // set (scope is assigned by a later preprocessor pass). All of them
  // are candidates for the init graph: `static`-prefixed ones become
  // Phase A; the rest become Phase B globals.
  if (node.type === "assignment") return node;
  if (node.type === "withModifier" && node.statement.type === "assignment") {
    return node.statement;
  }
  return null;
}

/**
 * Walk an expression and collect every free identifier reference
 * (variable-name literals). Does NOT descend into nested function /
 * lambda bodies — those bind their own scope and won't trigger init
 * ordering for the outer initializer.
 */
function collectFreeIdentifiers(expr: Expression | AgencyNode): string[] {
  const out: string[] = [];
  const visit = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    switch (n.type) {
      case "variableName":
        out.push(n.value);
        return;
      case "function":
      case "graphNode":
        // Lambdas / nested defs: their body is closed over but doesn't
        // execute during outer initializer evaluation. Skip.
        return;
      case "valueAccess":
        visit(n.base);
        for (const el of n.chain) {
          if (el.kind === "index") visit(el.index);
          else if (el.kind === "slice") {
            if (el.start) visit(el.start);
            if (el.end) visit(el.end);
          } else if (el.kind === "methodCall") visit(el.functionCall);
        }
        return;
      case "functionCall":
        // Function name itself MAY be a top-level def; but as noted in
        // the file header we don't add edges for callable references —
        // only value references. Skip the name; recurse into args.
        for (const arg of n.arguments) {
          if (arg.type === "splat") visit(arg.value);
          else if (arg.type === "namedArgument") visit(arg.value);
          else visit(arg);
        }
        return;
      case "binOpExpression":
        visit(n.left);
        visit(n.right);
        return;
      case "agencyArray":
        for (const item of n.items) {
          if (item?.type === "splat") visit(item.value);
          else visit(item);
        }
        return;
      case "agencyObject":
        for (const e of n.entries) {
          if (e?.type === "splat") visit(e.value);
          else {
            if (e.computedKey) visit(e.computedKey);
            visit(e.value);
          }
        }
        return;
      case "string":
      case "multiLineString":
        for (const seg of n.segments) {
          if (seg.type === "interpolation") visit(seg.expression);
        }
        return;
      case "newExpression":
        for (const arg of n.arguments) {
          if (arg.type === "splat") visit(arg.value);
          else if (arg.type === "namedArgument") visit(arg.value);
          else visit(arg);
        }
        return;
      case "tryExpression":
        visit(n.expression);
        return;
      case "isExpression":
        visit(n.value);
        return;
    }
    // Generic fallback: walk every own property to catch any expression
    // shape we didn't enumerate above. Safe because the early returns
    // above handled name-binding cases (function, graphNode).
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "loc") continue;
      visit(n[key]);
    }
  };
  visit(expr);
  return out;
}
