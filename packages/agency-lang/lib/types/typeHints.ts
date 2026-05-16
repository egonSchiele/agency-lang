import { AgencyMultiLineComment } from "../types.js";
import type { FunctionParameter } from "./function.js";
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
  | ResultType
  | SchemaType
  | FunctionRefType;

export type ResultType = {
  type: "resultType";
  successType: VariableType;
  failureType: VariableType;
};

/**
 * `Schema<T>` — synthesized type of a `schema(T)` expression. The runtime
 * `Schema` class wraps a zod schema and exposes `.parse(...)` /
 * `.parseJSON(...)`, both returning `Result<T, any>`. Carrying `inner`
 * lets the typechecker track the validated type through the call chain
 * (e.g. `schema(MyType).parse(x)` → `Result<MyType, any>`).
 */
export type SchemaType = {
  type: "schemaType";
  inner: VariableType;
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

export type FunctionRefType = {
  type: "functionRefType";
  name: string;
  params: FunctionParameter[];
  returnType: VariableType | null;
  returnTypeValidated?: boolean;
};

export type TypeAliasVariable = {
  type: "typeAliasVariable";
  aliasName: string;
};
