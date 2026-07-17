import type { AgencyNode, BaseNode, Expression } from "../types.js";

/** The `guard(head) { body }` construct (spec:
 *  docs/superpowers/specs/2026-07-17-guard-keyword-design.md). The head
 *  is the parenthesized cost/time/label list; each argument is
 *  optional. Desugared by the preprocessor into the legacy
 *  functionCall + blockArgument shape calling `__guard` — see
 *  lib/preprocessors/guardDesugar.ts — so the builder and the runtime
 *  never see this node. The typechecker and the interrupt-effect
 *  analysis DO see it: it types as Result<T> and contributes
 *  `std::guard` to the containing function's effects. */
export type GuardBlock = BaseNode & {
  type: "guardBlock";
  cost: Expression | null;
  time: Expression | null;
  label: Expression | null;
  /** Source order of the named arguments, for source-faithful
   *  formatting. */
  argOrder: ("cost" | "time" | "label")[];
  body: AgencyNode[];
};
