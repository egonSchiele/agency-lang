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
  ImportToolStatement,
} from "./types/importStatement.js";
import { ForLoop } from "./types/forLoop.js";
import { Keyword } from "./types/keyword.js";
import { Literal, RawCode } from "./types/literals.js";
import { MatchBlock } from "./types/matchBlock.js";
import { MessageThread } from "./types/messageThread.js";
import { ReturnStatement } from "./types/returnStatement.js";
import { Skill } from "./types/skill.js";
import { SpecialVar } from "./types/specialVar.js";
import { UsesTool } from "./types/tools.js";
import { TypeAlias, VariableType } from "./types/typeHints.js";
import { WhileLoop } from "./types/whileLoop.js";
import { AwaitPending } from "./types/awaitPending.js";
import { HandleBlock } from "./types/handleBlock.js";
import { Sentinel } from "./types/sentinel.js";
import { DebuggerStatement } from "./types/debuggerStatement.js";
import { Placeholder } from "./types/placeholder.js";
import { WithModifier } from "./types/withModifier.js";
export * from "./types/access.js";
export * from "./types/awaitPending.js";
export * from "./types/dataStructures.js";
export * from "./types/function.js";
export * from "./types/graphNode.js";
export * from "./types/ifElse.js";
export * from "./types/importStatement.js";
export * from "./types/literals.js";
export * from "./types/matchBlock.js";
export * from "./types/returnStatement.js";
export * from "./types/specialVar.js";
export * from "./types/tools.js";
export * from "./types/typeHints.js";
export * from "./types/whileLoop.js";
export * from "./types/forLoop.js";
export * from "./types/handleBlock.js";
export * from "./types/keyword.js";
export * from "./types/sentinel.js";
export * from "./types/debuggerStatement.js";
export * from "./types/blockArgument.js";
export * from "./types/placeholder.js";
export * from "./types/withModifier.js";
export * from "./types/base.js"

export type Expression =
  | ValueAccess
  | Literal
  | FunctionCall
  | BinOpExpression
  | AgencyArray
  | AgencyObject
  | Placeholder;

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
 * - "shared"   — shared across all calls to an agent
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
 * ## Shared
 * Shared variables are global variables that are shared across all calls to an agency node function.
 * These are the only types of variables that don't get isolated execution context. If you have
 * a shared variable named `sharedVar`, that variable will be shared across all calls happening
 * now and in the future.
 * Agency has a feature to save and restore state between interrupts. All state gets saved and restored,
 * *except* shared variables. Because shared variables are shared across all calls there's no need
 * to save or restore them.
 * 
 * Shared variables are great for caching or for expensive operations like reading the contents of a file.
 * Because each call gets its own copy of a global variable, that means that global variables are initialized
 * fresh for each call. If the initialization is an expensive operation, such as making an HTTP call,
 * you will pay that cost on every invocation of your agent:
 * 
 * ```agency
 * // this will be called on every invocation of the agent
 * let globalVar = fetch("https://example.com/api/data");
 * ```
 *
 * You can instead use a shared variable, and the variable will only be initialized once and used for all requests:
 *
 * ```agency
 * // this will only be called once, and the result will be shared across all invocations of the agent
 * shared const foo = fetch("https://example.com/api/data");
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
  | SharedScope
  | LocalScope
  | BlockScope;
export type ScopeType = Scope["type"] | "args" | "blockArgs";
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

// shared across all calls — lives in module namespace, not on execution context
export type SharedScope = {
  type: "shared";
};

export type Assignment = BaseNode & {
  type: "assignment";
  variableName: string;
  accessChain?: AccessChainElement[];
  typeHint?: VariableType;
  scope?: ScopeType;
  shared?: boolean;
  declKind?: "let" | "const";
  value: Expression | MessageThread;
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
};

export type NewLine = BaseNode & {
  type: "newLine";
};

export type AgencyNode =
  | TypeAlias
  | UsesTool
  | GraphNodeDefinition
  | FunctionDefinition
  | Assignment
  | Literal
  | FunctionCall
  | MatchBlock
  | ReturnStatement
  | ValueAccess
  | AgencyComment
  | AgencyMultiLineComment
  | AgencyObject
  | AgencyArray
  | ImportStatement
  | ImportNodeStatement
  | ImportToolStatement
  | WhileLoop
  | IfElse
  | SpecialVar
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
  | Sentinel
  | DebuggerStatement
  | Placeholder;

export type AgencyProgram = {
  type: "agencyProgram";
  nodes: AgencyNode[];
};

export type JSONEdge =
  | { type: "regular"; to: string }
  | { type: "conditional"; adjacentNodes: readonly string[] };
