import { VariableType } from "../types.js";
import { SourceLocation } from "../types/base.js";
import { TypeCheckError } from "./types.js";

export function validateTypeReferences(
  vt: VariableType,
  context: string,
  typeAliases: Record<string, VariableType>,
  errors: TypeCheckError[],
  loc?: SourceLocation,
): void {
  switch (vt.type) {
    case "typeAliasVariable":
      if (!typeAliases[vt.aliasName]) {
        errors.push({
          message: `Type alias '${vt.aliasName}' is not defined (referenced in '${context}').`,
          loc,
        });
      }
      break;
    case "arrayType":
      validateTypeReferences(vt.elementType, context, typeAliases, errors);
      break;
    case "unionType":
      for (const t of vt.types) {
        validateTypeReferences(t, context, typeAliases, errors);
      }
      break;
    case "objectType":
      for (const prop of vt.properties) {
        validateTypeReferences(prop.value, context, typeAliases, errors);
      }
      break;
  }
}
