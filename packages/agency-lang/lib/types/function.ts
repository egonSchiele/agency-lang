import {
  AgencyMultiLineComment,
  AgencyNode,
  Expression,
  Literal,
  ScopeType,
  VariableType,
} from "../types.js";
import { BaseNode } from "./base.js";
import { Hole } from "./hole.js";
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
  "onLLMRetry",
  "onLLMTimeout",
] as const;

export type CallbackName = (typeof VALID_CALLBACK_NAMES)[number];

/** Per-function retry-safety markers. Carried as one object from the AST
 *  through the symbol table and registries so adding a marker is a
 *  one-field change, not a parallel-boolean mirror pass across many files.
 *  Each field is present only when true. */
export type FunctionMarkers = {
  /** Re-running (or re-calling after a failure that started executing) may
   *  cause harm — the tool loop removes the tool if this ran. */
  destructive?: boolean;
  /** Re-calling with the same arguments has no additional effect. */
  idempotent?: boolean;
};

export type FunctionDefinition = BaseNode & {
  type: "function";
  /** A Hole only inside a template (`def #name(...)`); always a string in
   *  a compilable program. */
  functionName: string | Hole;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  returnTypeValidated?: boolean;
  docString?: MultiLineStringLiteral;
  docComment?: AgencyMultiLineComment;
  async?: boolean;
  markers?: FunctionMarkers;
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
  /** For block/blockArgs callee scope only: how many block scopes up the
   *  lexical chain the owning block is. 0 (or absent) = the current block. */
  blockDepth?: number;
  arguments: (Expression | SplatExpression | NamedArgument)[];
  block?: BlockArgument;
  async?: boolean;
  tags?: Tag[];
};


