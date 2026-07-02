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
  /** Set by pattern lowering when this if/else is the lowered form of a match
   *  expression: the id the lowered `runner.ifElse` OWNS, so `matchYield`
   *  unwinds are consumed here. Undefined for ordinary if/else (no drift). */
  matchExprId?: number;
};
