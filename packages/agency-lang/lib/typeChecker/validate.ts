import { TypeAliasEntry, VariableType } from "../types.js";
import { SourceLocation } from "../types/base.js";
import { TypeCheckError } from "./types.js";
import { visitTypes } from "./typeWalker.js";

/** Built-in generic forms the typechecker / codegen know how to lower. */
const BUILTIN_GENERIC_ARITY: Record<string, number> = {
  Array: 1,
  Schema: 1,
  Record: 2,
};

export function validateTypeReferences(
  vt: VariableType,
  context: string,
  typeAliases: Record<string, TypeAliasEntry>,
  errors: TypeCheckError[],
  loc?: SourceLocation,
): void {
  visitTypes(vt, (t) => {
    if (t.type === "typeAliasVariable") {
      const entry = typeAliases[t.aliasName];
      if (!entry) {
        errors.push({
          message: `Type alias '${t.aliasName}' is not defined (referenced in '${context}').`,
          loc,
        });
        return;
      }
      // Bare reference to a generic alias is only legal if every type
      // parameter has a default. Otherwise the user wrote `StringMap` where
      // they needed `StringMap<...>`.
      if (entry.typeParams && entry.typeParams.some((p) => !p.default)) {
        errors.push({
          message: `Generic type '${t.aliasName}' requires type arguments (referenced in '${context}').`,
          loc,
        });
      }
      return;
    }

    if (t.type === "genericType") {
      const builtinArity = BUILTIN_GENERIC_ARITY[t.name];
      if (builtinArity !== undefined) {
        if (t.typeArgs.length !== builtinArity) {
          errors.push({
            message: `${t.name} expects ${builtinArity} type argument${builtinArity === 1 ? "" : "s"}, got ${t.typeArgs.length} (referenced in '${context}').`,
            loc,
          });
        }
        return;
      }
      const entry = typeAliases[t.name];
      if (!entry) {
        errors.push({
          message: `Unknown generic type '${t.name}' (referenced in '${context}').`,
          loc,
        });
        return;
      }
      if (!entry.typeParams) {
        errors.push({
          message: `Type '${t.name}' is not a generic type (referenced in '${context}').`,
          loc,
        });
        return;
      }
      if (t.typeArgs.length > entry.typeParams.length) {
        errors.push({
          message: `${t.name} expects at most ${entry.typeParams.length} type argument${entry.typeParams.length === 1 ? "" : "s"}, got ${t.typeArgs.length} (referenced in '${context}').`,
          loc,
        });
        return;
      }
      // Missing args are only legal when every missing param has a default.
      for (let i = t.typeArgs.length; i < entry.typeParams.length; i++) {
        if (!entry.typeParams[i].default) {
          errors.push({
            message: `${t.name} requires at least ${i + 1} type argument${i === 0 ? "" : "s"} (referenced in '${context}').`,
            loc,
          });
          return;
        }
      }
    }
  });
}
