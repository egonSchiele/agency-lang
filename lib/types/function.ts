import {
  AgencyMultiLineComment,
  AgencyNode,
  Expression,
  Literal,
  VariableType,
} from "../types.js";
import { BaseNode } from "./base.js";
import { BlockArgument } from "./blockArgument.js";
import { AgencyArray, AgencyObject, NamedArgument, SplatExpression } from "./dataStructures.js";
import { UsesTool } from "./tools.js";
import { Tag } from "./tag.js";

export type FunctionParameter = {
  type: "functionParameter";
  name: string;
  typeHint?: VariableType;
  validated?: boolean;
  variadic?: boolean;
  defaultValue?: Literal | AgencyArray | AgencyObject;
};

export const VALID_CALLBACK_NAMES = [
  "onAgentStart",
  "onAgentEnd",
  "onNodeStart",
  "onNodeEnd",
  "onLLMCallStart",
  "onLLMCallEnd",
  "onFunctionStart",
  "onFunctionEnd",
  "onToolCallStart",
  "onToolCallEnd",
  "onStream",
  "onCheckpoint",
] as const;

export type CallbackName = (typeof VALID_CALLBACK_NAMES)[number];

export type FunctionDefinition = BaseNode & {
  type: "function";
  functionName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  returnTypeValidated?: boolean;
  docString?: DocString;
  docComment?: AgencyMultiLineComment;
  async?: boolean;
  safe?: boolean;
  exported?: boolean;
  callback?: boolean;
  tags?: Tag[];
};

export type FunctionCall = BaseNode & {
  type: "functionCall";
  functionName: string;
  arguments: (Expression | SplatExpression | NamedArgument)[];
  block?: BlockArgument;
  async?: boolean;
  tools?: UsesTool;
  tags?: Tag[];
};

export type DocString = {
  type: "docString";
  value: string;
};
