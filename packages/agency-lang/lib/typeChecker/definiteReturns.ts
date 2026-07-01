import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { AgencyNode, VariableType } from "../types.js";
import { walkNodes } from "../utils/node.js";

type Severity = "silent" | "warn" | "error";

/**
 * SAFE-SUBSET GUARD: skip any function whose body contains a `match`. Whether a
 * match-ending function returns on every path depends on whether the match is
 * EXHAUSTIVE (a `Result` match over success/failure always is; a `number` match
 * over `1`/`2` is not), which lives in `checkMatchExhaustiveness`, not in the
 * flow graph. A `match` lowers to an if-chain (or stays a `matchBlock` for pure
 * literals) whose "no arm matched" tail looks like a fall-through, so checking
 * these here would false-positive on the idiomatic exhaustive Result match.
 * Definite-return over matches is deferred to a follow-up that reuses the
 * exhaustiveness result. Detect both lowered matches (an `assignment` carrying
 * `matchSource`) and un-lowered pure-literal matches (`matchBlock`).
 */
function containsMatch(body: AgencyNode[]): boolean {
  for (const { node } of walkNodes(body)) {
    if (node.type === "matchBlock") return true;
    if (node.type === "assignment" && node.matchSource) return true;
  }
  return false;
}

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
 * the top-level scope are exempt (not value-returning functions). Functions that
 * use a `match` are skipped in this first release (see `containsMatch`).
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
    if (containsMatch(info.body)) continue; // safe subset: matches deferred
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
