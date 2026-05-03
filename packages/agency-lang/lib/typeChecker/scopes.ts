import {
  AgencyNode,
  FunctionDefinition,
  GraphNodeDefinition,
  VariableType,
  functionScope,
  nodeScope,
} from "../types.js";
import type { SourceLocation } from "../types/base.js";
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

  for (const def of [
    ...Object.values(ctx.functionDefs),
    ...Object.values(ctx.nodeDefs),
  ]) {
    scopes.push(buildDefScope(def, ctx));
  }

  return scopes;
}

function buildDefScope(
  def: FunctionDefinition | GraphNodeDefinition,
  ctx: TypeCheckerContext,
): ScopeInfo {
  const name = def.type === "function" ? def.functionName : def.nodeName;
  const sk =
    def.type === "function"
      ? scopeKey(functionScope(def.functionName))
      : scopeKey(nodeScope(def.nodeName));
  const scope = new Scope(sk);
  for (const param of def.parameters) {
    scope.declare(param.name, param.typeHint ?? "any");
  }
  ctx.withScope(sk, () => {
    walkScopeBody(def.body, scope, ctx);
  });
  return {
    scope,
    body: def.body,
    name,
    scopeKey: sk,
    returnType: def.returnType,
  };
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
  const existingType = scope.lookup(node.variableName);

  if (newType) {
    validateTypeReferences(
      newType,
      node.variableName,
      ctx.getTypeAliases(),
      ctx.errors,
      node.loc,
    );
    if (existingType) {
      reportNotAssignable(ctx, node.variableName, newType, existingType, node.loc);
    }
    checkType(
      node.value,
      newType,
      scope,
      `assignment to '${node.variableName}'`,
      ctx,
    );
    scope.declare(node.variableName, newType);
    return;
  }

  if (existingType) {
    const valueType = synthType(node.value, scope, ctx);
    reportNotAssignable(ctx, node.variableName, valueType, existingType, node.loc);
    return;
  }

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

function reportNotAssignable(
  ctx: TypeCheckerContext,
  variableName: string,
  actual: VariableType | "any",
  expected: VariableType | "any",
  loc: SourceLocation | undefined,
): void {
  if (actual === "any" || expected === "any") return;
  if (isAssignable(actual, expected, ctx.getTypeAliases())) return;
  ctx.errors.push({
    message: `Type '${formatTypeHint(actual)}' is not assignable to type '${formatTypeHint(expected)}'.`,
    variableName,
    expectedType: formatTypeHint(expected),
    actualType: formatTypeHint(actual),
    loc,
  });
}

/**
 * Walk a body of statements and declare every binding into the given scope.
 * Recurses into nested blocks using the same scope, which preserves today's
 * function-scoped semantics — declarations leak out of nested blocks.
 */
export function walkScopeBody(
  nodes: AgencyNode[],
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  for (const node of nodes) {
    switch (node.type) {
      case "assignment":
        declareVariable(node, scope, ctx);
        break;
      case "importStatement":
        for (const importName of node.importedNames) {
          for (const name of getImportedNames(importName)) {
            scope.declare(name, "any");
          }
        }
        break;
      case "forLoop": {
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
        break;
      }
      case "ifElse":
        walkScopeBody(node.thenBody, scope, ctx);
        if (node.elseBody) walkScopeBody(node.elseBody, scope, ctx);
        break;
      case "whileLoop":
      case "messageThread":
      case "parallelBlock":
      case "seqBlock":
        walkScopeBody(node.body, scope, ctx);
        break;
      case "matchBlock":
        for (const caseItem of node.cases) {
          if (caseItem.type === "comment") continue;
          walkScopeBody([caseItem.body], scope, ctx);
        }
        break;
      case "handleBlock":
        walkScopeBody(node.body, scope, ctx);
        if (node.handler.kind === "inline") {
          scope.declare(node.handler.param.name, node.handler.param.typeHint ?? "any");
          walkScopeBody(node.handler.body, scope, ctx);
        }
        break;
      case "functionCall":
        if (node.block) {
          for (const param of node.block.params) {
            scope.declare(param.name, param.typeHint ?? "any");
          }
          walkScopeBody(node.block.body, scope, ctx);
        }
        break;
    }
  }
}
