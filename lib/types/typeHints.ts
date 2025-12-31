export type TypeHint = {
  type: "typeHint";
  variableName: string;
  variableType: VariableType;
};
export type VariableType =
  | PrimitiveType
  | ArrayType
  | StringLiteralType
  | NumberLiteralType
  | BooleanLiteralType
  | UnionType
  | ObjectType;

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
};
export type ObjectType = {
  type: "objectType";
  properties: ObjectProperty[];
};
