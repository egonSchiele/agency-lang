import { VariableType } from "../types.js";
import { BOOLEAN_T, NUMBER_T, STRING_T } from "./primitives.js";

export function resolveType(
  vt: VariableType,
  typeAliases: Record<string, VariableType>,
): VariableType {
  if (vt.type === "typeAliasVariable") {
    const resolved = typeAliases[vt.aliasName];
    if (resolved) return resolveType(resolved, typeAliases);
    return vt;
  }
  return vt;
}

export function widenType(vt: VariableType | "any"): VariableType | "any" {
  if (vt === "any") return "any";
  switch (vt.type) {
    case "stringLiteralType":
      return STRING_T;
    case "numberLiteralType":
      return NUMBER_T;
    case "booleanLiteralType":
      return BOOLEAN_T;
    case "objectType":
      return {
        type: "objectType",
        properties: vt.properties.map((p) => ({
          key: p.key,
          value: widenType(p.value) as VariableType,
        })),
      };
    case "arrayType":
      return {
        type: "arrayType",
        elementType: widenType(vt.elementType) as VariableType,
      };
    case "unionType":
      return {
        type: "unionType",
        types: vt.types.map((t) => widenType(t) as VariableType),
      };
    case "resultType":
      return {
        type: "resultType",
        successType: widenType(vt.successType) as VariableType,
        failureType: widenType(vt.failureType) as VariableType,
      };
    default:
      return vt;
  }
}

/**
 * A type that admits `undefined` as a value, so the corresponding object
 * property may be absent from the source. Covers the `key?: T` desugaring
 * (parsed as `T | undefined`) plus `any`, which subsumes undefined.
 */
function isOptionalType(
  vt: VariableType,
  typeAliases: Record<string, VariableType>,
): boolean {
  const resolved = resolveType(vt, typeAliases);
  if (resolved.type === "primitiveType")
    return resolved.value === "undefined" || resolved.value === "any";
  if (resolved.type === "unionType")
    return resolved.types.some((t) => isOptionalType(t, typeAliases));
  return false;
}

export function isAssignable(
  source: VariableType | "any",
  target: VariableType | "any",
  typeAliases: Record<string, VariableType>,
): boolean {
  if (source === "any" || target === "any") return true;

  const resolvedSource = resolveType(source, typeAliases);
  const resolvedTarget = resolveType(target, typeAliases);

  // primitiveType("any") behaves the same as the "any" sentinel
  if (
    (resolvedSource.type === "primitiveType" && resolvedSource.value === "any") ||
    (resolvedTarget.type === "primitiveType" && resolvedTarget.value === "any")
  ) {
    return true;
  }

  // unknown as target: anything can be assigned to unknown
  if (resolvedTarget.type === "primitiveType" && resolvedTarget.value === "unknown") {
    return true;
  }

  // unknown as source: only assignable to any (handled above) or unknown
  if (resolvedSource.type === "primitiveType" && resolvedSource.value === "unknown") {
    return false;
  }

  // Union type as source: every member must be assignable to target
  if (resolvedSource.type === "unionType") {
    return resolvedSource.types.every((t) =>
      isAssignable(t, resolvedTarget, typeAliases),
    );
  }

  // Union type as target: source must be assignable to at least one member
  if (resolvedTarget.type === "unionType") {
    return resolvedTarget.types.some((t) =>
      isAssignable(resolvedSource, t, typeAliases),
    );
  }

  // Literal types assignable to their base primitives
  if (resolvedTarget.type === "primitiveType") {
    if (
      resolvedSource.type === "stringLiteralType" &&
      resolvedTarget.value === "string"
    )
      return true;
    if (
      resolvedSource.type === "numberLiteralType" &&
      resolvedTarget.value === "number"
    )
      return true;
    if (
      resolvedSource.type === "booleanLiteralType" &&
      resolvedTarget.value === "boolean"
    )
      return true;
  }

  // ObjectType assignable to object primitive (but not the reverse)
  if (
    resolvedSource.type === "objectType" &&
    resolvedTarget.type === "primitiveType" &&
    resolvedTarget.value === "object"
  ) {
    return true;
  }

  // Same kind matching
  if (
    resolvedSource.type === "primitiveType" &&
    resolvedTarget.type === "primitiveType"
  ) {
    return resolvedSource.value === resolvedTarget.value;
  }

  if (
    resolvedSource.type === "stringLiteralType" &&
    resolvedTarget.type === "stringLiteralType"
  ) {
    return resolvedSource.value === resolvedTarget.value;
  }

  if (
    resolvedSource.type === "numberLiteralType" &&
    resolvedTarget.type === "numberLiteralType"
  ) {
    return resolvedSource.value === resolvedTarget.value;
  }

  if (
    resolvedSource.type === "booleanLiteralType" &&
    resolvedTarget.type === "booleanLiteralType"
  ) {
    return resolvedSource.value === resolvedTarget.value;
  }

  if (
    resolvedSource.type === "arrayType" &&
    resolvedTarget.type === "arrayType"
  ) {
    return isAssignable(
      resolvedSource.elementType,
      resolvedTarget.elementType,
      typeAliases,
    );
  }

  // Block types: contravariant in parameters, covariant in return — standard
  // function compatibility. Arity must match exactly (no auto-extension).
  if (
    resolvedSource.type === "blockType" &&
    resolvedTarget.type === "blockType"
  ) {
    if (resolvedSource.params.length !== resolvedTarget.params.length)
      return false;
    for (let i = 0; i < resolvedSource.params.length; i++) {
      if (
        !isAssignable(
          resolvedTarget.params[i].typeAnnotation,
          resolvedSource.params[i].typeAnnotation,
          typeAliases,
        )
      )
        return false;
    }
    return isAssignable(
      resolvedSource.returnType,
      resolvedTarget.returnType,
      typeAliases,
    );
  }

  // Result<T, E>: covariant in both type parameters.
  if (
    resolvedSource.type === "resultType" &&
    resolvedTarget.type === "resultType"
  ) {
    return (
      isAssignable(resolvedSource.successType, resolvedTarget.successType, typeAliases) &&
      isAssignable(resolvedSource.failureType, resolvedTarget.failureType, typeAliases)
    );
  }

  if (
    resolvedSource.type === "objectType" &&
    resolvedTarget.type === "objectType"
  ) {
    // Structural: source must have all properties of target with compatible
    // types. A target property whose type permits `undefined` (the desugaring
    // of `key?:`) may be omitted from the source.
    for (const targetProp of resolvedTarget.properties) {
      const sourceProp = resolvedSource.properties.find(
        (p) => p.key === targetProp.key,
      );
      if (!sourceProp) {
        if (isOptionalType(targetProp.value, typeAliases)) continue;
        return false;
      }
      if (!isAssignable(sourceProp.value, targetProp.value, typeAliases))
        return false;
    }
    return true;
  }

  // functionRefType is assignable to the "function" primitive
  if (
    resolvedSource.type === "functionRefType" &&
    resolvedTarget.type === "primitiveType" &&
    resolvedTarget.value === "function"
  ) {
    return true;
  }

  // Two functionRefTypes: compatible if same arity and compatible param/return types
  if (
    resolvedSource.type === "functionRefType" &&
    resolvedTarget.type === "functionRefType"
  ) {
    const sourceVariadic = resolvedSource.params.some((p) => p.variadic);
    const targetVariadic = resolvedTarget.params.some((p) => p.variadic);
    if (sourceVariadic !== targetVariadic) return false;
    const sourceParams = resolvedSource.params.filter((p) => !p.variadic);
    const targetParams = resolvedTarget.params.filter((p) => !p.variadic);
    if (sourceParams.length !== targetParams.length) return false;
    for (let i = 0; i < sourceParams.length; i++) {
      const sourceHint = sourceParams[i].typeHint;
      const targetHint = targetParams[i].typeHint;
      if (!sourceHint || !targetHint) continue;
      if (!isAssignable(targetHint, sourceHint, typeAliases)) return false;
    }
    if (resolvedSource.returnType && resolvedTarget.returnType) {
      return isAssignable(resolvedSource.returnType, resolvedTarget.returnType, typeAliases);
    }
    return true;
  }

  return false;
}
