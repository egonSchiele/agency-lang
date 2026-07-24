import { AgencyMultiLineComment, AgencyNode, FunctionCall, VariableType } from "../types.js";
import { ValueAccess } from "./access.js";
import { BaseNode } from "./base.js";
import { Hole } from "./hole.js";
import { FunctionParameter } from "./function.js";
import { Literal, MultiLineStringLiteral } from "./literals.js";
import { Tag } from "./tag.js";

export type GraphNodeDefinition = BaseNode & {
  type: "graphNode";
  /** A Hole only inside a template (`node #name(...)`); always a string in
   *  a compilable program. */
  nodeName: string | Hole;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  returnTypeValidated?: boolean;
  exported?: boolean;
  tags?: Tag[];
  docComment?: AgencyMultiLineComment;
  docString?: MultiLineStringLiteral;
  /** Declared effect set this node may raise (`raises <...>`).
   *  Absent = unconstrained (may raise anything). */
  raises?: VariableType;
};

export type NodeCall = {
  type: "nodeCall";
  nodeName: string;
  arguments: (Literal | ValueAccess | FunctionCall)[];
};
