import { Literal } from "@/types/literals";
import { TypeAlias, TypeHint } from "@/types/typeHints";
import { MatchBlock } from "./types/matchBlock";
import { AccessExpression } from "./types/access";
export * from "@/types/typeHints";
export * from "@/types/literals";

export type Assignment = {
  type: "assignment";
  variableName: string;
  value: AccessExpression | Literal | FunctionCall;
};

export type FunctionDefinition = {
  type: "function";
  functionName: string;
  body: ADLNode[];
};

export type FunctionCall = {
  type: "functionCall";
  functionName: string;
  arguments: (Literal | AccessExpression | FunctionCall)[];
};

export type ReturnStatement = {
  type: "returnStatement";
  value: ADLNode;
};

export type AwaitStatement = {
  type: "awaitStatement";
  value: Literal | AccessExpression | FunctionCall;
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
  | AwaitStatement;

export type ADLProgram = {
  type: "adlProgram";
  nodes: ADLNode[];
};
