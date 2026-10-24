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
import { formatTypeHint } from "../utils/formatType.js";
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

// What the compiler knows about a decorator's parameters. The functions
// below are the only place that reads `markers.decorator` or counts the
// trailing slots; the parser, the checker, the lowering, and the
// compilation unit all ask here (docs/dev/language/decorators.md).

/** A def or an imported signature: what the decorator questions below need. */
export type Decoratable = { parameters: FunctionParameter[]; markers?: FunctionMarkers };

/** Whether `def` was declared `decorator def`. The marker decides, never
 *  the parameters. */
export function isDecoratorDef(def: Decoratable): boolean {
  return def.markers?.decorator === true;
}

/** The parameters the compiler supplies to a decorator: the call record
 *  and the body as a block, the last two. */
export const DECORATOR_SLOT_COUNT = 2;

/** The record slot's type, `Call`. A fresh node each time: a type hint is
 *  spliced into a def's parameters, and a pass that annotates a hint in
 *  place must not write through to every decorator in the program. */
function recordSlotType(): VariableType {
  return { type: "typeAliasVariable", aliasName: "Call" };
}

/** The block slot's type, `(args: object) -> any`. Fresh for the same
 *  reason as `recordSlotType`. */
function blockSlotType(): VariableType {
  return {
    type: "blockType",
    params: [{ name: "args", typeAnnotation: { type: "primitiveType", value: "object" } }],
    returnType: { type: "primitiveType", value: "any" },
  };
}

/** The name of the parameter that receives the call record: the
 *  second-to-last. `call` when there is no such slot, so a lowering over a
 *  decorator in the wrong shape still builds a call the checks can see. */
export function recordSlotName(parameters: FunctionParameter[]): string {
  return parameters[parameters.length - DECORATOR_SLOT_COUNT]?.name ?? "call";
}

/** A decorator's parameters as the compiler sees them: an untyped record
 *  slot is `Call` and an untyped block slot is `(args: object) -> any`. A
 *  written type is kept. A plain def's parameters, and a decorator's that
 *  are too few to hold both slots (AG6043 says so), come back as they are.
 *  Never mutates: the parse tree the formatter prints keeps the user's
 *  text. The symbol table stores the result for every def, and
 *  `desugarDecorators` puts it on the def itself, so every reader of a
 *  decorator's signature sees the same filled slots. */
export function withDecoratorTypes(def: Decoratable): FunctionParameter[] {
  if (!isDecoratorDef(def) || def.parameters.length < DECORATOR_SLOT_COUNT) {
    return def.parameters;
  }
  const recordIndex = def.parameters.length - DECORATOR_SLOT_COUNT;
  const blockIndex = def.parameters.length - 1;
  return def.parameters.map((parameter, index) => {
    if (parameter.typeHint !== undefined) {
      return parameter;
    }
    if (index === recordIndex) {
      return { ...parameter, typeHint: recordSlotType() };
    }
    if (index === blockIndex) {
      return { ...parameter, typeHint: blockSlotType() };
    }
    return parameter;
  });
}

/** The body an alias name stands for, or undefined when the name is not
 *  an alias the caller can see. The checker passes its visible aliases; a
 *  caller with none passes nothing, and only the name `Call` is accepted. */
export type AliasResolver = (name: string) => VariableType | undefined;

const NO_ALIASES: AliasResolver = () => undefined;

/** The record a decorator receives, as its type is written in the prelude
 *  (`stdlib/index.agency`). The record slot's written type must resolve to
 *  this, so a file that redefines `Call` is refused: the decorator would
 *  be typed against a record it never receives. */
const CALL_RECORD_TYPE = "{ name: string, args: object }";

/** Whether `hint` is a type the record slot may carry: left off, `any`,
 *  the prelude's `Call`, or an alias of it (`type Ctx = Call`). Aliases
 *  are followed through `resolve`; an alias it cannot see is accepted only
 *  when it is named `Call`, because a program checked with no prelude
 *  loaded has nothing to resolve the name to. */
function isRecordSlotType(hint: VariableType | undefined, resolve: AliasResolver): boolean {
  if (hint === undefined) {
    return true;
  }
  const seen: string[] = [];
  let current = hint;
  while (current.type === "typeAliasVariable") {
    if (seen.includes(current.aliasName)) {
      return false;
    }
    seen.push(current.aliasName);
    const body = resolve(current.aliasName);
    if (body === undefined) {
      return current.aliasName === "Call";
    }
    current = body;
  }
  if (current.type === "primitiveType" && current.value === "any") {
    return true;
  }
  return formatTypeHint(current) === CALL_RECORD_TYPE;
}

/** What is wrong with a decorator's parameters, as the clause after
 *  "'d' is declared as a decorator, but ", or null when they are in shape:
 *  at least two, the last takes a block, the second-to-last is untyped or
 *  `Call` or `any`, and neither of the two has a default or is variadic.
 *  Names are free. `resolve` answers what an alias on the record slot
 *  stands for (see `isRecordSlotType`). */
export function decoratorShapeProblem(
  parameters: FunctionParameter[],
  resolve: AliasResolver = NO_ALIASES,
): string | null {
  if (parameters.length < DECORATOR_SLOT_COUNT) {
    return "a decorator takes at least two parameters: the call record and the body as a block.";
  }
  const [recordSlot, blockSlot] = parameters.slice(-DECORATOR_SLOT_COUNT);
  if (!lastParameterTakesBlock(parameters)) {
    const written = blockSlot.typeHint ? `: ${formatTypeHint(blockSlot.typeHint)}` : "";
    return `its last parameter must take the body as a block, such as \`block: (args: object) -> any\`. Found '${blockSlot.name}${written}'.`;
  }
  if (!isRecordSlotType(recordSlot.typeHint, resolve)) {
    return `'${recordSlot.name}' receives the call record, so its type must be \`Call\` or left off.`;
  }
  const defaulted = [recordSlot, blockSlot].find((slot) => slot.defaultValue !== undefined);
  if (defaulted !== undefined) {
    return `'${defaulted.name}' has a default, and a decorator always receives the call record and the block. Remove the default.`;
  }
  const variadic = [recordSlot, blockSlot].find((slot) => slot.variadic);
  if (variadic !== undefined) {
    return `'${variadic.name}' is variadic, but the call record and the block are one argument each.`;
  }
  return null;
}

/** The parameters a caller writes: all of them, or all but the trailing
 *  slots the compiler supplies when `def` is a decorator. AG6039 goes
 *  through this. */
export function callerSuppliedParameters(def: Decoratable): FunctionParameter[] {
  return isDecoratorDef(def) ? def.parameters.slice(0, -DECORATOR_SLOT_COUNT) : def.parameters;
}

/** The first parameter without a default that comes after one with a
 *  default, or null when defaults are last. Variadic parameters never
 *  count: `...rest` after a default is fine. Arguments bind positionally,
 *  so an omitted argument can only ever be a trailing one; this is the
 *  rule the parser enforces and AG6039 reports. */
export function requiredParameterAfterDefault(
  parameters: FunctionParameter[],
): FunctionParameter | null {
  let seenDefault = false;
  for (const parameter of parameters) {
    if (parameter.variadic) {
      continue;
    }
    if (parameter.defaultValue !== undefined) {
      seenDefault = true;
    } else if (seenDefault) {
      return parameter;
    }
  }
  return null;
}

/** Whether a plain def is a decorator missing its keyword: its parameters
 *  are in a decorator's shape, and they break the default-order rule only
 *  because the two trailing slots follow a defaulted parameter, which is
 *  exactly what `decorator def` allows. `def logged(tag: string | null =
 *  null, call: Call, block: () -> any)` is one. The parser lets such a def
 *  through so the decorator stage can say which keyword is missing
 *  (AG6045) instead of failing the parse with a message about parameter
 *  order. */
export function isDecoratorMissingKeyword(def: Decoratable): boolean {
  if (isDecoratorDef(def)) {
    return false;
  }
  const ownParameters = def.parameters.slice(0, -DECORATOR_SLOT_COUNT);
  return (
    requiredParameterAfterDefault(def.parameters) !== null &&
    requiredParameterAfterDefault(ownParameters) === null &&
    decoratorShapeProblem(def.parameters) === null
  );
}

/** The parameters the default-order rule is checked over: the caller's
 *  own, treating a decorator missing its keyword as the decorator it is so
 *  AG6045 is the one error it gets. The parser's check and AG6039 both
 *  go through this. */
export function orderCheckedParameters(def: Decoratable): FunctionParameter[] {
  if (isDecoratorMissingKeyword(def)) {
    return def.parameters.slice(0, -DECORATOR_SLOT_COUNT);
  }
  return callerSuppliedParameters(def);
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
export const FUNCTION_MARKER_KEYWORDS = [
  "destructive",
  "idempotent",
  "handoff",
  "decorator",
] as const;
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
  /** Declared `decorator def`: its last two parameters receive a call
   *  record and the decorated body as a block, and only such a def may be
   *  named in a tag. See docs/dev/language/decorators.md. */
  decorator?: boolean;
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
