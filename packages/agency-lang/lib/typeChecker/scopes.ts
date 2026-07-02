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
import { synthType, synthValueAccess } from "./synthesizer.js";
import type { AccessChainElement, ValueAccess } from "../types/access.js";
import type { VariableNameLiteral } from "../types/literals.js";
import { resultTypeForValidation } from "./validation.js";
import { validateTypeReferences } from "./validate.js";
import { ScopeInfo, TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";
import type { FlowNode } from "./flow.js";
import { formatTypeHint } from "../utils/formatType.js";
import { checkType, getBlockSlot } from "./utils.js";
import { checkMatchExprYields } from "./matchExprTypes.js";
import { NUMBER_T, STRING_T } from "./primitives.js";
import { unionTypes } from "./inference.js";
import { analyzeCondition, walkWithNarrowing, postGuardFacts } from "./narrowing.js";
import { expressionChildren } from "../utils/node.js";

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
    file: "",
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
    // Use the file currently being typechecked (threaded through ctx from
    // CompilationUnit.fromFile). A global name lookup would tag the wrong
    // file when the same top-level name is defined in two modules, which
    // then cascades into incorrect handler/site locations in the
    // interrupt call graph.
    file: ctx.currentFile ?? "",
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
    // The value-vs-annotation check (checkType) now runs in the flow-aware
    // checkAssignmentsInScope (Phase B) — see checkAssignmentValue.
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

  // Reassignment / access-chain writes don't (re)declare; their value-vs-target
  // checks now run in checkAssignmentsInScope (flow-aware). Nothing to do here.
  if (existingType) {
    return;
  }

  // Property / index writes (`obj.field = x`, `votes["k"] = v`) are
  // mutations, never declarations. Falling through to the auto-declare
  // branch below would invent a fresh binding shadowing the real
  // variable — particularly bad for module-level lets, which aren't
  // visible in function scopes today: `currentPolicy[k] = []` inside a
  // function would silently rebind `currentPolicy` to `any[]`, and
  // subsequent `success(currentPolicy)` would infer `Result<any[], any>`
  // instead of `Result<Policy, …>`. Skip the declare; if the variable
  // truly is undefined, the undefined-variable diagnostic surfaces it.
  if (node.accessChain) return;

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

/**
 * The value-vs-target type checks for an assignment, factored out of
 * `declareVariable` so they can run in the flow-aware Phase B pass
 * (`checkAssignmentsInScope`) rather than during scope declaration. Pure
 * checking — no declaration. No-op for non-assignments.
 */
export function checkAssignmentValue(
  node: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  if (node.type !== "assignment") {
    return;
  }
  // Expression-position match consumer (`const x = match(E) { ... }`): the value
  // is a `__matchval_<id>` ref, whose type is the match's computed union (not a
  // plain synth of the temp). Check the annotation against that union directly
  // and skip the generic checkType path (which would re-synth the temp).
  if (node.matchExprSource) {
    if (node.typeHint) {
      // Checked position: check each arm's yield against the annotation using
      // its UNWIDENED type, so a literal-union annotation accepts a literal
      // yield (`const c: Category = match(x) { "go" => "a"; ... }`) and errors
      // point at the offending arm's value. See `checkMatchExprYields`.
      checkMatchExprYields(
        node.matchExprSource.matchId,
        node.typeHint,
        `assignment to '${node.variableName}'`,
        ctx,
        node.loc,
      );
    }
    return;
  }
  const newType = node.typeHint;
  if (newType) {
    // Annotated + accessChain is intentionally checked against the whole
    // declared type (matches declareVariable). Property/index writes against
    // the chain target are only checked when the assignment is *un-annotated*
    // (the accessChain branch below).
    checkType(
      node.value,
      newType,
      scope,
      `assignment to '${node.variableName}'`,
      ctx,
    );
    return;
  }
  const existingType = scope.lookup(node.variableName);
  if (existingType === undefined) {
    return;
  }
  if (node.accessChain) {
    // The flow recorded for this assignment (flowBuilder) lets the access-chain
    // target resolve a narrowed base via typeAt — see synthAccessChainTargetType.
    const flowNode = ctx.flowEnv?.flowOf.get(node);
    const lhsType = synthAccessChainTargetType(
      node.variableName,
      node.accessChain,
      node.loc,
      scope,
      ctx,
      flowNode,
    );
    const rhsType = synthType(node.value, scope, ctx);
    reportNotAssignable(ctx, node.variableName, rhsType, lhsType, node.loc);
    return;
  }
  const valueType = synthType(node.value, scope, ctx);
  reportNotAssignable(ctx, node.variableName, valueType, existingType, node.loc);
}

/**
 * Synthesize the read-side type of `variableName + accessChain` and return
 * it as the assignment target. Used for property/index writes
 * (`obj.field = …`, `votes["k"] = …`) where the LHS type is the member the
 * chain resolves to, not the whole variable type.
 *
 * Builds a synthetic `ValueAccess` and reuses `synthValueAccess`, which
 * already encodes all the rules we'd otherwise duplicate (object property
 * lookup, record value type, union narrowing, etc.). Any diagnostics raised
 * by the synthesizer here are part of the regular typecheck output.
 *
 * `flowNode` (the flow recorded for the assignment) makes the synthetic base
 * flow-aware: registering it in `flowOf` routes the base's `synthType` through
 * `typeAt`, so a narrowed base (`t.box.n = …` inside `if (t.kind == "a")`)
 * resolves `t` to the narrowed member rather than its wide declared type. The
 * base node is synthetic, so without this it has no `flowOf` entry of its own
 * and falls back to the flat `scope.lookup`.
 */
function synthAccessChainTargetType(
  variableName: string,
  accessChain: AccessChainElement[],
  loc: SourceLocation | undefined,
  scope: Scope,
  ctx: TypeCheckerContext,
  flowNode: FlowNode | undefined,
): VariableType | "any" {
  const base: VariableNameLiteral = {
    type: "variableName",
    value: variableName,
    loc,
  };
  if (flowNode && ctx.flowEnv) {
    ctx.flowEnv.flowOf.set(base, flowNode);
  }
  const synthetic: ValueAccess = {
    type: "valueAccess",
    base,
    chain: accessChain,
    loc,
  };
  return synthValueAccess(synthetic, scope, ctx);
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

  // Recurse via the shared expressionChildren walker (lib/utils/node.ts) — the
  // single source of truth for "what are this node's expression children",
  // also used by the flow builder's attachExpressionsToFlow.
  for (const child of expressionChildren(node)) {
    checkConstMutations(child, scope, ctx);
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
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
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
        // `for (item, second in x)` binds two variables. `itemType` is the
        // first (element for arrays, key for records/objects); `secondType`
        // is the second (numeric index for arrays, VALUE for records/objects),
        // mirroring how the runtime `Runner.loop` passes callback arguments.
        let itemType: VariableType | "any";
        let secondType: VariableType | "any";
        if (iterableType === "any") {
          itemType = "any";
          // Iterable kind is unknown, so the second var could be either an
          // index or a value — leave it as `any` rather than assume a number.
          secondType = "any";
        } else if (iterableType.type === "arrayType") {
          itemType = iterableType.elementType;
          secondType = NUMBER_T;
        } else if (
          iterableType.type === "genericType" &&
          iterableType.name === "Record"
        ) {
          // for (k, v in record): key is Record's key type, value is its
          // value type.
          itemType = iterableType.typeArgs[0];
          secondType = iterableType.typeArgs[1];
        } else if (iterableType.type === "objectType") {
          // for (k, v in obj): an object literal iterates by its (string)
          // keys, with the value being the property value at that key. Object
          // literals synthesize to a structural `objectType`, not a `Record`
          // generic, so they need their own branch here or iteration is
          // wrongly rejected. The value type is the union of all property
          // value types.
          itemType = STRING_T;
          secondType =
            iterableType.properties.length === 0
              ? "any"
              : unionTypes(iterableType.properties.map((p) => p.value));
        } else {
          itemType = "any";
          secondType = "any";
          ctx.errors.push({
            message: `For-loop iterable must be an array or Record, got '${formatTypeHint(iterableType)}'.`,
            actualType: formatTypeHint(iterableType),
            loc: node.iterable.loc,
          });
        }
        scope.declare(node.itemVar as string, itemType);
        if (node.indexVar) {
          scope.declare(node.indexVar, secondType);
        }
        walkScopeBody(node.body, scope, ctx);
        break;
      }
      case "ifElse": {
        // Refinements live in throwaway child scopes (walkWithNarrowing →
        // declareLocal), so they never leak; real declarations inside the
        // body still call declare(), which targets the function scope.
        const facts = analyzeCondition(node.condition);
        const aliases = ctx.getTypeAliases();
        walkWithNarrowing(scope, node.thenBody, facts.then, aliases, ctx, walkScopeBody);
        if (node.elseBody) {
          walkWithNarrowing(scope, node.elseBody, facts.else, aliases, ctx, walkScopeBody);
        }
        // Post-guard narrowing: if exactly one branch always exits (returns),
        // the statements AFTER this if run only on the surviving branch's
        // condition, so walk the remainder of THIS body in a child scope that
        // carries those facts. Delegating the tail here (and returning) keeps
        // the refinement scoped to exactly the post-guard region.
        // The early `return` is load-bearing: without it the outer for-loop
        // would re-walk `rest` in the wrong (un-narrowed) scope, producing
        // duplicate diagnostics and ignoring the post-guard facts entirely.
        // Gate on the cheap checks (no facts, or no tail) BEFORE slicing —
        // postGuardFacts returns [] for any `if` whose taken branch doesn't
        // always-return, which is the vast majority, so an unconditional
        // slice would allocate a throwaway array on every `if` in the AST.
        const afterFacts = postGuardFacts(node, facts);
        if (afterFacts.length > 0 && i + 1 < nodes.length) {
          walkWithNarrowing(scope, nodes.slice(i + 1), afterFacts, aliases, ctx, walkScopeBody);
          return;
        }
        break;
      }
      case "whileLoop": {
        const facts = analyzeCondition(node.condition);
        walkWithNarrowing(scope, node.body, facts.then, ctx.getTypeAliases(), ctx, walkScopeBody);
        break;
      }
      case "messageThread":
      case "parallelBlock":
      case "seqBlock":
        walkScopeBody(node.body, scope, ctx);
        break;
      case "matchBlock":
        for (const caseItem of node.cases) {
          if (caseItem.type === "comment") continue;
          if (caseItem.type === "newLine") continue;
          walkScopeBody(caseItem.body, scope, ctx);
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
