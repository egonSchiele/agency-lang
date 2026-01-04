import { Literal } from "@/types/literals";
import { TypeAlias, TypeHint, VariableType } from "@/types/typeHints";
import { MatchBlock } from "./types/matchBlock";
import { AccessExpression } from "./types/access";
import { FunctionCall, FunctionDefinition } from "./types/function";
import { ADLArray, ADLObject } from "./types/dataStructures";
import { GraphNodeDefinition } from "./types/graphNode";
import { ReturnStatement } from "./types/returnStatement";
import { UsesTool } from "./types/tools";
import { ImportStatement } from "./types/importStatement";
export * from "@/types/typeHints";
export * from "@/types/literals";
export * from "@/types/matchBlock";
export * from "@/types/access";
export * from "@/types/function";
export type Assignment = {
  type: "assignment";
  variableName: string;
  value: AccessExpression | Literal | FunctionCall | ADLObject | ADLArray;
};

export type ADLComment = {
  type: "comment";
  content: string;
};

export type ADLNode =
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
  | ADLComment
  | ADLObject
  | ADLArray
  | ImportStatement

export type ADLProgram = {
  type: "adlProgram";
  nodes: ADLNode[];
};

export type TypeHintMap = Record<string, VariableType>;
