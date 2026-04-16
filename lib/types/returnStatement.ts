import { Expression } from "../types.js";
import { BaseNode } from "./base.js";

export type ReturnStatement = BaseNode & {
  type: "returnStatement";
  value?: Expression;
};
