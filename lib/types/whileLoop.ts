import { AccessExpression, AgencyNode, FunctionCall, Literal } from "../types.js";

export type WhileLoop = {
  type: "whileLoop";
  condition: FunctionCall | AccessExpression | Literal;
  body: AgencyNode[];
};
