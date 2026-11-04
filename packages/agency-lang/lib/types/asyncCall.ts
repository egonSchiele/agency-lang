import type { AgencyNode } from "../types.js";
import type { FunctionCall } from "./function.js";
import type { ValueAccess } from "./access.js";
import type { VariableNameLiteral } from "./literals.js";

/** The node kinds that can carry the `async` flag. `asyncValueAccessParser`
 *  sets it on whatever `locatedValueAccessParser` returned: a bare name
 *  (`async x`), a call (`async f()`), or an access chain (`async a.b()`).
 *  No other parser sets it and no other node type declares it. */
export type AsyncFlagged = (FunctionCall | ValueAccess | VariableNameLiteral) & { async: true };

/** True when `node` was written with the `async` keyword. The lowering,
 *  the refusals, and the codegen tripwire all ask through this one
 *  function, so a new node kind that can carry the flag is added here and
 *  is then seen by all three. */
export function isAsyncFlagged(node: AgencyNode): node is AsyncFlagged {
  return (
    (node.type === "functionCall" || node.type === "valueAccess" || node.type === "variableName") &&
    node.async === true
  );
}
