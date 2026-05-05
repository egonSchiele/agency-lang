import { VariableType } from "../types.js";
import { SourceLocation } from "../types/base.js";
import { TypeCheckError } from "./types.js";
import { visitTypes } from "./typeWalker.js";

export function validateTypeReferences(
  vt: VariableType,
  context: string,
  typeAliases: Record<string, VariableType>,
  errors: TypeCheckError[],
  loc?: SourceLocation,
): void {
  visitTypes(vt, (t) => {
    if (t.type === "typeAliasVariable" && !typeAliases[t.aliasName]) {
      errors.push({
        message: `Type alias '${t.aliasName}' is not defined (referenced in '${context}').`,
        loc,
      });
    }
  });
}
