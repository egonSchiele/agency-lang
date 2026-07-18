import type { AgencyNode, BaseNode } from "../types.js";
import { FunctionParameter } from "./function.js";

/** `finalize { ... }` — runs when an abort stops the enclosing scope; its
 *  return becomes the scope's forced return value (the salvage a guard
 *  receives). A declaration, not control flow: position in the body does
 *  not matter, and at most one is allowed per scope. The body compiles in
 *  the SAME variable scope as the enclosing function or block, so it
 *  reads the scope's locals directly. */
export type FinalizeBlock = BaseNode & {
  type: "finalizeBlock";
  /** `finalize as <name>` binder, parsed by the same asParser blocks
   *  use — the same field shape as BlockArgument.params. params[0] is
   *  the binder the scope's saved draft is yielded to; [] is the
   *  binder-less form. The grammar also admits multiple params and
   *  type hints; AG6038 (arity) and the binder-typing pass rule on
   *  those, not the parser. */
  params: FunctionParameter[];
  body: AgencyNode[];
};
