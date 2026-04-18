import { BaseNode } from "./base.js";
import { VariableType } from "./typeHints.js";

export type SchemaExpression = BaseNode & {
  type: "schemaExpression";
  typeArg: VariableType;
};
