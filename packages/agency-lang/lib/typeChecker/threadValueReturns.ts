import type { AgencyNode } from "../types.js";
import { bodySlots } from "../utils/bodySlots.js";
import { walkNodes } from "../utils/node.js";
import { isInScope } from "./checker.js";
import { diagnostic } from "./diagnostics.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";

/**
 * Warn about a `return` inside a `thread` or `subthread` block whose value
 * is assigned to a variable:
 *
 *     const reply = thread {
 *       return llm("Say hello.")
 *     }
 *
 * The `return` leaves the enclosing function. It does not give the block
 * its value, which is the block's list of messages. Someone who writes this
 * expects `reply` to hold the model's reply, as it would with a `guard`
 * block.
 */
export function checkThreadValueReturns(scopes: ScopeInfo[], ctx: TypeCheckerContext): void {
  for (const info of scopes) {
    const reported: AgencyNode[] = [];
    for (const { node, scopes: walkScopes } of walkNodes(info.body)) {
      if (!isInScope(walkScopes, info)) continue;
      if (node.type !== "assignment" || node.value?.type !== "messageThread") continue;
      for (const found of returnsThatLeaveTheFunction(node.value)) {
        // A thread value nested in another is walked from both.
        if (reported.includes(found)) continue;
        reported.push(found);
        ctx.errors.push(
          diagnostic("returnInThreadValue", { variable: node.variableName }, found.loc ?? null),
        );
      }
    }
  }
}

/** Every `return` under `node` that returns from the enclosing function. A
 *  block argument, a handler body, and a finalize body take a `return` for
 *  themselves, so the walk does not enter those. */
function returnsThatLeaveTheFunction(node: AgencyNode): AgencyNode[] {
  return bodySlots(node)
    .filter((slot) => !slot.retargetsReturn)
    .flatMap((slot) => slot.body)
    .flatMap((statement) =>
      statement.type === "returnStatement" ? [statement] : returnsThatLeaveTheFunction(statement),
    );
}
