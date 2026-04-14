import { AgencyNode, Expression, VariableType } from "../types.js";
import { BaseNode } from "./base.js";
import { FunctionParameter } from "./function.js";

export type ClassField = {
  type: "classField";
  name: string;
  typeHint: VariableType;
};

export type ClassMethod = {
  type: "classMethod";
  name: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType: VariableType;
};

export type ClassConstructor = {
  type: "classConstructor";
  parameters: FunctionParameter[];
  body: AgencyNode[];
};

export type ClassDefinition = BaseNode & {
  type: "classDefinition";
  className: string;
  fields: ClassField[];
  ctor?: ClassConstructor;
  methods: ClassMethod[];
  parentClass?: string;
};

/** Check if a variable name is a class-related keyword (this, super) that should bypass scope resolution. */
export function isClassKeyword(name: string): boolean {
  return name === "this" || name === "super";
}

export type NewExpression = BaseNode & {
  type: "newExpression";
  className: string;
  arguments: Expression[];
};
