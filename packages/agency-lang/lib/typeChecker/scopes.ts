import {
  AgencyNode,
  functionScope,
  nodeScope,
} from "../types.js";
import { GLOBAL_SCOPE_KEY, scopeKey } from "../compilationUnit.js";
import { getImportedNames } from "../types/importStatement.js";
import { isAssignable, widenType } from "./assignability.js";
import { synthType } from "./synthesizer.js";
import { validateTypeReferences } from "./validate.js";
import { ScopeInfo, TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";
import { formatTypeHint } from "../cli/util.js";

export function buildScopes(ctx: TypeCheckerContext): ScopeInfo[] {
  const scopes: ScopeInfo[] = [];

  // Top-level scope
  const topLevelScope = new Scope(GLOBAL_SCOPE_KEY);
  ctx.withScope(GLOBAL_SCOPE_KEY, () => {
    populateScope(ctx.programNodes, topLevelScope, ctx);
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
      populateScope(fn.body, fnScope, ctx);
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
      populateScope(node.body, nodeScope_, ctx);
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
 * Add a binding to the scope, with no compatibility checking. Annotated
 * declarations validate their type references; unannotated ones synthesize
 * a type from the value and widen it. Reassignment compatibility is
 * verified later in checkAssignmentsInScope.
 */
export function declareVariable(
  node: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  if (node.type !== "assignment") return;
  const newType = node.typeHint;
  if (newType) {
    const typeAliases = ctx.getTypeAliases();
    validateTypeReferences(
      newType,
      node.variableName,
      typeAliases,
      ctx.errors,
      node.loc,
    );
    // Re-declaration with an incompatible annotation is a declaration-time
    // error, so we report it during the declaration walk (when the order
    // of declarations is meaningful).
    const existingType = scope.lookup(node.variableName);
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
        loc: node.loc,
      });
    }
    scope.declare(node.variableName, newType);
  } else if (!scope.has(node.variableName)) {
    if (ctx.config.strictTypes) {
      ctx.errors.push({
        message: `Variable '${node.variableName}' has no type annotation (strict mode).`,
        variableName: node.variableName,
        loc: node.loc,
      });
    }
    const inferred = synthType(node.value, scope.toRecord(), ctx);
    scope.declare(node.variableName, widenType(inferred));
  }
  // Reassignment to an already-declared name with no annotation: no-op here;
  // checkAssignmentsInScope verifies compatibility.
}

/**
 * Walk a body of statements and declare every binding into the given scope.
 * Recurses into nested blocks (if/while/messageThread) using the same scope,
 * which preserves today's function-scoped semantics.
 */
export function walkScopeBody(
  nodes: AgencyNode[],
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  for (const node of nodes) {
    if (node.type === "assignment") {
      declareVariable(node, scope, ctx);
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
        scope.declare(node.indexVar, {
          type: "primitiveType",
          value: "number",
        });
      }
      walkScopeBody(node.body, scope, ctx);
    }
  }

  for (const node of nodes) {
    if (node.type === "ifElse") {
      walkScopeBody(node.thenBody, scope, ctx);
      if (node.elseBody) walkScopeBody(node.elseBody, scope, ctx);
    } else if (node.type === "whileLoop") {
      walkScopeBody(node.body, scope, ctx);
    } else if (node.type === "messageThread") {
      walkScopeBody(node.body, scope, ctx);
    }
  }
}

/**
 * Public entry: populate a scope from a body of statements.
 */
export function populateScope(
  nodes: AgencyNode[],
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  walkScopeBody(nodes, scope, ctx);
}

