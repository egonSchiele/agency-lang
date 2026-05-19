import type { VariableType } from "../types.js";
import { mapTypes } from "./typeWalker.js";

/**
 * Substitute a set of type parameter names with concrete type arguments
 * inside a type-alias body.
 *
 * The "what" — replace any `typeAliasVariable` whose name appears in
 * `typeParams` with the corresponding entry in `typeArgs` — is expressed
 * here in one predicate. The "how" — enumerating every `VariableType`
 * variant — lives in `mapTypes`, so adding new variants does not
 * require touching this function.
 *
 * Examples:
 *   substituteTypeParams({ value: T }, ["T"], [string])
 *     => { value: string }
 *   substituteTypeParams(T[], ["T"], [string])
 *     => string[]
 *   substituteTypeParams(Wrapper<T>, ["T"], [string])
 *     => Wrapper<string>   (genericType.name preserved, typeArgs substituted)
 *
 * Unrelated `typeAliasVariable`s are returned unchanged.
 *
 * `typeParams` and `typeArgs` are assumed to be the same length; the
 * caller (`resolveType`) validates arity before calling.
 */
export function substituteTypeParams(
  body: VariableType,
  typeParams: string[],
  typeArgs: VariableType[],
): VariableType {
  const substitutionMap: Record<string, VariableType> = {};
  for (let i = 0; i < typeParams.length; i++) {
    substitutionMap[typeParams[i]] = typeArgs[i];
  }

  return mapTypes(body, (t) =>
    t.type === "typeAliasVariable" && t.aliasName in substitutionMap
      ? substitutionMap[t.aliasName]
      : t,
  );
}
