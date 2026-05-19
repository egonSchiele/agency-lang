import { AgencyMultiLineComment, AgencyNode, FunctionCall, VariableType } from "../types.js";
import { ValueAccess } from "./access.js";
import { BaseNode } from "./base.js";
import { FunctionParameter } from "./function.js";
import { Literal, MultiLineStringLiteral } from "./literals.js";
import { Tag } from "./tag.js";

export type GraphNodeDefinition = BaseNode & {
  type: "graphNode";
  nodeName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  returnTypeValidated?: boolean;
  exported?: boolean;
  tags?: Tag[];
  docComment?: AgencyMultiLineComment;
  docString?: MultiLineStringLiteral;
};

export type NodeCall = {
  type: "nodeCall";
  nodeName: string;
  arguments: (Literal | ValueAccess | FunctionCall)[];
};
