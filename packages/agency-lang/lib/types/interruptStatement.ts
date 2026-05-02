import { BaseNode } from "./base.js";
import { Expression } from "../types.js";
import { SplatExpression, NamedArgument } from "./dataStructures.js";

export type InterruptStatement = BaseNode & {
  type: "interruptStatement";
  kind: string; // e.g. "std::read", "myapp::deploy"
  arguments: (Expression | SplatExpression | NamedArgument)[];
};
