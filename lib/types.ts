import { Literal } from "@/types/literals";
import { TypeAlias, TypeHint } from "@/types/typeHints";
import { MatchBlock } from "./types/matchBlock";
export * from "@/types/typeHints";
export * from "@/types/literals";

export type Assignment = {
  type: "assignment";
  variableName: string;
  value: Literal | FunctionCall;
};

export type FunctionDefinition = {
  type: "function";
  functionName: string;
  body: ADLNode[];
};

export type FunctionCall = {
  type: "functionCall";
  functionName: string;
  arguments: (Literal | FunctionCall)[];
};

export type ReturnStatement = {
  type: "returnStatement";
  value: ADLNode;
};

export type ADLNode =
  | TypeHint
  | TypeAlias
  | FunctionDefinition
  | Assignment
  | Literal
  | FunctionCall
  | MatchBlock
  | ReturnStatement;

export type ADLProgram = {
  type: "adlProgram";
  nodes: ADLNode[];
};
