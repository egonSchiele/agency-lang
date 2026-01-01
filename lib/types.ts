import { Literal } from "@/types/literals";
import { TypeAlias, TypeHint } from "@/types/typeHints";
import { MatchBlock } from "./types/matchBlock";
import { AccessExpression } from "./types/access";
import {
  FunctionCall,
  FunctionDefinition,
  ReturnStatement,
} from "./types/function";
export * from "@/types/typeHints";
export * from "@/types/literals";
export * from "@/types/matchBlock";
export * from "@/types/access";
export * from "@/types/function";
export type Assignment = {
  type: "assignment";
  variableName: string;
  value: AccessExpression | Literal | FunctionCall;
};

export type Comment = {
  type: "comment";
  content: string;
};

export type ADLNode =
  | TypeHint
  | TypeAlias
  | FunctionDefinition
  | Assignment
  | Literal
  | FunctionCall
  | MatchBlock
  | ReturnStatement
  | AccessExpression
  | Comment;

export type ADLProgram = {
  type: "adlProgram";
  nodes: ADLNode[];
};
