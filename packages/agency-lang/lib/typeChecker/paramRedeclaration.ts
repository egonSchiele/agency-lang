import type { AgencyNode } from "../types.js";
import type { FunctionParameter } from "../types/function.js";
import { walkNodes, type WalkAncestor } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";

/**
 * A `let`/`const` in a function or node body may not reuse a parameter name
 * (AG4012).
 *
 * The generated code keeps parameters and locals in different slots. The
 * redeclare writes the local slot, but the preprocessor resolves every later
 * read of that name to the parameter slot, so the new value is never seen
 * (issue #717). Rejecting the shape is the cheap way to make the checker and
 * the runtime agree.
 *
 * Declarations inside a block argument are skipped: a block has its own
 * scope, and reads inside it resolve to the block's binding first.
 */
export function checkParameterRedeclarations(ctx: TypeCheckerContext): void {
  const defs = [...Object.values(ctx.functionDefs), ...Object.values(ctx.nodeDefs)];
  for (const def of defs) {
    const paramNames = def.parameters.map((p: FunctionParameter) => p.name);
    if (paramNames.length === 0) continue;
    for (const { node, ancestors } of walkNodes(def.body)) {
      if (node.type !== "assignment" || !node.declKind) continue;
      if (!paramNames.includes(node.variableName)) continue;
      if (ancestors.some(isOwnScope)) continue;
      ctx.errors.push(
        diagnostic(
          "parameterRedeclared",
          { name: node.variableName, declKind: node.declKind },
          node.loc ?? null,
        ),
      );
    }
  }
}

/** Ancestors that open a scope of their own, where a same-named declaration
 *  is a real shadow rather than a redeclare of the enclosing parameter. */
function isOwnScope(ancestor: WalkAncestor): boolean {
  const kind = (ancestor as AgencyNode).type;
  return kind === "blockArgument" || kind === "function" || kind === "graphNode";
}
