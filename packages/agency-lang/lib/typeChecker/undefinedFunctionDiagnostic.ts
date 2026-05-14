import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { Scope } from "./scope.js";
import type { FunctionCall } from "../types.js";
import type { ValueAccess } from "../types/access.js";
import { walkNodes } from "../utils/node.js";
import {
  resolveCall,
  lookupJsMember,
  JS_GLOBALS,
} from "./resolveCall.js";

/**
 * Emit a diagnostic for every call site that doesn't resolve to a known
 * function — bare `functionCall` names AND `<JsNamespace>.member(...)` chains.
 *
 * Severity is controlled by `config.typechecker.undefinedFunctions`:
 *   - "silent" (default): no diagnostics emitted
 *   - "warn":  pushed as warnings
 *   - "error": pushed as errors
 *
 * Resolution is delegated to `resolveCall` / `lookupJsMember` (pure functions
 * in resolveCall.ts) — this module just walks the AST and translates "didn't
 * resolve" into a diagnostic.
 */
export function checkUndefinedFunctions(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  const mode = ctx.config.typechecker?.undefinedFunctions ?? "silent";
  if (mode === "silent") return;

  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    ctx.withScope(info.scopeKey, () => {
      for (const { node } of walkNodes(info.body)) {
        if (node.type === "functionCall") {
          checkBareCall(node, info.scope, ctx, mode);
        } else if (node.type === "valueAccess") {
          checkAccessChain(node, info.scope, ctx, mode);
        }
      }
    });
  }
}

// --- Internal helpers ---

function checkBareCall(
  call: FunctionCall,
  scope: Scope,
  ctx: TypeCheckerContext,
  mode: "warn" | "error",
): void {
  const resolution = resolveCall(call.functionName, {
    functionDefs: ctx.functionDefs,
    nodeDefs: ctx.nodeDefs,
    importedFunctions: ctx.importedFunctions,
    scopeHas: (name) => scope.has(name),
  });
  if (resolution.kind !== "unresolved") return;
  ctx.errors.push({
    message: `Function '${call.functionName}' is not defined.`,
    severity: mode === "warn" ? "warning" : "error",
    loc: call.loc,
  });
}

function checkAccessChain(
  expr: ValueAccess,
  scope: Scope,
  ctx: TypeCheckerContext,
  mode: "warn" | "error",
): void {
  // Only handle <variableName>.<member>... chains where the base is a JS
  // namespace global. Everything else (objects in scope, computed lookups,
  // optional chains) is the typechecker's job — not this diagnostic's.
  if (expr.base.type !== "variableName") return;
  const baseName = expr.base.value;
  if (scope.has(baseName)) return;
  if (baseName in ctx.functionDefs) return;
  if (baseName in ctx.importedFunctions) return;
  if (!(baseName in JS_GLOBALS)) return;

  const path = collectNamePath(expr, baseName);
  if (path === null) return; // Computed/optional access — bail.

  if (lookupJsMember(path) === null) {
    ctx.errors.push({
      message: `Function '${path.join(".")}' is not defined.`,
      severity: mode === "warn" ? "warning" : "error",
      loc: expr.loc,
    });
  }
}

/**
 * Walk a valueAccess chain, collecting member names. Returns null if the
 * chain contains anything we can't statically follow (computed lookup,
 * call-on-call, etc.) — caller bails out in that case.
 */
function collectNamePath(expr: ValueAccess, baseName: string): string[] | null {
  const path = [baseName];
  for (const access of expr.chain) {
    if (access.kind === "property") {
      path.push(access.name);
    } else if (access.kind === "methodCall") {
      path.push(access.functionCall.functionName);
    } else if (access.kind === "call") {
      // A call on the resolved chain is fine — leave path as-is.
      return path;
    } else {
      return null;
    }
  }
  return path;
}
