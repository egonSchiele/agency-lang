import {
  AccessExpression,
  AgencyNode,
  FunctionCall,
  IndexAccess,
  Literal,
} from "../types.js";

export type WhileLoop = {
  type: "whileLoop";
  condition: IndexAccess | FunctionCall | AccessExpression | Literal;
  body: AgencyNode[];
};
