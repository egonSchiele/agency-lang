import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { Scope } from "./scope.js";
import type { AgencyNode, FunctionCall } from "../types.js";
import type { ValueAccess, AccessChainElement } from "../types/access.js";
import { walkNodes } from "../utils/node.js";
import {
  resolveCall,
  lookupJsMember,
  isJsGlobalBase,
} from "./resolveCall.js";
import { collectProgramShadowing } from "./shadowing.js";

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
  // Default is "warn" — the registries (BUILTIN_FUNCTION_TYPES,
  // importedFunctions via SymbolTable, JS_GLOBALS) are now accurate enough
  // that false positives are rare. Users can opt back into silence with
  // `{ typechecker: { undefinedFunctions: "silent" } }` in agency.json.
  const mode = ctx.config.typechecker?.undefinedFunctions ?? "warn";
  if (mode === "silent") return;

  const shadowing = collectProgramShadowing(ctx.programNodes);

  for (const info of scopes) {
    if (!info.name) continue;
    const isTopLevel = info.name === "top-level";
    ctx.withScope(info.scopeKey, () => {
      for (const { node, ancestors } of walkNodes(info.body)) {
        // When walking the top-level scope, skip anything inside a
        // function or graphNode body — those have their own ScopeInfo
        // and would double-fire.
        if (isTopLevel && hasFunctionOrNodeAncestor(ancestors)) continue;

        if (node.type === "functionCall") {
          // `walkNodes` descends into a `valueAccess`'s methodCall.functionCall.
          // That method-call is already covered by checkAccessChain on its
          // parent valueAccess; reporting it again here would double-fire and
          // also incorrectly treat `obj.foo()` as a bare call to `foo`.
          const parent = ancestors[ancestors.length - 1];
          if (parent && (parent as AgencyNode).type === "valueAccess") continue;
          checkBareCall(node, info.scope, ctx, mode, shadowing.importedNodeNames);
        } else if (node.type === "valueAccess") {
          checkAccessChain(node, info.scope, ctx, mode, shadowing);
        }
      }
    });
  }
}

function hasFunctionOrNodeAncestor(ancestors: readonly unknown[]): boolean {
  for (const a of ancestors) {
    const t = (a as AgencyNode | undefined)?.type;
    if (t === "function" || t === "graphNode") return true;
  }
  return false;
}

// --- Internal helpers ---

// Reserved block keywords that the parser turns into their own AST node
// when used correctly (`thread { ... }`, `subthread(args) { ... }`).
// When a user writes them with syntax the block parser doesn't accept
// (e.g. `thread(args) as { ... }` — `as` is not supported on thread
// blocks), the parser falls back to the generic functionCall form and
// the user sees a confusing "Function 'thread' is not defined" error.
// This map provides a tailored diagnostic instead, pointing the user at
// the actual mistake.
const RESERVED_BLOCK_KEYWORDS: Record<string, string> = {
  thread:
    "`thread` is a reserved block keyword. Write `thread { ... }` or " +
    "`thread(args) { ... }` directly — the `as` keyword is not supported " +
    "on thread blocks (there's nothing to bind).",
  subthread:
    "`subthread` is a reserved block keyword. Write `subthread { ... }` or " +
    "`subthread(args) { ... }` directly — the `as` keyword is not supported " +
    "on subthread blocks (there's nothing to bind).",
};

function checkBareCall(
  call: FunctionCall,
  scope: Scope,
  ctx: TypeCheckerContext,
  mode: "warn" | "error",
  importedNodeNames: readonly string[],
): void {
  const resolution = resolveCall(call.functionName, {
    functionDefs: ctx.functionDefs,
    nodeDefs: ctx.nodeDefs,
    importedFunctions: ctx.importedFunctions,
    importedNodeNames,
    jsImportedNames: ctx.jsImportedNames,
    scopeHas: (name) => scope.has(name),
  });
  if (resolution.kind !== "unresolved") return;
  // `in` instead of bracket access — bracket access walks the prototype chain,
  // so `RESERVED_BLOCK_KEYWORDS["toString"]` would otherwise return
  // `Object.prototype.toString` (a function), bypass the `??` default, and
  // push a non-string message.
  const blockHint = Object.prototype.hasOwnProperty.call(
    RESERVED_BLOCK_KEYWORDS,
    call.functionName,
  )
    ? RESERVED_BLOCK_KEYWORDS[call.functionName]
    : undefined;
  ctx.errors.push({
    message:
      blockHint ?? `Function '${call.functionName}' is not defined.`,
    severity: mode === "warn" ? "warning" : "error",
    loc: call.loc,
  });
}

function checkAccessChain(
  expr: ValueAccess,
  scope: Scope,
  ctx: TypeCheckerContext,
  mode: "warn" | "error",
  shadowing: { importedNodeNames: readonly string[] },
): void {
  // Only handle <variableName>.<member>... chains where the base is a JS
  // namespace global. Everything else (objects in scope, computed lookups,
  // optional chains) is the typechecker's job — not this diagnostic's.
  if (expr.base.type !== "variableName") return;
  const baseName = expr.base.value;
  if (
    !isJsGlobalBase(baseName, {
      scope,
      functionDefs: ctx.functionDefs,
      nodeDefs: ctx.nodeDefs,
      importedFunctions: ctx.importedFunctions,
      importedNodeNames: shadowing.importedNodeNames,
      jsImportedNames: ctx.jsImportedNames,
    })
  )
    return;

  // Only diagnose call sites — `Math.PI` (property lookup) is a value, not a
  // function. The chain must end in a callable element.
  const last = expr.chain[expr.chain.length - 1];
  if (!last || (last.kind !== "methodCall" && last.kind !== "call")) return;

  const path = collectNamePath(expr.chain, baseName);
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
function collectNamePath(
  chain: AccessChainElement[],
  baseName: string,
): string[] | null {
  const path = [baseName];
  for (const access of chain) {
    if (access.kind === "property") {
      path.push(access.name);
    } else if (access.kind === "methodCall") {
      path.push(access.functionCall.functionName);
    } else if (access.kind === "call") {
      // Terminal call on the resolved chain — leave path as-is.
      return path;
    } else {
      return null;
    }
  }
  return path;
}
