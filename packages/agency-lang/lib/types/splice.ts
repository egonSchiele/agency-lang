import { BaseNode } from "./base.js";
import type { Expression } from "../types.js";

/** A compile-time splice: `$( generatorCall(...) )`. The expression is
 *  evaluated DURING compilation and the `Code` value it returns is grafted
 *  in at this position.
 *
 *  Unlike `CodeLiteral`, a splice is NOT a host-side leaf. `expression` is
 *  ordinary host code and the walker MUST descend into it: the eligibility
 *  check reads the names it references, and the expansion pass reads its
 *  callee. Registering it as a leaf compiles fine and fails much later as a
 *  check that mysteriously sees nothing.
 *
 *  Every splice is removed by the expansion pass before codegen; reaching
 *  codegen with one is an internal error. */
export type Splice = BaseNode & {
  type: "splice";
  expression: Expression;
  /** Derived from which parser matched, never written by the user. */
  position: "decl" | "statement" | "expr";
};
