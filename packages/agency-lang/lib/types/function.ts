import type { ListTrivia } from "./dataStructures.js";
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

/** The keywords that set a marker on a `def`, in the order the formatter
 *  prints them. The parser accepts them in any order. */
export const FUNCTION_MARKER_KEYWORDS = ["destructive", "idempotent", "handoff"] as const;
export type FunctionMarkerKeyword = (typeof FUNCTION_MARKER_KEYWORDS)[number];

/** Per-function markers. Carried as one object from the AST through the
 *  symbol table and registries so adding a marker is a one-word change to
 *  FUNCTION_MARKER_KEYWORDS plus a field here. Each field is present only
 *  when true. */
export type FunctionMarkers = {
  /** Re-running (or re-calling after a failure that started executing) may
   *  cause harm — the tool loop removes the tool if this ran. */
  destructive?: boolean;
  /** Re-calling with the same arguments has no additional effect. */
  idempotent?: boolean;
  /** Called as a tool, the function continues the caller's conversation:
   *  it runs on the caller's message thread and its tool-call bookkeeping
   *  is replaced by a marker and a resume message. See
   *  docs/dev/language/handoff-functions.md. */
  handoff?: boolean;
};

/** The keywords set on `markers`, in print order. */
export function markerKeywordsOf(markers: FunctionMarkers | undefined): FunctionMarkerKeyword[] {
  return FUNCTION_MARKER_KEYWORDS.filter((keyword) => markers?.[keyword] === true);
}

/** A markers object with exactly `keywords` set. */
export function markersFromKeywords(keywords: readonly FunctionMarkerKeyword[]): FunctionMarkers {
  return Object.fromEntries(keywords.map((keyword) => [keyword, true]));
}

export type FunctionDefinition = BaseNode & {
  type: "function";
  /** A Hole only inside a template (`def #name(...)`); always a string in
   *  a compilable program. */
  functionName: string | Hole;
  parameters: FunctionParameter[];
  /** Comments between parameters in the signature. */
  parameterTrivia?: ListTrivia[];
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
  /** Comments between arguments, in the order the call PRINTS. */
  argumentTrivia?: ListTrivia[];
  block?: BlockArgument;
  async?: boolean;
  tags?: Tag[];
  /** Set by pattern lowering on a call it synthesizes rather than one the user
   *  wrote (`__objectRest`). Such a call has no declaration to resolve — the
   *  TypeScript builder compiles it away — but the typechecker runs between
   *  the two passes and would report every one as undefined.
   *
   *  A field rather than a name check, matching how the lowerer already marks
   *  what it creates (`matchExprId`, `matchArmValueTemp`, `matchSource`): user
   *  code that happens to define `__objectRest` cannot spoof it, and the next
   *  synthesized call is covered without its author having to discover a
   *  registry in the diagnostic. */
  synthetic?: boolean;
};
