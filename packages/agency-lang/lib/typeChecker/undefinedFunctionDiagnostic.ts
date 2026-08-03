import { diagnostic } from "./diagnostics.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { Scope } from "./scope.js";
import type { AgencyNode, FunctionCall } from "../types.js";
import type { ValueAccess, AccessChainElement } from "../types/access.js";
import { walkNodes } from "../utils/node.js";
import { holeNames } from "../utils/holes.js";
import {
  hasFunctionOrNodeAncestor,
  isResolvableBareCall,
} from "./nameReferences.js";
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

  // A file with holes is a template. AG8015 owns bare call names in it, so
  // reporting them here too would double up. It does not look at JS
  // namespace members — `nosuch` in `Math.nosuch()` is a method to it, not
  // a lexical name — so the chain check below keeps running.
  const isTemplateFile = holeNames(ctx.programNodes).length > 0;

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
          if (isTemplateFile) continue;
          if (!isResolvableBareCall(node, ancestors)) continue;
          checkBareCall(node, info.scope, ctx, mode, shadowing.importedNodeNames);
        } else if (node.type === "valueAccess") {
          checkAccessChain(node, info.scope, ctx, mode, shadowing);
        }
      }
    });
  }
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
// The hint text lives in the diagnostic registry (reservedBlockKeyword);
// this is just the set of keywords that trigger it.
const RESERVED_BLOCK_KEYWORDS = ["thread", "subthread"];


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
  const severity = mode === "warn" ? ("warning" as const) : ("error" as const);
  if (RESERVED_BLOCK_KEYWORDS.includes(call.functionName)) {
    ctx.errors.push(
      diagnostic(
        "reservedBlockKeyword",
        { keyword: call.functionName },
        call.loc ?? null,
        { severity },
      ),
    );
  } else {
    ctx.errors.push(
      diagnostic(
        "undefinedFunction",
        { name: call.functionName },
        call.loc ?? null,
        { severity },
      ),
    );
  }
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
    ctx.errors.push(
      diagnostic("undefinedFunction", { name: path.join(".") }, expr.loc ?? null, {
        severity: mode === "warn" ? "warning" : "error",
      }),
    );
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
