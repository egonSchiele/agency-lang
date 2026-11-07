import type { AgencyNode } from "../types.js";
import type { GotoStatement } from "../types/gotoStatement.js";
import { bodySlots } from "../utils/bodySlots.js";
import { walkNodes, type WalkAncestor } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckError } from "./types.js";

/**
 * AG1036: a `goto` inside a body that runs as its own function. Those are
 * the bodies a `return` yields to (`retargetsReturn` in bodySlots.ts: a block
 * argument, an inline handler, a guard block, a finalize block) and the arms
 * of a `parallel` block, which become fork branches. A `goto` there would end
 * only that function, and the node would keep running.
 *
 * Tree-only, like `asyncRefusals`, so the compile path calls it even when
 * the type checker is off.
 */
export function gotoRefusals(programNodes: AgencyNode[]): TypeCheckError[] {
  return [...walkNodes(programNodes)]
    .filter(({ node, ancestors }) => node.type === "gotoStatement" && insideBlock(ancestors, node))
    .map(({ node }) => {
      const statement = node as GotoStatement;
      return diagnostic(
        "gotoInBlock",
        { target: statement.nodeCall.functionName },
        statement.loc ?? null,
      );
    });
}

/** True when a body on the path down to `node` runs as its own function. */
function insideBlock(ancestors: WalkAncestor[], node: AgencyNode): boolean {
  const path: WalkAncestor[] = [...ancestors, node];
  return ancestors.some(
    (ancestor, index) =>
      ancestor.type === "parallelBlock" || returnsFromOwnBody(ancestor, path[index + 1]),
  );
}

/** True when `child` is a statement in a body of `owner` that a `return`
 *  inside it returns from. */
function returnsFromOwnBody(owner: WalkAncestor, child: WalkAncestor): boolean {
  return bodySlots(owner as AgencyNode).some(
    (slot) => slot.retargetsReturn === true && slot.body.includes(child as AgencyNode),
  );
}
