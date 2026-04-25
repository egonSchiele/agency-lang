import { AgencyNode } from "../types.js";
import { BaseNode } from "./base.js";
import { FunctionParameter } from "./function.js";

export type BlockArgument = BaseNode & {
  type: "blockArgument";
  params: FunctionParameter[];
  body: AgencyNode[];
  inline?: boolean;
};
