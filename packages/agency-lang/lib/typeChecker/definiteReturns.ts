import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { VariableType } from "../types.js";

type Severity = "silent" | "warn" | "error";

/** A declared return type that requires a value on every path. Exempt: absent/
 *  `null` (nothing declared), `void` (nothing to return), and `never` (means
 *  "does not return normally" — the message would be misleading, and a `never`
 *  function returning a value is a separate return-type-mismatch check's job).
 *  Every other declared type — including `any` — must be reached only by
 *  diverging paths. */
function requiresReturn(rt: VariableType | null | undefined): boolean {
  if (!rt) return false;
  if (rt.type === "primitiveType" && (rt.value === "void" || rt.value === "never")) return false;
  return true;
}

/**
 * Diagnostic: a function that declares a non-void return type but whose body can
 * reach its end without `return`ing. Uses the flow graph's terminal node
 * (`ctx.flowEnv.scopeTerminals`): `exit` means every path diverges. Nodes and
 * the top-level scope are exempt (not value-returning functions).
 *
 * Matches need no special handling since match expressions (7eefd7c1): a
 * statement-position arm cannot contain `return` (compile error), an
 * expression-position arm's `return` is a matchYield unwind (never a function
 * return, and passThrough to the flow graph), and `return match(...)` lowers to
 * the match region plus a REAL trailing return that the flow graph sees as
 * `exit`. So the terminal is exact for match-containing functions.
 * Config-gated via `typechecker.definiteReturns` (ships at `warn`).
 */
export function checkDefiniteReturns(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  const severity = (ctx.config.typechecker?.definiteReturns ?? "warn") as Severity;
  if (severity === "silent") return;
  const terminals = ctx.flowEnv?.scopeTerminals;
  if (!terminals) return;

  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    if (ctx.nodeDefs[info.name]) continue; // nodes are exempt (bare-keyed — index.ts:88)
    if (!requiresReturn(info.returnType)) continue;
    const terminal = terminals[info.scopeKey];
    if (terminal && terminal.kind !== "exit") {
      ctx.errors.push({
        message: `Not all code paths return a value in '${info.name}'.`,
        severity: severity === "warn" ? "warning" : "error",
        // Point at the signature, not the first statement in the body.
        loc: ctx.functionDefs[info.name]?.loc,
      });
    }
  }
}
