import {
  AgencyNode,
  Expression,
} from "../types.js";
import { BaseNode } from "./base.js";

export type IfElse = BaseNode & {
  type: "ifElse";
  condition: Expression;
  thenBody: AgencyNode[];
  elseBody?: AgencyNode[]; // Optional for if-only statements
};
