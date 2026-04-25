import { AgencyMultiLineComment } from "../types.js";
import { BaseNode } from "./base.js";

export type VariableType =
  | PrimitiveType
  | ArrayType
  | StringLiteralType
  | NumberLiteralType
  | BooleanLiteralType
  | UnionType
  | ObjectType
  | TypeAliasVariable
  | BlockType
  | ResultType;

export type ResultType = {
  type: "resultType";
  successType: VariableType;
  failureType: VariableType;
};

export type BlockType = {
  type: "blockType";
  params: { name: string; typeAnnotation: VariableType }[];
  returnType: VariableType;
};

export type PrimitiveType = {
  type: "primitiveType";
  value: string;
};

export type ArrayType = {
  type: "arrayType";
  elementType: VariableType;
};

export type StringLiteralType = {
  type: "stringLiteralType";
  value: string;
};

export type NumberLiteralType = {
  type: "numberLiteralType";
  value: string;
};

export type BooleanLiteralType = {
  type: "booleanLiteralType";
  value: "true" | "false";
};

export type UnionType = {
  type: "unionType";
  types: VariableType[];
};

export type ObjectProperty = {
  key: string;
  value: VariableType;
  description?: string;
};

export type ObjectType = {
  type: "objectType";
  properties: ObjectProperty[];
};

export type TypeAlias = BaseNode & {
  type: "typeAlias";
  aliasName: string;
  aliasedType: VariableType;
  exported?: boolean;
  docComment?: AgencyMultiLineComment;
};

export type TypeAliasVariable = {
  type: "typeAliasVariable";
  aliasName: string;
};
