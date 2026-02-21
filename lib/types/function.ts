import {
  AgencyArray,
  AgencyNode,
  AgencyObject,
  VariableType,
} from "../types.js";
import { ValueAccess } from "./access.js";
import { Literal } from "./literals.js";

export type FunctionParameter = {
  type: "functionParameter";
  name: string;
  typeHint?: VariableType;
};

export type FunctionDefinition = {
  type: "function";
  functionName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  docString?: DocString;
  async?: boolean;
};

export type FunctionCall = {
  type: "functionCall";
  functionName: string;
  arguments: (
    | AgencyArray
    | AgencyObject
    | ValueAccess
    | Literal
    | FunctionCall
  )[];
  async?: boolean;
};

export type DocString = {
  type: "docString";
  value: string;
};
