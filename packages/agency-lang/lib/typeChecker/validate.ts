import { diagnostic } from "./diagnostics.js";
import { TypeAliasEntry, ValueParam, VariableType } from "../types.js";
import { SourceLocation } from "../types/base.js";
import { TypeCheckError } from "./types.js";
import { visitTypes } from "./typeWalker.js";
// Built-in generic forms (Array, Schema, Record, utility types) and their
// arities come from the single registry in builtinGenerics.ts.
import { BUILTIN_GENERIC_ARITY } from "./builtinGenerics.js";

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
    errors.push(
      diagnostic(
        "notValueParameterized",
        {
          alias: aliasName,
          count: valueArgsLen,
          argumentWord: valueArgsLen === 1 ? "argument" : "arguments",
          context,
        },
        loc ?? null,
      ),
    );
    return true;
  }
  if (!valueParams) return false;

  if (valueArgsLen > valueParams.length) {
    errors.push(
      diagnostic(
        "tooManyValueArgs",
        {
          alias: aliasName,
          max: valueParams.length,
          argumentWord: valueParams.length === 1 ? "argument" : "arguments",
          count: valueArgsLen,
          context,
        },
        loc ?? null,
      ),
    );
    return true;
  }
  // Each missing value arg must have a default.
  for (let i = valueArgsLen; i < valueParams.length; i++) {
    if (!valueParams[i].default) {
      // Phrase the message based on whether ANY args were supplied.
      if (valueArgsLen === 0) {
        const formals = valueParams.map((p) => p.name).join(", ");
        errors.push(
          diagnostic(
            "valueArgsRequired",
            { alias: aliasName, formals, context },
            loc ?? null,
          ),
        );
      } else {
        errors.push(
          diagnostic(
            "tooFewValueArgs",
            {
              alias: aliasName,
              min: i + 1,
              argumentWord: i === 0 ? "argument" : "arguments",
              context,
            },
            loc ?? null,
          ),
        );
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
        errors.push(
          diagnostic(
            "unknownTypeAlias",
            { alias: t.aliasName, context },
            loc ?? null,
          ),
        );
        return;
      }
      // Bare reference to a generic alias is only legal if every type
      // parameter has a default. Otherwise the user wrote `StringMap` where
      // they needed `StringMap<...>`.
      if (entry.typeParams && entry.typeParams.some((p) => !p.default)) {
        errors.push(
          diagnostic(
            "genericRequiresTypeArgs",
            { alias: t.aliasName, context },
            loc ?? null,
          ),
        );
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
          errors.push(
            diagnostic(
              "builtinGenericArity",
              {
                alias: t.name,
                expected: builtinArity,
                argumentWord: builtinArity === 1 ? "argument" : "arguments",
                count: t.typeArgs.length,
                context,
              },
              loc ?? null,
            ),
          );
        }
        return;
      }
      const entry = typeAliases[t.name];
      if (!entry) {
        errors.push(
          diagnostic("unknownGenericType", { alias: t.name, context }, loc ?? null),
        );
        return;
      }
      if (!entry.typeParams) {
        errors.push(
          diagnostic("notGenericType", { alias: t.name, context }, loc ?? null),
        );
        return;
      }
      if (t.typeArgs.length > entry.typeParams.length) {
        errors.push(
          diagnostic(
            "tooManyTypeArgs",
            {
              alias: t.name,
              max: entry.typeParams.length,
              argumentWord: entry.typeParams.length === 1 ? "argument" : "arguments",
              count: t.typeArgs.length,
              context,
            },
            loc ?? null,
          ),
        );
        return;
      }
      // Missing args are only legal when every missing param has a default.
      for (let i = t.typeArgs.length; i < entry.typeParams.length; i++) {
        if (!entry.typeParams[i].default) {
          errors.push(
            diagnostic(
              "tooFewTypeArgs",
              {
                alias: t.name,
                min: i + 1,
                argumentWord: i === 0 ? "argument" : "arguments",
                context,
              },
              loc ?? null,
            ),
          );
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
