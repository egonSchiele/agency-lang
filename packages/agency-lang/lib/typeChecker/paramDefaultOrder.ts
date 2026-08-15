import { declaredName } from "../types/hole.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";

/**
 * A parameter without a default may not follow one with a default — on
 * defs and nodes alike. Arguments bind positionally, so a call that
 * omits arguments can only ever omit TRAILING ones: `node t(a = "x",
 * b: string)` called as `t("only")` would fill `a` and silently leave
 * required `b` undefined (the arity check counts non-defaulted
 * parameters, which is the right minimum only when defaults are last).
 * Rejecting the shape here is what makes omitted-argument handling in
 * the emitter provably safe.
 */
export function checkParamDefaultOrder(ctx: TypeCheckerContext): void {
  for (const node of ctx.programNodes) {
    if (node.type !== "function" && node.type !== "graphNode") continue;
    const fn =
      node.type === "function" ? declaredName(node.functionName) : declaredName(node.nodeName);
    let sawDefault = false;
    for (const param of node.parameters ?? []) {
      if (param.defaultValue) {
        sawDefault = true;
      } else if (sawDefault && !param.variadic) {
        ctx.errors.push(
          diagnostic("requiredParamAfterDefault", { name: param.name, fn }, node.loc ?? null),
        );
      }
    }
  }
}
