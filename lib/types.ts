import { AccessExpression, DotProperty, IndexAccess } from "./types/access.js";
import { AwaitStatement } from "./types/await.js";
import { AgencyArray, AgencyObject } from "./types/dataStructures.js";
import { FunctionCall, FunctionDefinition } from "./types/function.js";
import { GraphNodeDefinition } from "./types/graphNode.js";
import {
  ImportNodeStatement,
  ImportStatement,
  ImportToolStatement,
} from "./types/importStatement.js";
import { Literal, RawCode } from "./types/literals.js";
import { MatchBlock } from "./types/matchBlock.js";
import { ReturnStatement } from "./types/returnStatement.js";
import { SpecialVar } from "./types/specialVar.js";
import { TimeBlock } from "./types/timeBlock.js";
import { UsesTool } from "./types/tools.js";
import { TypeAlias, TypeHint, VariableType } from "./types/typeHints.js";
import { WhileLoop } from "./types/whileLoop.js";
import { IfElse } from "./types/ifElse.js";
export * from "./types/access.js";
export * from "./types/dataStructures.js";
export * from "./types/function.js";
export * from "./types/graphNode.js";
export * from "./types/ifElse.js";
export * from "./types/importStatement.js";
export * from "./types/literals.js";
export * from "./types/matchBlock.js";
export * from "./types/returnStatement.js";
export * from "./types/tools.js";
export * from "./types/typeHints.js";
export * from "./types/whileLoop.js";

export type Assignment = {
  type: "assignment";
  variableName: string;
  typeHint?: VariableType;
  value:
  | AccessExpression
  | Literal
  | FunctionCall
  | AgencyObject
  | AgencyArray
  | IndexAccess
  | TimeBlock;
};

export type AgencyComment = {
  type: "comment";
  content: string;
};

export type NewLine = {
  type: "newLine";
};

export type AgencyNode =
  | TypeHint
  | TypeAlias
  | UsesTool
  | GraphNodeDefinition
  | FunctionDefinition
  | Assignment
  | Literal
  | FunctionCall
  | MatchBlock
  | ReturnStatement
  | AccessExpression
  | AgencyComment
  | AgencyObject
  | AgencyArray
  | ImportStatement
  | ImportNodeStatement
  | ImportToolStatement
  | WhileLoop
  | IfElse
  | SpecialVar
  | IndexAccess
  | DotProperty
  | TimeBlock
  | NewLine
  | RawCode;

export type AgencyProgram = {
  type: "agencyProgram";
  nodes: AgencyNode[];
};

export type TypeHintMap = Record<string, VariableType>;
