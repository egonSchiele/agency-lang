import type { IfElse } from "../../types/ifElse.js";

/** The `if` that codegen folds into `node`'s chain as an `else if`: the
 *  only statement of `node`'s else body, when that statement is an `if`.
 *  Its condition is compiled as part of `node`, not as a statement of its
 *  own. Stepped and plain codegen both flatten through this, and the
 *  destructive tracking rule reads it to know the else-if is not a body. */
export function flattenedElseIf(node: IfElse): IfElse | undefined {
  const elseBody = node.elseBody;
  return elseBody?.length === 1 && elseBody[0].type === "ifElse"
    ? (elseBody[0] as IfElse)
    : undefined;
}
