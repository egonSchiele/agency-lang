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
