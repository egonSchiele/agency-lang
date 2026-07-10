import { TypeAliasEntry, ValueParam, VariableType } from "../types.js";
import { SourceLocation } from "../types/base.js";
import { TypeCheckError } from "./types.js";
import { visitTypes } from "./typeWalker.js";
import { UTILITY_TYPE_ARITY } from "./utilityTypes.js";

/** Built-in generic forms the typechecker / codegen know how to lower. */
const BUILTIN_GENERIC_ARITY: Record<string, number> = {
  Array: 1,
  Schema: 1,
  Record: 2,
  ...UTILITY_TYPE_ARITY,
};

/**
 * Validate value-param arity at a use site. Pushes one error to `errors`
 * if the arity is wrong. Returns true if a problem was reported.
 */
function checkValueArgsArity(
  aliasName: string,
  valueParams: ValueParam[] | undefined,
  valueArgsLen: number,
  context: string,
  errors: TypeCheckError[],
  loc: SourceLocation | undefined,
): boolean {
  // Use site has value args, but the alias takes no value params.
  if ((!valueParams || valueParams.length === 0) && valueArgsLen > 0) {
    errors.push({
      message: `Type '${aliasName}' is not a value-parameterized type but was given ${valueArgsLen} value argument${valueArgsLen === 1 ? "" : "s"} (referenced in '${context}').`,
      loc,
    });
    return true;
  }
  if (!valueParams) return false;

  if (valueArgsLen > valueParams.length) {
    errors.push({
      message: `${aliasName} expects at most ${valueParams.length} value argument${valueParams.length === 1 ? "" : "s"}, got ${valueArgsLen} (referenced in '${context}').`,
      loc,
    });
    return true;
  }
  // Each missing value arg must have a default.
  for (let i = valueArgsLen; i < valueParams.length; i++) {
    if (!valueParams[i].default) {
      // Phrase the message based on whether ANY args were supplied.
      if (valueArgsLen === 0) {
        const formals = valueParams.map((p) => p.name).join(", ");
        errors.push({
          message: `'${aliasName}' is a value-parameterized type and requires value arguments — write '${aliasName}(${formals})' (referenced in '${context}').`,
          loc,
        });
      } else {
        errors.push({
          message: `${aliasName} requires at least ${i + 1} value argument${i === 0 ? "" : "s"} (referenced in '${context}').`,
          loc,
        });
      }
      return true;
    }
  }
  return false;
}

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
      // Bare reference to a value-parameterized alias is only legal if
      // every value param has a default. `DivisibleBy` with no args when
      // `DivisibleBy(divisor: number)` requires one must be flagged here
      // — otherwise codegen blows up (e.g. `mapTypeToValidationSchema`)
      // or the program crashes at runtime with `<Name> is not defined`.
      checkValueArgsArity(
        t.aliasName,
        entry.valueParams,
        t.valueArgs?.length ?? 0,
        context,
        errors,
        loc,
      );
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
      // Generic alias may also be value-parameterized (e.g.
      // `BoundedList<T>(n)`). Validate the value-arg arity the same way
      // we do for `typeAliasVariable`.
      checkValueArgsArity(
        t.name,
        entry.valueParams,
        t.valueArgs?.length ?? 0,
        context,
        errors,
        loc,
      );
    }
  });
}
