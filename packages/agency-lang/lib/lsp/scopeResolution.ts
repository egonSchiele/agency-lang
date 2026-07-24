import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";

/**
 * Find the AST definition node (function or graphNode) for a named scope.
 */
export function findDefForScope(name: string, program: AgencyProgram) {
  for (const node of program.nodes) {
    if (node.type === "function" && node.functionName === name) return node;
    if (node.type === "graphNode" && node.nodeName === name) return node;
  }
  return null;
}

/**
 * Build a reusable scope finder.
 *
 * Matching an offset to a scope needs a name→definition map, and
 * building that map costs a scan of `program.nodes` for every scope. For
 * a one-shot question — a hover, a go-to-definition — paying that once
 * per call is fine.
 *
 * It is not fine for a caller asking about every identifier in the file:
 * that turns one document into scopes × nodes × identifiers work. So the
 * map is built here, once, and the returned function reuses it.
 * `findContainingScope` is the one-shot form, and calls this.
 */
export function makeScopeFinder(
  scopes: ScopeInfo[],
  program: AgencyProgram,
): (offset: number) => ScopeInfo | undefined {
  const defMap: Record<string, ReturnType<typeof findDefForScope>> = {};
  for (const scopeInfo of scopes) {
    if (scopeInfo.name !== "top-level" && !(scopeInfo.name in defMap)) {
      defMap[scopeInfo.name] = findDefForScope(scopeInfo.name, program);
    }
  }

  return (offset: number) => {
    let best: ScopeInfo | undefined;
    for (const scopeInfo of scopes) {
      if (scopeInfo.name === "top-level") {
        if (!best) best = scopeInfo;
        continue;
      }
      const def = defMap[scopeInfo.name];
      if (!def?.loc) continue;
      if (offset >= def.loc.start && offset <= def.loc.end) {
        if (!best || best.name === "top-level") {
          best = scopeInfo;
        } else {
          const bestDef = defMap[best.name];
          if (bestDef?.loc && def.loc.start > bestDef.loc.start) {
            best = scopeInfo;
          }
        }
      }
    }
    return best;
  };
}

/**
 * Find the innermost scope that contains the given character offset.
 * Falls back to the top-level scope if no function/node scope matches.
 *
 * Asking this repeatedly for the same document rebuilds the definition
 * map each time — use `makeScopeFinder` for that.
 */
export function findContainingScope(
  offset: number,
  scopes: ScopeInfo[],
  program: AgencyProgram,
): ScopeInfo | undefined {
  return makeScopeFinder(scopes, program)(offset);
}
