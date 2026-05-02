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
import { Scope } from "./scope.js";

export function buildScopes(
  ctx: TypeCheckerContext,
  synthCtx: SynthContext,
): ScopeInfo[] {
  const scopes: ScopeInfo[] = [];

  // Top-level scope
  const topLevelScope = new Scope(GLOBAL_SCOPE_KEY);
  ctx.withScope(GLOBAL_SCOPE_KEY, () => {
    collectVariableTypes(ctx.programNodes, topLevelScope, "top-level", synthCtx);
  });
  scopes.push({
    variableTypes: topLevelScope.toRecord(),
    body: ctx.programNodes,
    name: "top-level",
    scopeKey: GLOBAL_SCOPE_KEY,
  });

  // Function scopes
  for (const fn of Object.values(ctx.functionDefs)) {
    const sk = scopeKey(functionScope(fn.functionName));
    const fnScope = new Scope(sk);
    for (const param of fn.parameters) {
      fnScope.declare(param.name, param.typeHint ?? "any");
    }
    ctx.withScope(sk, () => {
      collectVariableTypes(fn.body, fnScope, fn.functionName, synthCtx);
    });
    scopes.push({
      variableTypes: fnScope.toRecord(),
      body: fn.body,
      name: fn.functionName,
      scopeKey: sk,
      returnType: fn.returnType,
    });
  }

  // Graph node scopes
  for (const node of Object.values(ctx.nodeDefs)) {
    const sk = scopeKey(nodeScope(node.nodeName));
    const nodeScope_ = new Scope(sk);
    for (const param of node.parameters) {
      nodeScope_.declare(param.name, param.typeHint ?? "any");
    }
    ctx.withScope(sk, () => {
      collectVariableTypes(node.body, nodeScope_, node.nodeName, synthCtx);
    });
    scopes.push({
      variableTypes: nodeScope_.toRecord(),
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
  scope: Scope,
  scopeName: string,
  ctx: SynthContext,
): void {
  const typeAliases = ctx.getTypeAliases();

  for (const node of nodes) {
    if (node.type === "assignment") {
      const existingType = scope.lookup(node.variableName);
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
        checkType(node.value, newType, scope.toRecord(), `assignment to '${node.variableName}'`, ctx);
        scope.declare(node.variableName, newType);
      } else if (existingType) {
        const valueType = synthType(node.value, scope.toRecord(), ctx);
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
        const inferred = synthType(node.value, scope.toRecord(), ctx);
        scope.declare(node.variableName, widenType(inferred));
      }
    } else if (node.type === "importStatement") {
      for (const importName of node.importedNames) {
        for (const name of getImportedNames(importName)) {
          scope.declare(name, "any");
        }
      }
    } else if (node.type === "forLoop") {
      const iterableType = synthType(node.iterable, scope.toRecord(), ctx);
      if (iterableType !== "any" && iterableType.type === "arrayType") {
        scope.declare(node.itemVar, iterableType.elementType);
      } else {
        scope.declare(node.itemVar, "any");
      }
      if (node.indexVar) {
        scope.declare(node.indexVar, { type: "primitiveType", value: "number" });
      }
      collectVariableTypes(node.body, scope, scopeName, ctx);
    }
  }

  // Walk into nested blocks
  for (const node of nodes) {
    if (node.type === "ifElse") {
      collectVariableTypes(node.thenBody, scope, scopeName, ctx);
      if (node.elseBody) {
        collectVariableTypes(node.elseBody, scope, scopeName, ctx);
      }
    } else if (node.type === "whileLoop") {
      collectVariableTypes(node.body, scope, scopeName, ctx);
    } else if (node.type === "messageThread") {
      collectVariableTypes(node.body, scope, scopeName, ctx);
    }
  }
}
