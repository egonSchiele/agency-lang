import { Literal } from "@/types/literals";
import { TypeHint } from "@/types/typeHints";
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
  body: Array<Assignment | Literal>;
};

export type FunctionCall = {
  type: "functionCall";
  functionName: string;
  arguments: Literal[];
};

export type ADLNode =
  | TypeHint
  | FunctionDefinition
  | Assignment
  | Literal
  | FunctionCall
  | MatchBlock;

export type ADLProgram = {
  type: "adlProgram";
  nodes: ADLNode[];
};
