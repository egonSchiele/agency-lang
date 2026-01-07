import { AccessExpression, AgencyNode, FunctionCall, Literal } from "@/types";

export type WhileLoop = {
  type: "whileLoop";
  condition: FunctionCall | AccessExpression | Literal;
  body: AgencyNode[];
};
