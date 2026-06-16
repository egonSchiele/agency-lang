import { BaseNode } from "./base.js";
import { Expression } from "../types.js";
import { SplatExpression, NamedArgument } from "./dataStructures.js";

export type InterruptStatement = BaseNode & {
  type: "interruptStatement";
  effect: string; // e.g. "std::read", "myapp::deploy"
  arguments: (Expression | SplatExpression | NamedArgument)[];
  /** True when written as a `raise` statement (vs `interrupt(...)`).
   *  Codegen is identical; this only drives formatter output. */
  viaRaise?: boolean;
};
