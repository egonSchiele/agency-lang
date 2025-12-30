import { Literal } from "./types/literals";
import { TypeHint } from "./types/typeHints";
export * from "./types/typeHints";
export * from "./types/literals";

export type Assignment = {
  type: "assignment";
  variableName: string;
  value: Literal;
};

export type FunctionDefinition = {
  type: "function";
  functionName: string;
  body: Array<Assignment | Literal>;
};

export type FunctionCall = {
  type: "functionCall";
  functionName: string;
  arguments: string[];
};

export type ADLNode =
  | TypeHint
  | FunctionDefinition
  | Assignment
  | Literal
  | FunctionCall;

export type ADLProgram = {
  type: "adlProgram";
  nodes: ADLNode[];
};
