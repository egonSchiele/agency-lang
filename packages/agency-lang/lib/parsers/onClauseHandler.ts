import type { AgencyNode, Expression } from "@/types.js";
import type { IfElse } from "@/types/ifElse.js";

// The four verdict builtins a handler can return. A bare tail-position call to
// one of these is the author's verdict (`on std::read(data) { approve() }`),
// even though they wrote no `return`.
const VERDICT_NAMES = ["approve", "reject", "pass", "propagate"] as const;

function isBareVerdictCall(node: AgencyNode): boolean {
  return (
    node.type === "functionCall" &&
    (VERDICT_NAMES as readonly string[]).includes(node.functionName)
  );
}

/** Turn a tail-position bare verdict call into `return <call>`. Descends into a
 *  trailing `if` — with or without an else; each branch that exists is lifted —
 *  and nothing else. A trailing `match` is left as written (the author must
 *  write `return` inside its arms; completion then makes such a clause pass). */
export function liftTailVerdicts(body: AgencyNode[]): AgencyNode[] {
  if (body.length === 0) {
    return body;
  }
  const out = body.slice();
  const lastIdx = out.length - 1;
  const last = out[lastIdx];

  if (isBareVerdictCall(last)) {
    out[lastIdx] = { type: "returnStatement", value: last as Expression } as AgencyNode;
    return out;
  }

  if (last.type === "ifElse") {
    const ifNode = last as IfElse;
    const lifted: IfElse = { ...ifNode, thenBody: liftTailVerdicts(ifNode.thenBody) };
    if (ifNode.elseBody) {
      lifted.elseBody = liftTailVerdicts(ifNode.elseBody);
    }
    out[lastIdx] = lifted;
  }
  return out;
}

/** Does this statement list return a verdict on every path? A local walk, not a
 *  reuse: the typechecker's definite-return pass (`checkDefiniteReturns`,
 *  lib/typeChecker/definiteReturns.ts) needs scopes and a checker context and
 *  cannot run on a bare statement list at parse time. Mirrors the structure of
 *  `alwaysYields` (lib/lowering/patternLowering.ts:781) — keep the two aligned
 *  so they cannot drift — but keyed on `returnStatement`. Only a return and a
 *  both-branch if/else count, the same shapes lifting produces. Loops never
 *  count (syntactic all-paths rule). */
function definitelyReturns(body: AgencyNode[]): boolean {
  for (const stmt of body) {
    if (stmt.type === "returnStatement") {
      return true;
    }
    if (stmt.type === "ifElse") {
      const ifNode = stmt as IfElse;
      if (
        ifNode.elseBody &&
        definitelyReturns(ifNode.thenBody) &&
        definitelyReturns(ifNode.elseBody)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** After lifting, guarantee the clause returns a verdict on every path. A clause
 *  that produces no verdict means pass — the canonical handler default — so an
 *  unfinished clause gets `return pass()` appended. Without this, a
 *  side-effect-only or else-less conditional clause would trip the
 *  all-paths-return LoweringError (lib/lowering/patternLowering.ts:703) on the
 *  generated `match` the author never wrote. */
export function completeClause(body: AgencyNode[]): AgencyNode[] {
  if (definitelyReturns(body)) {
    return body;
  }
  const retPass: AgencyNode = {
    type: "returnStatement",
    value: { type: "functionCall", functionName: "pass", arguments: [] } as Expression,
  } as AgencyNode;
  return [...body, retPass];
}
