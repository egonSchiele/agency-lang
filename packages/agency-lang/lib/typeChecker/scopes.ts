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
import { resultTypeForValidation } from "./validation.js";
import { validateTypeReferences } from "./validate.js";
import { ScopeInfo, TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";
import { formatTypeHint } from "../utils/formatType.js";
import { checkType, getBlockSlot } from "./utils.js";
import { NUMBER_T } from "./primitives.js";

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

  if (node.exported && !(node.static && node.declKind === "const")) {
    ctx.errors.push({
      message: `Only 'static const' declarations can be exported. Use 'export static const ${node.variableName} = ...' instead.`,
      loc: node.loc,
    });
  }

  // Reassignment to a const binding (no accessChain — property writes on
  // const objects are allowed, matching JS semantics).
  if (
    !node.declKind &&
    !node.accessChain &&
    scope.isConst(node.variableName)
  ) {
    ctx.errors.push({
      message: `Cannot reassign to constant '${node.variableName}'.`,
      variableName: node.variableName,
      loc: node.loc,
    });
  }

  const newType = node.typeHint;
  const existingType = scope.lookup(node.variableName);
  const isConst = node.declKind === "const";

  if (newType) {
    validateTypeReferences(
      newType,
      node.variableName,
      ctx.getTypeAliases(),
      ctx.errors,
      node.loc,
    );
    if (existingType) {
      reportNotAssignable(
        ctx,
        node.variableName,
        newType,
        existingType,
        node.loc,
      );
    }
    checkType(
      node.value,
      newType,
      scope,
      `assignment to '${node.variableName}'`,
      ctx,
    );
    // The runtime wraps validated values in Result<T, string>, so the
    // declared scope type must match — otherwise downstream property accesses
    // see `T` instead of the actual `Result<T, string>` and silently miscompile.
    scope.declare(
      node.variableName,
      resultTypeForValidation(newType, node.validated),
      isConst,
    );
    return;
  }

  if (existingType) {
    const valueType = synthType(node.value, scope, ctx);
    reportNotAssignable(
      ctx,
      node.variableName,
      valueType,
      existingType,
      node.loc,
    );
    return;
  }

  if (ctx.config.typechecker?.strictTypes) {
    ctx.errors.push({
      message: `Variable '${node.variableName}' has no type annotation (strict mode).`,
      variableName: node.variableName,
      loc: node.loc,
    });
  }
  const inferred = synthType(node.value, scope, ctx);
  scope.declare(node.variableName, widenType(inferred), isConst);
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

// Operators that mutate their left operand. Compound assigns (`+=` etc.)
// and postfix `++`/`--` all desugar to writes back to the left side, so a
// const target is just as illegal as bare reassignment.
const MUTATING_OPERATORS = [
  "+=", "-=", "*=", "/=", "&&=", "||=", "??=", "++", "--",
];

// Recursively walks `node` and reports any binOpExpression that mutates a
// const variable. Catches nested cases like `return x++`, `if (x++ > 0)`,
// `foo(x += 1)`, and mutations inside string interpolations / array items
// / object values. Does NOT cross into nested function/graphNode bodies —
// those have their own scopes built separately by buildDefScope.
function checkConstMutations(
  node: AgencyNode | null | undefined,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  if (!node) return;
  if (node.type === "function" || node.type === "graphNode") return;

  if (
    node.type === "binOpExpression" &&
    MUTATING_OPERATORS.includes(node.operator) &&
    node.left.type === "variableName" &&
    scope.isConst(node.left.value)
  ) {
    ctx.errors.push({
      message: `Cannot reassign to constant '${node.left.value}'.`,
      variableName: node.left.value,
      loc: node.loc,
    });
  }

  switch (node.type) {
    case "binOpExpression":
      checkConstMutations(node.left as AgencyNode, scope, ctx);
      checkConstMutations(node.right as AgencyNode, scope, ctx);
      break;
    case "assignment":
      checkConstMutations(node.value as AgencyNode, scope, ctx);
      break;
    case "returnStatement":
      checkConstMutations(node.value as AgencyNode | undefined, scope, ctx);
      break;
    case "ifElse":
      checkConstMutations(node.condition as AgencyNode, scope, ctx);
      break;
    case "whileLoop":
      checkConstMutations(node.condition as AgencyNode, scope, ctx);
      break;
    case "forLoop":
      checkConstMutations(node.iterable as AgencyNode, scope, ctx);
      break;
    case "functionCall":
      for (const arg of node.arguments) {
        const value =
          arg.type === "splat" || arg.type === "namedArgument"
            ? arg.value
            : arg;
        checkConstMutations(value as AgencyNode, scope, ctx);
      }
      break;
    case "valueAccess":
      checkConstMutations(node.base as AgencyNode, scope, ctx);
      for (const element of node.chain) {
        if (element.kind === "index") {
          checkConstMutations(element.index as AgencyNode, scope, ctx);
        } else if (element.kind === "methodCall") {
          checkConstMutations(element.functionCall as AgencyNode, scope, ctx);
        }
      }
      break;
    case "agencyArray":
      for (const item of node.items) {
        const value = item.type === "splat" ? item.value : item;
        checkConstMutations(value as AgencyNode, scope, ctx);
      }
      break;
    case "agencyObject":
      for (const entry of node.entries) {
        const value =
          "type" in entry && entry.type === "splat"
            ? entry.value
            : (entry as { value: AgencyNode }).value;
        checkConstMutations(value as AgencyNode, scope, ctx);
      }
      break;
    case "string":
    case "multiLineString":
      for (const seg of node.segments) {
        if (seg.type === "interpolation") {
          checkConstMutations(seg.expression as AgencyNode, scope, ctx);
        }
      }
      break;
    case "tryExpression":
      checkConstMutations(node.call as AgencyNode, scope, ctx);
      break;
    case "newExpression":
      for (const arg of node.arguments) {
        checkConstMutations(arg as AgencyNode, scope, ctx);
      }
      break;
    case "interruptStatement":
      for (const arg of node.arguments) {
        const value =
          arg.type === "splat" || arg.type === "namedArgument"
            ? arg.value
            : arg;
        checkConstMutations(value as AgencyNode, scope, ctx);
      }
      break;
  }
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
    checkConstMutations(node, scope, ctx);
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
        if (iterableType === "any") {
          scope.declare(node.itemVar, "any");
        } else if (iterableType.type === "arrayType") {
          scope.declare(node.itemVar, iterableType.elementType);
        } else {
          scope.declare(node.itemVar, "any");
          ctx.errors.push({
            message: `For-loop iterable must be an array, got '${formatTypeHint(iterableType)}'.`,
            actualType: formatTypeHint(iterableType),
            loc: node.iterable.loc,
          });
        }
        if (node.indexVar) {
          scope.declare(node.indexVar, NUMBER_T);
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
          if (caseItem.type === "newLine") continue;
          walkScopeBody([caseItem.body], scope, ctx);
        }
        break;
      case "handleBlock":
        walkScopeBody(node.body, scope, ctx);
        if (node.handler.kind === "inline") {
          if (node.handler.param.validated) {
            ctx.errors.push({
              message:
                "The '!' validation syntax is not allowed on handler parameters. Validate the data inside the handler body if needed.",
              loc: node.loc,
            });
          }
          scope.declare(
            node.handler.param.name,
            node.handler.param.typeHint ?? "any",
          );
          walkScopeBody(node.handler.body, scope, ctx);
        }
        break;
      case "functionCall":
        if (node.block) {
          // Block params today have no syntax for an explicit type annotation,
          // so the type comes from the matching slot in the callee's
          // `blockType` param (when present), falling back to `any`. The
          // `param.typeHint` branch is dead code that anticipates a future
          // typed-block-param syntax.
          const slot = getBlockSlot(node.functionName, ctx);
          node.block.params.forEach((param, i) => {
            const slotType = slot?.params[i]?.typeAnnotation;
            scope.declare(
              param.name,
              param.typeHint ?? slotType ?? "any",
            );
          });
          walkScopeBody(node.block.body, scope, ctx);
        }
        break;
    }
  }
}
