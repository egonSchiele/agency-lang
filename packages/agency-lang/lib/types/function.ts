import type { ListTrivia } from "./dataStructures.js";
import {
  AgencyMultiLineComment,
  AgencyNode,
  Expression,
  Literal,
  ScopeType,
  VariableType,
} from "../types.js";
import { BaseNode, SourceLocation } from "./base.js";
import { Hole } from "./hole.js";
import { BlockArgument } from "./blockArgument.js";
import { AgencyArray, AgencyObject, NamedArgument, SplatExpression } from "./dataStructures.js";
import { MultiLineStringLiteral } from "./literals.js";
import { Tag } from "./tag.js";

export type FunctionParameter = {
  type: "functionParameter";
  name: string;
  /** Other names a runtime caller from outside the program (a model, an
   *  HTTP body, the command line) may use for this parameter, written
   *  `baseUrl | url: string`. The body never binds an alias, and Agency
   *  code that writes one gets an error. Absent when there are none. */
  aliases?: string[];
  typeHint?: VariableType;
  validated?: boolean;
  variadic?: boolean;
  defaultValue?: Literal | AgencyArray | AgencyObject;
};

/** Whether a function with these parameters can receive a block argument.
 *  The backend passes the block as the final positional argument, so the
 *  last parameter receives it: a block-typed slot, or one that could hold a
 *  block (untyped, or `any`). The type checker and the decorator check both
 *  use this, so they agree on what counts. */
export function lastParameterTakesBlock(parameters: FunctionParameter[]): boolean {
  const last = parameters[parameters.length - 1];
  if (!last) {
    return false;
  }
  const hint = last.typeHint;
  return (
    hint === undefined ||
    hint.type === "blockType" ||
    (hint.type === "primitiveType" && hint.value === "any")
  );
}

/** Whether a parameter is declared with a block type, `b: () -> T`. The
 *  lowering, the preprocessor, and the splice generator all ask this. */
export function isBlockParameter(parameter: FunctionParameter): boolean {
  return parameter.typeHint?.type === "blockType";
}

/** Whether these parameters are a decorator's: the second-to-last is named
 *  `call` and the last takes a block (docs/dev/language/decorators.md).
 *  Defaults are ignored here; `decoratorShapeProblem` reports them. */
export function hasDecoratorShape(parameters: FunctionParameter[]): boolean {
  const secondToLast = parameters[parameters.length - 2];
  return secondToLast?.name === "call" && lastParameterTakesBlock(parameters);
}

/** What is wrong with these parameters for a decorator, as the clause after
 *  "'d' cannot decorate 'f': ", or null when they have the decorator shape
 *  and neither `call` nor the block has a default. */
export function decoratorShapeProblem(parameters: FunctionParameter[]): string | null {
  if (parameters.length < 2 || !lastParameterTakesBlock(parameters)) {
    return "a decorator receives the body of the function it decorates as a block, so its last parameter must be a block, such as `block: (args: object) -> any`.";
  }
  const [callParam, blockParam] = parameters.slice(-2);
  if (callParam.name !== "call") {
    return `a decorator's last two parameters are \`call: Call\` and a block, so \`call\` must come right before the block. Found '${callParam.name}' there.`;
  }
  const defaulted = [callParam, blockParam].find((param) => param.defaultValue !== undefined);
  if (defaulted !== undefined) {
    return `'${defaulted.name}' has a default, but a decorator always receives \`call\` and the block. Remove the default.`;
  }
  return null;
}

/** The parameters a caller writes: all of them, or all but the trailing
 *  `call` and block the compiler supplies when the function is a decorator.
 *  The parser's ordering check, AG6039, and the checker's call checks all
 *  go through this, so the lowered shape is known in one place. */
export function callerSuppliedParameters(parameters: FunctionParameter[]): FunctionParameter[] {
  return hasDecoratorShape(parameters) ? parameters.slice(0, -2) : parameters;
}

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
  "onCheckpoint",
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
  /** The decorator tags that were written above this def and have been
   *  lowered into its body, outermost first. Set by decoratorDesugar, which
   *  moves them off `tags` so a second run finds nothing to lower. `agency
   *  fmt` never lowers, so it never sees this field. */
  decorators?: Tag[];
  /** Declared effect set this function may raise (`raises <...>`).
   *  Absent = unconstrained (may raise anything). */
  raises?: VariableType;
};

/** Where a call the decorator lowering synthesized came from: the decorator
 *  named by the tag, the tag's own location for diagnostics, and the def it
 *  was written on. */
export type DecoratorOrigin = {
  name: string;
  tagLoc: SourceLocation | undefined;
  target: string;
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
  /** Where the callee's name starts, when that is not where the node starts:
   *  in `async foo()` the node's `loc` starts at `async`. */
  nameLoc?: SourceLocation;
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
  /** Set by decoratorDesugar on the call it builds from a `@name(...)` tag,
   *  so a diagnostic about the call can point at the tag and name the
   *  decorator. */
  decorator?: DecoratorOrigin;
};
