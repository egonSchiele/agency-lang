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
import { MultiLineStringLiteral } from "./literals.js";
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
  "onThreadStart",
  "onThreadEnd",
] as const;

export type CallbackName = (typeof VALID_CALLBACK_NAMES)[number];

export type FunctionDefinition = BaseNode & {
  type: "function";
  functionName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  returnTypeValidated?: boolean;
  docString?: MultiLineStringLiteral;
  docComment?: AgencyMultiLineComment;
  async?: boolean;
  safe?: boolean;
  exported?: boolean;
  tags?: Tag[];
  /** Declared effect set this function may raise (`raises <...>`).
   *  Absent = unconstrained (may raise anything). */
  raises?: VariableType;
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


