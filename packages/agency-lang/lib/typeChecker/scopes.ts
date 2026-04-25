import {
  AgencyNode,
  VariableType,
  functionScope,
  nodeScope,
} from "../types.js";
import { GLOBAL_SCOPE_KEY, scopeKey } from "../programInfo.js";
import { getImportedNames } from "../types/importStatement.js";
import { formatTypeHint } from "../cli/util.js";
import { isAssignable, widenType } from "./assignability.js";
import { synthType, SynthContext } from "./synthesizer.js";
import { validateTypeReferences } from "./validate.js";
import { ScopeInfo, TypeCheckerContext } from "./types.js";
import { checkType } from "./utils.js";

export function buildScopes(
  ctx: TypeCheckerContext,
  synthCtx: SynthContext,
): ScopeInfo[] {
  const scopes: ScopeInfo[] = [];

  // Top-level scope
  const topLevelVars: Record<string, VariableType | "any"> = {};
  ctx.withScope(GLOBAL_SCOPE_KEY, () => {
    collectVariableTypes(ctx.programNodes, topLevelVars, "top-level", synthCtx);
  });
  scopes.push({
    variableTypes: topLevelVars,
    body: ctx.programNodes,
    name: "top-level",
    scopeKey: GLOBAL_SCOPE_KEY,
  });

  // Function scopes
  for (const fn of Object.values(ctx.functionDefs)) {
    const vars: Record<string, VariableType | "any"> = {};
    for (const param of fn.parameters) {
      vars[param.name] = param.typeHint ?? "any";
    }
    const sk = scopeKey(functionScope(fn.functionName));
    ctx.withScope(sk, () => {
      collectVariableTypes(fn.body, vars, fn.functionName, synthCtx);
    });
    scopes.push({
      variableTypes: vars,
      body: fn.body,
      name: fn.functionName,
      scopeKey: sk,
      returnType: fn.returnType,
    });
  }

  // Graph node scopes
  for (const node of Object.values(ctx.nodeDefs)) {
    const vars: Record<string, VariableType | "any"> = {};
    for (const param of node.parameters) {
      vars[param.name] = param.typeHint ?? "any";
    }
    const sk = scopeKey(nodeScope(node.nodeName));
    ctx.withScope(sk, () => {
      collectVariableTypes(node.body, vars, node.nodeName, synthCtx);
    });
    scopes.push({
      variableTypes: vars,
      body: node.body,
      name: node.nodeName,
      scopeKey: sk,
      returnType: node.returnType,
    });
  }

  return scopes;
}

/**
 * Walk statements to collect variable types AND check assignments.
 * Kept as single-pass to preserve existing behavior.
 */
export function collectVariableTypes(
  nodes: AgencyNode[],
  vars: Record<string, VariableType | "any">,
  scopeName: string,
  ctx: SynthContext,
): void {
  const typeAliases = ctx.getTypeAliases();

  for (const node of nodes) {
    if (node.type === "assignment") {
      const existingType = vars[node.variableName];
      const newType = node.typeHint;
      const loc = node.loc;

      if (newType) {
        validateTypeReferences(newType, node.variableName, typeAliases, ctx.errors, loc);
        // Check reassignment consistency
        if (
          existingType &&
          existingType !== "any" &&
          !isAssignable(newType, existingType, typeAliases)
        ) {
          ctx.errors.push({
            message: `Type '${formatTypeHint(newType)}' is not assignable to type '${formatTypeHint(existingType)}'.`,
            variableName: node.variableName,
            expectedType: formatTypeHint(existingType),
            actualType: formatTypeHint(newType),
            loc,
          });
        }
        // Check that the assigned value is compatible with the annotation
        checkType(node.value, newType, vars, `assignment to '${node.variableName}'`, ctx);
        vars[node.variableName] = newType;
      } else if (existingType) {
        const valueType = synthType(node.value, vars, ctx);
        if (
          valueType !== "any" &&
          existingType !== "any" &&
          !isAssignable(valueType, existingType, typeAliases)
        ) {
          ctx.errors.push({
            message: `Type '${typeof valueType === "string" ? valueType : formatTypeHint(valueType)}' is not assignable to type '${formatTypeHint(existingType)}'.`,
            variableName: node.variableName,
            expectedType: formatTypeHint(existingType),
            actualType:
              typeof valueType === "string"
                ? valueType
                : formatTypeHint(valueType),
            loc,
          });
        }
      } else {
        // No type annotation — infer from value
        if (ctx.config.strictTypes) {
          ctx.errors.push({
            message: `Variable '${node.variableName}' has no type annotation (strict mode).`,
            variableName: node.variableName,
            loc,
          });
        }
        const inferred = synthType(node.value, vars, ctx);
        vars[node.variableName] = widenType(inferred);
      }
    } else if (node.type === "importStatement") {
      for (const importName of node.importedNames) {
        for (const name of getImportedNames(importName)) {
          vars[name] = "any";
        }
      }
    } else if (node.type === "forLoop") {
      const iterableType = synthType(node.iterable, vars, ctx);
      if (iterableType !== "any" && iterableType.type === "arrayType") {
        vars[node.itemVar] = iterableType.elementType;
      } else {
        vars[node.itemVar] = "any";
      }
      if (node.indexVar) {
        vars[node.indexVar] = { type: "primitiveType", value: "number" };
      }
      collectVariableTypes(node.body, vars, scopeName, ctx);
    }
  }

  // Walk into nested blocks
  for (const node of nodes) {
    if (node.type === "ifElse") {
      collectVariableTypes(node.thenBody, vars, scopeName, ctx);
      if (node.elseBody) {
        collectVariableTypes(node.elseBody, vars, scopeName, ctx);
      }
    } else if (node.type === "whileLoop") {
      collectVariableTypes(node.body, vars, scopeName, ctx);
    } else if (node.type === "messageThread") {
      collectVariableTypes(node.body, vars, scopeName, ctx);
    }
  }
}
