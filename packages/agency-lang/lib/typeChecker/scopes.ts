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
import { checkType } from "./utils.js";

export function buildScopes(ctx: TypeCheckerContext): ScopeInfo[] {
  const scopes: ScopeInfo[] = [];

  const topLevelScope = new Scope(GLOBAL_SCOPE_KEY);
  ctx.withScope(GLOBAL_SCOPE_KEY, () => {
    walkScopeBody(ctx.programNodes, topLevelScope, ctx);
  });
  scopes.push({
    scope: topLevelScope,
    body: ctx.programNodes,
    name: "top-level",
    scopeKey: GLOBAL_SCOPE_KEY,
  });

  for (const fn of Object.values(ctx.functionDefs)) {
    const sk = scopeKey(functionScope(fn.functionName));
    const fnScope = new Scope(sk);
    for (const param of fn.parameters) {
      fnScope.declare(param.name, param.typeHint ?? "any");
    }
    ctx.withScope(sk, () => {
      walkScopeBody(fn.body, fnScope, ctx);
    });
    scopes.push({
      scope: fnScope,
      body: fn.body,
      name: fn.functionName,
      scopeKey: sk,
      returnType: fn.returnType,
    });
  }

  for (const node of Object.values(ctx.nodeDefs)) {
    const sk = scopeKey(nodeScope(node.nodeName));
    const ns = new Scope(sk);
    for (const param of node.parameters) {
      ns.declare(param.name, param.typeHint ?? "any");
    }
    ctx.withScope(sk, () => {
      walkScopeBody(node.body, ns, ctx);
    });
    scopes.push({
      scope: ns,
      body: node.body,
      name: node.nodeName,
      scopeKey: sk,
      returnType: node.returnType,
    });
  }

  return scopes;
}

/**
 * Process one assignment statement: validate its type, check the value
 * against the declared type, and add (or update) the binding in scope.
 *
 * Run in source order from walkScopeBody — the value-vs-binding check
 * needs the scope state as it was at this point in the program, not the
 * final state after all declarations.
 */
export function declareVariable(
  node: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  if (node.type !== "assignment") return;
  const newType = node.typeHint;
  const typeAliases = ctx.getTypeAliases();
  const existingType = scope.lookup(node.variableName);

  if (newType) {
    validateTypeReferences(
      newType,
      node.variableName,
      typeAliases,
      ctx.errors,
      node.loc,
    );
    // Re-declaration with an incompatible annotation.
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
    checkType(
      node.value,
      newType,
      scope,
      `assignment to '${node.variableName}'`,
      ctx,
    );
    scope.declare(node.variableName, newType);
  } else if (existingType) {
    // Unannotated reassignment to an existing binding: value must match
    // the binding's current type.
    const valueType = synthType(node.value, scope, ctx);
    if (
      valueType !== "any" &&
      existingType !== "any" &&
      !isAssignable(valueType, existingType, typeAliases)
    ) {
      ctx.errors.push({
        message: `Type '${formatTypeHint(valueType)}' is not assignable to type '${formatTypeHint(existingType)}'.`,
        variableName: node.variableName,
        expectedType: formatTypeHint(existingType),
        actualType: formatTypeHint(valueType),
        loc: node.loc,
      });
    }
  } else {
    // First declaration with no annotation — infer.
    if (ctx.config.strictTypes) {
      ctx.errors.push({
        message: `Variable '${node.variableName}' has no type annotation (strict mode).`,
        variableName: node.variableName,
        loc: node.loc,
      });
    }
    const inferred = synthType(node.value, scope, ctx);
    scope.declare(node.variableName, widenType(inferred));
  }
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
      const iterableType = synthType(node.iterable, scope, ctx);
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
