import { AgencyNode, FunctionCall, Literal } from "../types.js";
import { ValueAccess } from "./access.js";

export type ForLoop = {
  type: "forLoop";
  itemVar: string;
  indexVar?: string;
  iterable: ValueAccess | FunctionCall | Literal;
  body: AgencyNode[];
};
