import {
  AgencyNode,
  VariableType,
  ValueAccess,
} from "../types.js";
import { formatTypeHint } from "../cli/util.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import { isAssignable, resolveType } from "./assignability.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";

export function synthType(
  expr: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  switch (expr.type) {
    case "variableName": {
      return scope.lookup(expr.value) ?? "any";
    }
    case "number":
      return { type: "primitiveType", value: "number" };
    case "string": {
      if (expr.segments.length === 1 && expr.segments[0].type === "text") {
        return { type: "stringLiteralType", value: expr.segments[0].value };
      }
      return { type: "primitiveType", value: "string" };
    }
    case "multiLineString":
      return { type: "primitiveType", value: "string" };
    case "boolean":
      return { type: "primitiveType", value: "boolean" };
    case "binOpExpression":
      return synthBinOp(expr, scope, ctx);
    case "functionCall":
      return synthFunctionCall(expr, scope, ctx);
    case "agencyArray":
      return synthArray(expr, scope, ctx);
    case "agencyObject":
      return synthObject(expr, scope, ctx);
    case "valueAccess":
      return synthValueAccess(expr, scope, ctx);
    default:
      return "any";
  }
}

function synthBinOp(
  expr: AgencyNode & { type: "binOpExpression" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const op = expr.operator;
  if (
    op === "==" ||
    op === "!=" ||
    op === "=~" ||
    op === "!~" ||
    op === "<" ||
    op === ">" ||
    op === "<=" ||
    op === ">=" ||
    op === "&&" ||
    op === "||"
  ) {
    return { type: "primitiveType", value: "boolean" };
  }
  if (op === "+") {
    const leftType = synthType(expr.left, scope, ctx);
    const rightType = synthType(expr.right, scope, ctx);
    const isString = (t: VariableType | "any") =>
      t !== "any" &&
      ((t.type === "primitiveType" && t.value === "string") ||
        t.type === "stringLiteralType");
    if (isString(leftType) || isString(rightType)) {
      return { type: "primitiveType", value: "string" };
    }
  }
  return { type: "primitiveType", value: "number" };
}

function synthFunctionCall(
  expr: AgencyNode & { type: "functionCall" },
  _scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const fn = ctx.functionDefs[expr.functionName];
  const graphNode = ctx.nodeDefs[expr.functionName];
  const def = fn ?? graphNode;
  if (def?.returnType) return def.returnType;
  if (expr.functionName in ctx.inferredReturnTypes) {
    return ctx.inferredReturnTypes[expr.functionName];
  }
  if (def && !def.returnType && ctx.inferringReturnType.size > 0) {
    return ctx.inferReturnTypeFor(expr.functionName, def);
  }
  if (!def) {
    const imported = ctx.importedFunctions[expr.functionName];
    if (imported?.returnType) return imported.returnType;
    if (expr.functionName in BUILTIN_FUNCTION_TYPES) {
      return BUILTIN_FUNCTION_TYPES[expr.functionName].returnType;
    }
  }
  return "any";
}

function synthArray(
  expr: AgencyNode & { type: "agencyArray" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  if (expr.items.length === 0)
    return {
      type: "arrayType",
      elementType: { type: "primitiveType", value: "any" },
    };
  const itemTypes: (VariableType | "any")[] = [];
  for (const item of expr.items) {
    if (item.type === "splat") {
      const splatType = synthType(item.value, scope, ctx);
      if (splatType === "any") return "any";
      if (splatType.type !== "arrayType") return "any";
      itemTypes.push(splatType.elementType);
      continue;
    }
    itemTypes.push(synthType(item, scope, ctx));
  }
  const concreteTypes = itemTypes.filter((t) => t !== "any");
  if (concreteTypes.length === 0) return "any";
  const typeAliases = ctx.getTypeAliases();
  const first = concreteTypes[0];
  const allSame = concreteTypes.every(
    (t) =>
      isAssignable(t, first, typeAliases) &&
      isAssignable(first, t, typeAliases),
  );
  if (allSame) {
    return { type: "arrayType", elementType: first };
  }
  return "any";
}

function synthObject(
  expr: AgencyNode & { type: "agencyObject" },
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  // Use a Map so later entries overwrite earlier ones (later-wins for splats
  // followed by explicit keys, e.g. { ...a, x: "new" } produces x's literal type).
  const properties = new Map<string, VariableType>();
  for (const entry of expr.entries) {
    if ("type" in entry && entry.type === "splat") {
      const splatType = synthType(entry.value, scope, ctx);
      if (splatType === "any") return "any";
      if (splatType.type !== "objectType") return "any";
      for (const prop of splatType.properties) properties.set(prop.key, prop.value);
      continue;
    }
    const kv = entry as { key: string; value: AgencyNode };
    const valueType = synthType(kv.value, scope, ctx);
    if (valueType === "any") {
      return "any";
    }
    properties.set(kv.key, valueType);
  }
  return {
    type: "objectType",
    properties: Array.from(properties, ([key, value]) => ({ key, value })),
  };
}

export function synthValueAccess(
  expr: ValueAccess,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  let currentType = synthType(expr.base, scope, ctx);
  const typeAliases = ctx.getTypeAliases();

  for (const element of expr.chain) {
    if (currentType === "any") return "any";
    const resolved = resolveType(currentType, typeAliases);
    if (resolved.type === "primitiveType" && resolved.value === "any") return "any";

    switch (element.kind) {
      case "property": {
        if (resolved.type === "unionType") {
          const propTypes: VariableType[] = [];
          for (const member of resolved.types) {
            const resolvedMember = resolveType(member, typeAliases);
            if (resolvedMember.type === "objectType") {
              const prop = resolvedMember.properties.find(
                (p) => p.key === element.name,
              );
              if (prop) propTypes.push(prop.value);
            }
          }
          if (propTypes.length > 0) {
            if (propTypes.length === 1) {
              currentType = propTypes[0];
            } else {
              currentType = { type: "unionType", types: propTypes };
            }
          } else {
            ctx.errors.push({
              message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
              loc: expr.loc,
            });
            return "any";
          }
        } else if (resolved.type === "objectType") {
          const prop = resolved.properties.find(
            (p) => p.key === element.name,
          );
          if (prop) {
            currentType = prop.value;
          } else {
            ctx.errors.push({
              message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
              loc: expr.loc,
            });
            return "any";
          }
        } else if (
          resolved.type === "arrayType" &&
          element.name === "length"
        ) {
          currentType = { type: "primitiveType", value: "number" };
        } else {
          ctx.errors.push({
            message: `Property '${element.name}' does not exist on type '${formatTypeHint(resolved)}'.`,
          });
          return "any";
        }
        break;
      }
      case "index": {
        if (resolved.type === "arrayType") {
          currentType = resolved.elementType;
        } else {
          return "any";
        }
        break;
      }
      case "methodCall": {
        return "any";
      }
    }
  }

  return currentType;
}
