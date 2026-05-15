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
import { MatchBlock } from "./types/matchBlock.js";
import { MessageThread } from "./types/messageThread.js";
import { ReturnStatement } from "./types/returnStatement.js";
import { GotoStatement } from "./types/gotoStatement.js";
import { Skill } from "./types/skill.js";
import { TypeAlias, VariableType } from "./types/typeHints.js";
import { WhileLoop } from "./types/whileLoop.js";
import { ParallelBlock, SeqBlock } from "./types/parallelBlock.js";
import { AwaitPending } from "./types/awaitPending.js";
import { HandleBlock } from "./types/handleBlock.js";
import { DebuggerStatement } from "./types/debuggerStatement.js";
import { WithModifier } from "./types/withModifier.js";
import { Tag } from "./types/tag.js";
import { TryExpression } from "./types/tryExpression.js";
import { ClassDefinition, ClassField, ClassMethod, NewExpression } from "./types/classDefinition.js";
import { InterruptStatement } from "./types/interruptStatement.js";
import { SchemaExpression } from "./types/schemaExpression.js";
import { BlockArgument } from "./types/blockArgument.js";
import { BindingPattern, IsExpression } from "./types/pattern.js";
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
export * from "./types/returnStatement.js";
export * from "./types/gotoStatement.js";
export * from "./types/typeHints.js";
export * from "./types/whileLoop.js";
export * from "./types/parallelBlock.js";
export * from "./types/forLoop.js";
export * from "./types/handleBlock.js";
export * from "./types/keyword.js";
export * from "./types/debuggerStatement.js";
export * from "./types/blockArgument.js";
export * from "./types/withModifier.js";
export * from "./types/base.js";
export * from "./types/tag.js";
export type { TryExpression } from "./types/tryExpression.js";
export * from "./types/classDefinition.js";
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
  | IsExpression;

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
  static?: boolean;
  declKind?: "let" | "const";
  value: Expression | MessageThread;
  tags?: Tag[];
  exported?: boolean;
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
  | GraphNodeDefinition
  | FunctionDefinition
  | Assignment
  | Literal
  | FunctionCall
  | MatchBlock
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
  | WithModifier
  | DebuggerStatement
  | Tag
  | TryExpression
  | ClassDefinition
  | ClassMethod
  | ClassField
  | NewExpression
  | RegexLiteral
  | SchemaExpression
  | InterruptStatement
  | BlockArgument
  | IsExpression;

export type AgencyProgram = {
  type: "agencyProgram";
  nodes: AgencyNode[];
  docComment?: AgencyMultiLineComment;
};

export type JSONEdge =
  | { type: "regular"; to: string }
  | { type: "conditional"; adjacentNodes: readonly string[] };
