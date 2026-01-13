import { Literal } from "./types/literals.js";
import { TypeAlias, TypeHint, VariableType } from "./types/typeHints.js";
import { MatchBlock } from "./types/matchBlock.js";
import { AccessExpression } from "./types/access.js";
import { FunctionCall, FunctionDefinition } from "./types/function.js";
import { AgencyArray, AgencyObject } from "./types/dataStructures.js";
import { GraphNodeDefinition } from "./types/graphNode.js";
import { ReturnStatement } from "./types/returnStatement.js";
import { UsesTool } from "./types/tools.js";
import { ImportStatement } from "./types/importStatement.js";
import { WhileLoop } from "./types/whileLoop.js";
import { SpecialVar } from "./types/specialVar.js";
export * from "./types/access.js";
export * from "./types/dataStructures.js";
export * from "./types/function.js";
export * from "./types/graphNode.js";
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
  value: AccessExpression | Literal | FunctionCall | AgencyObject | AgencyArray;
};

export type AgencyComment = {
  type: "comment";
  content: string;
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
  | WhileLoop
  | SpecialVar;

export type AgencyProgram = {
  type: "agencyProgram";
  nodes: AgencyNode[];
};

export type TypeHintMap = Record<string, VariableType>;
