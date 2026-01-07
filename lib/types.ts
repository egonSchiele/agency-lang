import { Literal } from "@/types/literals";
import { TypeAlias, TypeHint, VariableType } from "@/types/typeHints";
import { MatchBlock } from "./types/matchBlock";
import { AccessExpression } from "./types/access";
import { FunctionCall, FunctionDefinition } from "./types/function";
import { AgencyArray, AgencyObject } from "./types/dataStructures";
import { GraphNodeDefinition } from "./types/graphNode";
import { ReturnStatement } from "./types/returnStatement";
import { UsesTool } from "./types/tools";
import { ImportStatement } from "./types/importStatement";
import { WhileLoop } from "./types/whileLoop";
export * from "@/types/typeHints";
export * from "@/types/literals";
export * from "@/types/matchBlock";
export * from "@/types/access";
export * from "@/types/function";
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
  | WhileLoop;

export type AgencyProgram = {
  type: "agencyProgram";
  nodes: AgencyNode[];
};

export type TypeHintMap = Record<string, VariableType>;
