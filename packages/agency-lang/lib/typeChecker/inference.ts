import {
  AgencyNode,
  FunctionDefinition,
  GraphNodeDefinition,
  VariableType,
  functionScope,
  nodeScope,
} from "../types.js";
import { scopeKey } from "../programInfo.js";
import { walkNodes } from "../utils/node.js";
import { isAssignable, widenType } from "./assignability.js";
import { synthType, SynthContext } from "./synthesizer.js";
import { collectVariableTypes } from "./scopes.js";
import { TypeCheckerContext } from "./types.js";
import { Scope } from "./scope.js";

export function inferReturnTypes(
  ctx: TypeCheckerContext,
  synthCtx: SynthContext,
): void {
  const allDefs: (FunctionDefinition | GraphNodeDefinition)[] = [
    ...Object.values(ctx.functionDefs),
    ...Object.values(ctx.nodeDefs),
  ];

  for (const def of allDefs) {
    if (def.returnType) continue;

    const name = def.type === "function" ? def.functionName : def.nodeName;
    inferReturnTypeFor(name, def, ctx, synthCtx);
  }
}

export function inferReturnTypeFor(
  name: string,
  def: FunctionDefinition | GraphNodeDefinition,
  ctx: TypeCheckerContext,
  synthCtx: SynthContext,
): VariableType | "any" {
  if (name in ctx.inferredReturnTypes) {
    return ctx.inferredReturnTypes[name];
  }

  if (ctx.inferringReturnType.has(name)) {
    return "any";
  }

  ctx.inferringReturnType.add(name);

  const defScopeKey = def.type === "function"
    ? scopeKey(functionScope(def.functionName))
    : scopeKey(nodeScope(def.nodeName));

  return ctx.withScope(defScopeKey, () => {
    const scope = new Scope(defScopeKey);
    for (const param of def.parameters) {
      scope.declare(param.name, param.typeHint ?? "any");
    }
    collectVariableTypes(def.body, scope, name, synthCtx);

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
      const types = returnValues.map((v) => synthType(v, scope.toRecord(), synthCtx));
      if (types.some((t) => t === "any")) {
        inferred = "any";
      } else {
        const first = types[0] as VariableType;
        const allSame = types.every(
          (t) =>
            t !== "any" &&
            isAssignable(t, first, typeAliases) &&
            isAssignable(first, t, typeAliases),
        );
        inferred = allSame ? first : "any";
      }
    }

    ctx.inferredReturnTypes[name] = widenType(inferred);
    ctx.inferringReturnType.delete(name);
    return ctx.inferredReturnTypes[name];
  });
}
