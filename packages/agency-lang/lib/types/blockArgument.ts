import { AgencyNode, VariableType } from "../types.js";
import { BaseNode } from "./base.js";
import { FunctionParameter } from "./function.js";

export type BlockArgument = BaseNode & {
  type: "blockArgument";
  params: FunctionParameter[];
  body: AgencyNode[];
  inline?: boolean;
  /** The block's declared yield type, when the user wrote it adjacent
   *  to the guard this block belongs to: the `T` of a `Result<T>`
   *  assignment annotation, or of the enclosing def/node's declared
   *  return for a return-position guard. Stamped by guardDesugar
   *  (#580); undefined on every other block. Codegen reads it to type
   *  the saveDraft schema inside the block. */
  declaredYieldType?: VariableType;
};
