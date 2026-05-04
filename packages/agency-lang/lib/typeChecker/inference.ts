import {
  AgencyNode,
  FunctionDefinition,
  GraphNodeDefinition,
  VariableType,
  functionScope,
  nodeScope,
} from "../types.js";
import type { ResultType } from "../types/typeHints.js";
import { scopeKey } from "../compilationUnit.js";
import { walkNodes } from "../utils/node.js";
import { isAssignable, widenType } from "./assignability.js";
import { resultTypeForValidation } from "./validation.js";
import { synthType } from "./synthesizer.js";
import { walkScopeBody } from "./scopes.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";

export function inferReturnTypes(ctx: TypeCheckerContext): void {
  const allDefs: (FunctionDefinition | GraphNodeDefinition)[] = [
    ...Object.values(ctx.functionDefs),
    ...Object.values(ctx.nodeDefs),
  ];

  for (const def of allDefs) {
    if (def.returnType) continue;

    const name = def.type === "function" ? def.functionName : def.nodeName;
    inferReturnTypeFor(name, def, ctx);
  }
}

export function inferReturnTypeFor(
  name: string,
  def: FunctionDefinition | GraphNodeDefinition,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  if (name in ctx.inferredReturnTypes) {
    return ctx.inferredReturnTypes[name];
  }

  // in a cycle trying to infer the return type,
  // just bail out and return "any" to avoid infinite recursion.
  if (ctx.inferringReturnType.has(name)) {
    return "any";
  }

  ctx.inferringReturnType.add(name);

  const defScopeKey =
    def.type === "function"
      ? scopeKey(functionScope(def.functionName))
      : scopeKey(nodeScope(def.nodeName));

  return ctx.withScope(defScopeKey, () => {
    const scope = new Scope(defScopeKey);
    for (const param of def.parameters) {
      scope.declare(param.name, param.typeHint ?? "any");
    }
    walkScopeBody(def.body, scope, ctx);

    const returnValues: AgencyNode[] = [];
    for (const { node, ancestors } of walkNodes(def.body)) {
      if (node.type === "returnStatement" && node.value) {
        const insideNested = ancestors.some(
          (a) => a.type === "function" || a.type === "graphNode",
        );
        if (!insideNested) {
          returnValues.push(node.value);
        }
      }
    }

    let inferred: VariableType | "any";
    if (returnValues.length === 0) {
      inferred = { type: "primitiveType", value: "void" };
    } else {
      const typeAliases = ctx.getTypeAliases();
      const types = returnValues.map((v) => synthType(v, scope, ctx));
      if (types.some((t) => t === "any")) {
        inferred = "any";
      } else {
        const concrete = types as VariableType[];
        // Returns that are all Result-typed merge into a single Result<T, E>
        // so `if (...) return success(x); return failure(y)` infers as
        // Result<typeof x, typeof y> instead of degrading to "any".
        if (concrete.every((t) => t.type === "resultType")) {
          inferred = mergeResultTypes(concrete as ResultTypes);
        } else if (concrete.some((t) => t.type === "resultType")) {
          // Mixed Result + non-Result returns (e.g. `return 5` in one branch,
          // `return success(10)` in another) infer as a union so callers can
          // still get useful narrowing instead of degrading to "any".
          inferred = unionTypes(concrete);
        } else {
          const first = concrete[0];
          const allSame = concrete.every(
            (t) =>
              isAssignable(t, first, typeAliases) &&
              isAssignable(first, t, typeAliases),
          );
          inferred = allSame ? first : "any";
        }
      }
    }

    // Validated params can short-circuit the body with a failure, so the
    // caller-visible inferred type must admit one. Functions whose user
    // explicitly annotated a non-Result return type are caught earlier in
    // index.ts (section 1d) — this branch only handles unannotated returns.
    const hasValidatedParam = def.parameters.some((p) => p.validated);
    if (hasValidatedParam && inferred !== "any") {
      inferred = resultTypeForValidation(inferred, true);
    }

    ctx.inferredReturnTypes[name] = widenType(inferred);
    ctx.inferringReturnType.delete(name);
    return ctx.inferredReturnTypes[name];
  });
}

type ResultTypes = readonly ResultType[];

const ANY_T: VariableType = { type: "primitiveType", value: "any" };

/** True when t is the "any" sentinel synth result expressed as a primitive. */
function isAnyType(t: VariableType): boolean {
  return t.type === "primitiveType" && t.value === "any";
}

/**
 * Merge multiple Result types from different return paths. The success type
 * is the union of all non-`any` success types (or `any` if every branch is
 * `any`); same for failure. This lets a function that returns
 * `success(x)` in one branch and `failure(y)` in another infer as
 * `Result<typeof x, typeof y>` instead of degrading to "any".
 */
function mergeResultTypes(results: ResultTypes): VariableType {
  return {
    type: "resultType",
    successType: mergeResultParam(results.map((r) => r.successType)),
    failureType: mergeResultParam(results.map((r) => r.failureType)),
  };
}

function mergeResultParam(types: VariableType[]): VariableType {
  const hasAny = types.some((t) => isAnyType(t));
  if (hasAny) return ANY_T;
  return unionTypes(types);
}

/**
 * Build a union of distinct types (deduped structurally via a Map keyed by
 * the stringified shape). Returns the lone type when there's only one unique
 * entry, avoiding wrapping single types in a one-element union.
 */
function unionTypes(types: VariableType[]): VariableType {
  const seen = new Map<string, VariableType>();
  for (const t of types) {
    const key = JSON.stringify(t);
    if (!seen.has(key)) seen.set(key, t);
  }
  const uniques = Array.from(seen.values());
  if (uniques.length === 1) return uniques[0];
  return { type: "unionType", types: uniques };
}
