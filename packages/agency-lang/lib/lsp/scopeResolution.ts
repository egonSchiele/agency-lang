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
 * Find the innermost scope that contains the given character offset.
 * Falls back to the top-level scope if no function/node scope matches.
 */
export function findContainingScope(
  offset: number,
  scopes: ScopeInfo[],
  program: AgencyProgram,
): ScopeInfo | undefined {
  // Build name→def map once to avoid repeated linear scans
  const defMap: Record<string, ReturnType<typeof findDefForScope>> = {};
  for (const scopeInfo of scopes) {
    if (scopeInfo.name !== "top-level" && !(scopeInfo.name in defMap)) {
      defMap[scopeInfo.name] = findDefForScope(scopeInfo.name, program);
    }
  }

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
}
