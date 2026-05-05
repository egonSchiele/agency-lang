import {
  AgencyMultiLineComment,
  AgencyNode,
  Expression,
  Literal,
  ScopeType,
  VariableType,
} from "../types.js";
import { BaseNode } from "./base.js";
import { BlockArgument } from "./blockArgument.js";
import { AgencyArray, AgencyObject, NamedArgument, SplatExpression } from "./dataStructures.js";
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
  "onTrace",
  "onOAuthRequired",
  "onEmit",
] as const;

export type CallbackName = (typeof VALID_CALLBACK_NAMES)[number];

export type CapturedVariable = {
  name: string;
  sourceScope: string;
  sourceType: "local" | "args";
};

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
  capturedVariables?: CapturedVariable[];
  selfReferencing?: boolean;
};

export type FunctionCall = BaseNode & {
  type: "functionCall";
  functionName: string;
  scope?: ScopeType;
  arguments: (Expression | SplatExpression | NamedArgument)[];
  block?: BlockArgument;
  async?: boolean;
  tags?: Tag[];
};

export type DocString = {
  type: "docString";
  value: string;
};
