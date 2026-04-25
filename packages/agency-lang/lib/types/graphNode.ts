import { AgencyMultiLineComment, AgencyNode, FunctionCall, VariableType } from "../types.js";
import { ValueAccess } from "./access.js";
import { BaseNode } from "./base.js";
import { DocString, FunctionParameter } from "./function.js";
import { Literal } from "./literals.js";
import { Tag } from "./tag.js";

/*
export type FunctionDefinition = {
  type: "function";
  functionName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  docString?: DocString;
};
*/

export type Visibility = "public" | "private" | undefined;

export type GraphNodeDefinition = BaseNode & {
  type: "graphNode";
  nodeName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  returnTypeValidated?: boolean;
  visibility?: Visibility;
  tags?: Tag[];
  docComment?: AgencyMultiLineComment;
  docString?: DocString;
};

export type NodeCall = {
  type: "nodeCall";
  nodeName: string;
  arguments: (Literal | ValueAccess | FunctionCall)[];
};
