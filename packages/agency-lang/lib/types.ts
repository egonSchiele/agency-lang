import { BaseNode } from "./types/base.js";
import { AccessChainElement, ValueAccess } from "./types/access.js";
import { BinOpExpression } from "./types/binop.js";
import {
  AgencyArray,
  AgencyObject,
  SplatExpression,
} from "./types/dataStructures.js";
import { FunctionCall, FunctionDefinition } from "./types/function.js";
import { GraphNodeDefinition } from "./types/graphNode.js";
import { IfElse } from "./types/ifElse.js";
import {
  ImportNodeStatement,
  ImportStatement,
} from "./types/importStatement.js";
import { ExportFromStatement } from "./types/exportFromStatement.js";
import { ForLoop } from "./types/forLoop.js";
import { Keyword } from "./types/keyword.js";
import { Literal, RawCode, RegexLiteral } from "./types/literals.js";
import { MatchArmMeta, MatchBlock } from "./types/matchBlock.js";
import { MatchYield } from "./types/matchYield.js";
import { MessageThread } from "./types/messageThread.js";
import { ReturnStatement } from "./types/returnStatement.js";
import { GotoStatement } from "./types/gotoStatement.js";
import { Skill } from "./types/skill.js";
import { TypeAlias, VariableType } from "./types/typeHints.js";
import { EffectDeclaration } from "./types/effectDeclaration.js";
import { WhileLoop } from "./types/whileLoop.js";
import { ParallelBlock, SeqBlock } from "./types/parallelBlock.js";
import { MarkDestructiveRan } from "./types/markDestructiveRan.js";
import { AwaitPending } from "./types/awaitPending.js";
import { HandleBlock } from "./types/handleBlock.js";
import { FinalizeBlock } from "./types/finalizeBlock.js";
import { GuardBlock } from "./types/guardBlock.js";
import { Comprehension } from "./types/comprehension.js";
import { DebuggerStatement } from "./types/debuggerStatement.js";
import { WithModifier } from "./types/withModifier.js";
import { StaticStatement } from "./types/staticStatement.js";
import { Tag } from "./types/tag.js";
import { TryExpression } from "./types/tryExpression.js";
import { NewExpression } from "./types/newExpression.js";
import { InterruptStatement } from "./types/interruptStatement.js";
import { SchemaExpression } from "./types/schemaExpression.js";
import { BlockArgument } from "./types/blockArgument.js";
import {
  ArrayPattern,
  BindingPattern,
  IsExpression,
  ObjectPattern,
  RestPattern,
  ResultPattern,
  WildcardPattern,
} from "./types/pattern.js";
export * from "./types/pattern.js";
export * from "./types/access.js";
export * from "./types/awaitPending.js";
export * from "./types/dataStructures.js";
export * from "./types/function.js";
export * from "./types/graphNode.js";
export * from "./types/ifElse.js";
export * from "./types/importStatement.js";
export * from "./types/exportFromStatement.js";
export * from "./types/literals.js";
export * from "./types/matchBlock.js";
export * from "./types/matchYield.js";
export * from "./types/returnStatement.js";
export * from "./types/gotoStatement.js";
export * from "./types/typeHints.js";
export * from "./types/whileLoop.js";
export * from "./types/parallelBlock.js";
export * from "./types/markDestructiveRan.js";
export * from "./types/forLoop.js";
export * from "./types/handleBlock.js";
export * from "./types/finalizeBlock.js";
export * from "./types/guardBlock.js";
export * from "./types/comprehension.js";
export * from "./types/keyword.js";
export * from "./types/debuggerStatement.js";
export * from "./types/blockArgument.js";
export * from "./types/withModifier.js";
export * from "./types/staticStatement.js";
export * from "./types/base.js";
export * from "./types/tag.js";
export type { TryExpression } from "./types/tryExpression.js";
export * from "./types/newExpression.js";
export * from "./types/interruptStatement.js";
export * from "./types/schemaExpression.js";

export type Expression =
  | ValueAccess
  | Literal
  | FunctionCall
  | BinOpExpression
  | AgencyArray
  | AgencyObject
  | TryExpression
  | NewExpression
  | RegexLiteral
  | SchemaExpression
  | InterruptStatement
  | BlockArgument
  | IsExpression
  | MatchBlock
  // Pre-lowering only: comprehensionDesugar rewrites every Comprehension
  // into map/filter/fork calls inside parseAgency's `lower` block, so
  // stages after the parser only meet one on a `lower: false` parse
  // (formatter, std::agency AST walks).
  | Comprehension;

/**
 * Runtime set of every `type` string in the `Expression` union above. Kept
 * co-located with the union so the two never drift. Used by the pattern
 * lowerer (`isExpressionNode`) to decide whether a single-statement match arm
 * is a bare expression (yield the value) versus a statement block (rewrite
 * returns). Keep in sync with the `Expression` union.
 */
export const EXPRESSION_NODE_TYPES: readonly string[] = [
  // ValueAccess
  "valueAccess",
  // Literal
  "number",
  "unitLiteral",
  "multiLineString",
  "string",
  "variableName",
  "boolean",
  "null",
  // remaining Expression members
  "functionCall",
  "binOpExpression",
  "agencyArray",
  "agencyObject",
  "tryExpression",
  "newExpression",
  "regex",
  "schemaExpression",
  "interruptStatement",
  "blockArgument",
  "isExpression",
  "matchBlock",
  "comprehension",
];

/** True when `node` is an `Expression` (per `EXPRESSION_NODE_TYPES`). */
export function isExpressionNode(node: { type: string }): node is Expression {
  return EXPRESSION_NODE_TYPES.includes(node.type);
}

/**
 * Scope types for variable resolution.
 * Before discussing scope, here's an important fact to know.
You can import agency nodes into TypeScript files and call them as functions. Each call of an agency node
gets isolated context execution. This means that all state in that call is going to be isolated from
any other calls happening concurrently. If an agent has a global variable named `globalVar`,
each call will get its own copy of `globalVar`.

 * - "global"   — variables global to a single .agency file
 * - "function" — function call execution scope
 * - "node"     — graph node execution scope
 * - "args"     — function/node parameters
 * - "imported" — variable from an import statement
 * - "static"   — initialized once, immutable, shared across all runs
 * - "local"    — a variable declared inside a function or node body (not including parameters)
 * 
 * ## Function vs Node Scope
 * There's some terminology conflation happening here. Sometimes scope means "what scope is this variable in?",
 * and sometimes scope means "what is the current execution scope: am I in a node or a function?"
 *
 * Node and function scopes exist not to tell us what scope a variable is in, but what the current execution scope is.
 * This is because some things work differently in functions versus nodes. For example, when returning from a node,
 * we wrap the result in an object and attach messages to the object as well.
 * 
 * ## Static
 * Static variables are initialized once at module load time, deeply frozen (immutable),
 * and shared across all runs of an agent. They are not serialized into checkpoints or
 * restored during interrupt replay — their value is always the original init value.
 *
 * Static variables are great for expensive one-time operations like reading prompt files:
 *
 * ```agency
 * static const prompt = read("prompt.txt")
 * ```
 */
export type BlockScope = {
  type: "block";
  blockName: string;
  /** The block's declared yield type, copied from the stamped
   *  BlockArgument (#580) when the builder pushes this scope. Set only
   *  for guard blocks whose result the user annotated `Result<T>`. */
  declaredYieldType?: VariableType;
};

export type Scope =
  | GlobalScope
  | FunctionScope
  | NodeScope
  | ImportedScope
  | StaticScope
  | LocalScope
  | BlockScope;
export type ScopeType = Scope["type"] | "args" | "blockArgs" | "functionRef";
export type GlobalScope = {
  type: "global";
};

export type FunctionScope = {
  type: "function";
  functionName: string;
  args?: boolean;
};

export type LocalScope = {
  type: "local";
};

export type NodeScope = {
  type: "node";
  nodeName: string;
  args?: boolean;
};

// imported via an import statement
export type ImportedScope = {
  type: "imported";
};

// static — initialized once, immutable, shared across all runs
export type StaticScope = {
  type: "static";
};

export type Assignment = BaseNode & {
  type: "assignment";
  variableName: string;
  pattern?: BindingPattern;
  accessChain?: AccessChainElement[];
  typeHint?: VariableType;
  validated?: boolean;
  scope?: ScopeType;
  /** For block/blockArgs scope only: how many block scopes up the lexical
   *  chain the owning block is. 0 (or absent) = the current/innermost block. */
  blockDepth?: number;
  static?: boolean;
  optimize?: boolean;
  declKind?: "let" | "const";
  value: Expression | MessageThread;
  tags?: Tag[];
  exported?: boolean;
  /** Set by pattern lowering on the synthetic scrutinee binding of a lowered
   *  `match` with pattern arms. A deep-cloned, body-free snapshot of the arms,
   *  so the type checker can recover the original arm structure (exhaustiveness;
   *  future match-native narrowing) even though the executable form is the
   *  lowered if-chain. Cloned and slimmed deliberately: it neither retains the
   *  un-lowered case bodies nor aliases live AST that later passes mutate in
   *  place. Ignored by codegen.
   *
   *  Only the pattern-arm lowering path sets this. The other two "this was a
   *  match" shapes are intentionally untagged: a literal/identifier match stays
   *  as a `matchBlock` node (read directly), and the `is`-form match is
   *  guard-based. A consumer must recognize all three deliberately. */
  matchSource?: MatchArmMeta[];
  /** Set by pattern lowering when this assignment consumes an expression-position
   *  `match`: `const x = match(E) { ... }`. The lowered form hoists the match
   *  region above and rewrites `value` to a reference to the `__matchval_<id>`
   *  temp; this field records the owning match id so later passes (typechecker
   *  union typing) can find the region that produces the value. Ignored by
   *  codegen (the value is a plain variable reference by then). */
  matchExprSource?: { matchId: number };
  /** Set by pattern lowering on the synthetic scrutinee binding of a lowered
   *  expression-position `match` with pattern arms. Marks that this assignment's
   *  `matchSource` describes an EXPRESSION match, so the exhaustiveness pass
   *  treats it as a hard error regardless of config. The paired if-chain root
   *  and the `MatchBlock` passthrough carry the same tag (see ifElse.ts /
   *  matchBlock.ts). Ignored by codegen. */
  matchExprId?: number;
  /** Set by pattern lowering on the synthetic temp binding that hoists a
   *  single-expression match/if arm whose value may interrupt (`"go" => f()`),
   *  so the call sits at statement position and gets the interrupt-propagation
   *  check (#430). Codegen re-applies the graph-node-transition guard to a
   *  binding carrying this tag: the node call is hidden inside a temp here, so
   *  `processMatchYield` (which reads the yielded value) can no longer see it. */
  matchArmValueTemp?: boolean;
};

export function globalScope(): Scope {
  return { type: "global" };
}

export function functionScope(functionName: string, args = false): Scope {
  return { type: "function", functionName, args };
}

export function nodeScope(nodeName: string, args = false): Scope {
  return { type: "node", nodeName, args };
}

export type AgencyComment = BaseNode & {
  type: "comment";
  content: string;
};

export type AgencyMultiLineComment = BaseNode & {
  type: "multiLineComment";
  content: string;
  isDoc: boolean;
  isModuleDoc: boolean;
};

export type NewLine = BaseNode & {
  type: "newLine";
};

export type AgencyNode =
  | TypeAlias
  | EffectDeclaration
  | GraphNodeDefinition
  | FunctionDefinition
  | Assignment
  | Literal
  | FunctionCall
  | MatchBlock
  | MatchYield
  | ReturnStatement
  | GotoStatement
  | ValueAccess
  | AgencyComment
  | AgencyMultiLineComment
  | AgencyObject
  | AgencyArray
  | ImportStatement
  | ImportNodeStatement
  | ExportFromStatement
  | WhileLoop
  | ParallelBlock
  | SeqBlock
  | MarkDestructiveRan
  | IfElse
  | NewLine
  | RawCode
  | MessageThread
  | Skill
  | BinOpExpression
  | Keyword
  | ForLoop
  | AwaitPending
  | HandleBlock
  | FinalizeBlock
  | GuardBlock
  | Comprehension
  | WithModifier
  | StaticStatement
  | DebuggerStatement
  | Tag
  | TryExpression
  | NewExpression
  | RegexLiteral
  | SchemaExpression
  | InterruptStatement
  | BlockArgument
  | IsExpression
  | ObjectPattern
  | ArrayPattern
  | RestPattern
  | WildcardPattern
  | ResultPattern;

export type AgencyProgram = {
  type: "agencyProgram";
  nodes: AgencyNode[];
  docComment?: AgencyMultiLineComment;
};

export type JSONEdge =
  | { type: "regular"; to: string }
  | { type: "conditional"; adjacentNodes: readonly string[] };
