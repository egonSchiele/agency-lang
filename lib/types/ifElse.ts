import {
  AccessExpression,
  AgencyNode,
  FunctionCall,
  IndexAccess,
  Literal,
} from "../types.js";

export type IfElse = {
  type: "ifElse";
  condition: IndexAccess | FunctionCall | AccessExpression | Literal;
  thenBody: AgencyNode[];
  elseBody?: AgencyNode[];  // Optional for if-only statements
};
