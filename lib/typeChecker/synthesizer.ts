import {
  AgencyNode,
  FunctionDefinition,
  GraphNodeDefinition,
  VariableType,
  ValueAccess,
} from "../types.js";
import { AgencyConfig } from "../config.js";
import { formatTypeHint } from "../cli/util.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import { isAssignable, resolveType } from "./assignability.js";
import { TypeCheckError } from "./types.js";

export type SynthContext = {
  functionDefs: Record<string, FunctionDefinition>;
  nodeDefs: Record<string, GraphNodeDefinition>;
  inferredReturnTypes: Record<string, VariableType | "any">;
  inferringReturnType: Set<string>;
  errors: TypeCheckError[];
  config: AgencyConfig;
  getTypeAliases(): Record<string, VariableType>;
  inferReturnTypeFor(
    name: string,
    def: FunctionDefinition | GraphNodeDefinition,
  ): VariableType | "any";
};

export function synthType(
  expr: AgencyNode,
  scopeVars: Record<string, VariableType | "any">,
  ctx: SynthContext,
): VariableType | "any" {
  switch (expr.type) {
    case "variableName": {
      const t = scopeVars[expr.value];
      return t ?? "any";
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
      return synthBinOp(expr, scopeVars, ctx);
    case "functionCall":
      return synthFunctionCall(expr, scopeVars, ctx);
    case "agencyArray":
      return synthArray(expr, scopeVars, ctx);
    case "agencyObject":
      return synthObject(expr, scopeVars, ctx);
    case "valueAccess":
      return synthValueAccess(expr, scopeVars, ctx);
    default:
      return "any";
  }
}

function synthBinOp(
  expr: AgencyNode & { type: "binOpExpression" },
  scopeVars: Record<string, VariableType | "any">,
  ctx: SynthContext,
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
    const leftType = synthType(expr.left, scopeVars, ctx);
    const rightType = synthType(expr.right, scopeVars, ctx);
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
  scopeVars: Record<string, VariableType | "any">,
  ctx: SynthContext,
): VariableType | "any" {
  if (expr.functionName in BUILTIN_FUNCTION_TYPES) {
    return BUILTIN_FUNCTION_TYPES[expr.functionName].returnType;
  }
  const fn = ctx.functionDefs[expr.functionName];
  const graphNode = ctx.nodeDefs[expr.functionName];
  const def = fn ?? graphNode;
  if (def?.returnType) return def.returnType;
  if (expr.functionName in ctx.inferredReturnTypes) {
    return ctx.inferredReturnTypes[expr.functionName];
  }
  // Lazily trigger inference if we're in the inference phase
  if (def && !def.returnType && ctx.inferringReturnType.size > 0) {
    return ctx.inferReturnTypeFor(expr.functionName, def);
  }
  return "any";
}

function synthArray(
  expr: AgencyNode & { type: "agencyArray" },
  scopeVars: Record<string, VariableType | "any">,
  ctx: SynthContext,
): VariableType | "any" {
  if (expr.items.length === 0)
    return {
      type: "arrayType",
      elementType: { type: "primitiveType", value: "any" },
    };
  const itemTypes: (VariableType | "any")[] = [];
  for (const item of expr.items) {
    if (item.type === "splat") {
      return "any";
    }
    itemTypes.push(synthType(item, scopeVars, ctx));
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
  scopeVars: Record<string, VariableType | "any">,
  ctx: SynthContext,
): VariableType | "any" {
  const properties: { key: string; value: VariableType }[] = [];
  for (const entry of expr.entries) {
    if ("type" in entry && entry.type === "splat") {
      return "any";
    }
    const kv = entry as { key: string; value: AgencyNode };
    const valueType = synthType(kv.value, scopeVars, ctx);
    if (valueType === "any") {
      return "any";
    }
    properties.push({ key: kv.key, value: valueType });
  }
  return { type: "objectType", properties };
}

export function synthValueAccess(
  expr: ValueAccess,
  scopeVars: Record<string, VariableType | "any">,
  ctx: SynthContext,
): VariableType | "any" {
  let currentType = synthType(expr.base, scopeVars, ctx);
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
