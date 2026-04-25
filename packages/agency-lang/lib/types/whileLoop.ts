import {
  AgencyNode,
  Expression,
} from "../types.js";
import { BaseNode } from "./base.js";

export type WhileLoop = BaseNode & {
  type: "whileLoop";
  condition: Expression;
  body: AgencyNode[];
};
