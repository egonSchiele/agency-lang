import type {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
  Expression,
  FunctionCall,
  NamedArgument,
  SplatExpression,
  Tag,
  TypeAliasEntry,
  ValueAccess,
  AccessChainElement,
  VariableType,
} from "../types.js";

/**
 * Bindings map: value-parameter name → use-site Expression that should
 * replace any `variableName` reference to that param inside the alias's
 * tag-argument expressions.
 *
 * Example: for `Age(18)` instantiating `type Age(min: number) = number`
 * the bindings are `{ min: <numberLiteral 18> }`.
 */
export type ValueArgBindings = Record<string, Expression>;

/**
 * Walk a `Tag` (specifically its `arguments` list) and return a fresh
 * Tag whose arguments have every value-parameter `variableName`
 * reference replaced with a structural CLONE of the bound expression.
 *
 * The input tag is not mutated. The returned tag shares no Expression
 * nodes with the input, so callers may further substitute or attach
 * additional tags without aliasing.
 */
export function substituteValueArgsInTag(
  tag: Tag,
  bindings: ValueArgBindings,
): Tag {
  return {
    ...tag,
    arguments: tag.arguments.map((a) =>
      substituteValueArgsInExpression(a, bindings),
    ),
  };
}

/**
 * Recursively walk an Expression tree, replacing any `variableName`
 * whose `value` matches a key in `bindings` with a structural CLONE
 * of the bound expression. All other nodes are returned unchanged
 * (deep-cloned only along the spine that contains a substitution
 * target — leaves not in `bindings` reuse the original node, but the
 * containing array/object is rebuilt so the caller sees a fresh tree
 * along the substitution path).
 *
 * For nodes outside the restricted tag-arg subset this is a no-op
 * passthrough: only literals, identifiers, object literals (with
 * splats), valueAccess chains, and function-call arg lists inside
 * PFAs are descended into. Anything else (binops, ternaries, etc.)
 * is returned unchanged because the tag-arg parser would have
 * rejected it before substitution is ever reached.
 */
export function substituteValueArgsInExpression(
  expr: Expression,
  bindings: ValueArgBindings,
): Expression {
  switch (expr.type) {
    case "variableName": {
      const bound = bindings[expr.value];
      if (bound !== undefined) return cloneExpression(bound);
      return expr;
    }
    case "agencyObject":
      return substituteInObject(expr, bindings);
    case "agencyArray":
      return substituteInArray(expr, bindings);
    case "functionCall":
      return substituteInFunctionCall(expr, bindings);
    case "valueAccess":
      return substituteInValueAccess(expr, bindings);
    default:
      // Literals (number, string, boolean, null) and anything else not
      // in the restricted tag-arg subset are returned as-is.
      return expr;
  }
}

function substituteInObject(
  obj: AgencyObject,
  bindings: ValueArgBindings,
): AgencyObject {
  return {
    ...obj,
    entries: obj.entries.map((entry) => {
      if ("key" in entry) {
        const kv = entry as AgencyObjectKV;
        return {
          ...kv,
          value: substituteValueArgsInExpression(kv.value, bindings),
        };
      }
      const sp = entry as SplatExpression;
      return {
        ...sp,
        value: substituteValueArgsInExpression(sp.value, bindings),
      };
    }),
  };
}

function substituteInArray(
  arr: AgencyArray,
  bindings: ValueArgBindings,
): AgencyArray {
  return {
    ...arr,
    items: arr.items.map((item) => {
      if (item.type === "splat") {
        return {
          ...item,
          value: substituteValueArgsInExpression(item.value, bindings),
        };
      }
      return substituteValueArgsInExpression(item, bindings);
    }),
  };
}

function substituteInFunctionCall(
  call: FunctionCall,
  bindings: ValueArgBindings,
): FunctionCall {
  return {
    ...call,
    arguments: (call.arguments ?? []).map((a) => {
      if (a.type === "namedArgument") {
        const na = a as NamedArgument;
        return {
          ...na,
          value: substituteValueArgsInExpression(na.value, bindings),
        };
      }
      if (a.type === "splat") {
        const sp = a as SplatExpression;
        return {
          ...sp,
          value: substituteValueArgsInExpression(sp.value, bindings),
        };
      }
      return substituteValueArgsInExpression(a as Expression, bindings);
    }),
  };
}

function substituteInValueAccess(
  va: ValueAccess,
  bindings: ValueArgBindings,
): ValueAccess {
  return {
    ...va,
    base: substituteValueArgsInExpression(
      va.base as Expression,
      bindings,
    ) as unknown as ValueAccess["base"],
    chain: va.chain.map((el) => substituteInChainElement(el, bindings)),
  };
}

function substituteInChainElement(
  el: AccessChainElement,
  bindings: ValueArgBindings,
): AccessChainElement {
  if (el.kind === "property") return el;
  if (el.kind === "index") {
    return {
      ...el,
      index: substituteValueArgsInExpression(el.index, bindings),
    };
  }
  if (el.kind === "slice") {
    return {
      ...el,
      start: el.start
        ? substituteValueArgsInExpression(el.start, bindings)
        : el.start,
      end: el.end
        ? substituteValueArgsInExpression(el.end, bindings)
        : el.end,
    };
  }
  if (el.kind === "methodCall") {
    return {
      ...el,
      functionCall: substituteInFunctionCall(el.functionCall, bindings),
    };
  }
  if (el.kind === "call") {
    return {
      ...el,
      arguments: (el.arguments ?? []).map((a) => {
        if (a.type === "namedArgument") {
          const na = a as NamedArgument;
          return {
            ...na,
            value: substituteValueArgsInExpression(na.value, bindings),
          };
        }
        if (a.type === "splat") {
          const sp = a as SplatExpression;
          return {
            ...sp,
            value: substituteValueArgsInExpression(sp.value, bindings),
          };
        }
        return substituteValueArgsInExpression(a as Expression, bindings);
      }),
    };
  }
  return el;
}

/**
 * Structural deep clone of an Expression. We never share Expression
 * nodes between an alias declaration and a use-site instantiation
 * (separate substitutions must not see each other's mutations).
 *
 * Implemented via `JSON.parse(JSON.stringify(...))` because the
 * Expression subset accepted in tag args is plain data: no functions,
 * no cycles. Suffices for the cases we care about (literals, object
 * literals, PFA expressions).
 */
function cloneExpression(expr: Expression): Expression {
  return JSON.parse(JSON.stringify(expr)) as Expression;
}

/**
 * Best-effort type inference for a value argument expression. Returns a
 * primitive type name (`"number"`, `"string"`, `"boolean"`, `"null"`) for
 * the literal forms we can statically classify, or `undefined` when we
 * can't (identifier references, object literals, PFA expressions).
 *
 * Used by `applyValueArgs` to detect literal-vs-declared-type mismatches.
 * A best-effort signal: when we can't infer (e.g. a static-const
 * identifier), we silently accept and defer to runtime — same trade-off
 * the rest of the typechecker makes for restricted tag-arg subsets.
 */
function inferLiteralType(expr: Expression): string | undefined {
  switch (expr.type) {
    case "number":
      return "number";
    case "string":
    case "multiLineString":
      return "string";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return undefined;
  }
}

function variableTypeName(t: unknown): string {
  if (!t || typeof t !== "object") return "?";
  const node = t as { type?: string; value?: string };
  if (node.type === "primitiveType" && typeof node.value === "string") {
    return node.value;
  }
  return node.type ?? "?";
}

/**
 * Take a `TypeAliasEntry` and the use-site `valueArgs` list, and
 * return a fresh `TypeAliasEntry` whose `tags` have every value-param
 * identifier reference replaced with the corresponding argument
 * expression.
 *
 * Behavior:
 *
 * 1. Validates arity: too many args is an error; missing args are
 *    filled from `valueParams[i].default` when present, or reported.
 * 2. Builds the bindings map (param name → arg expression).
 * 3. Maps `entry.tags` through `substituteValueArgsInTag`.
 * 4. Returns a new entry with the substituted tags. `body` and
 *    `typeParams` are kept as-is — type-param substitution is handled
 *    by the existing `substituteTypeParams` pass, which runs BEFORE
 *    `applyValueArgs` when both are needed (see assignability.ts).
 *
 * Throws a `TypeError` for arg-count / arg-type problems. The message
 * is intentionally readable so it bubbles directly to the user.
 *
 * The `aliasName` parameter is used only for error messages.
 */
export function applyValueArgs(
  entry: TypeAliasEntry,
  valueArgs: Expression[] | undefined,
  aliasName: string,
): TypeAliasEntry {
  const params = entry.valueParams ?? [];
  const args = valueArgs ?? [];

  if (args.length > params.length) {
    throw new TypeError(
      `${aliasName} expects ${params.length} value arguments, got ${args.length}`,
    );
  }

  const bindings: ValueArgBindings = {};
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const provided = i < args.length ? args[i] : undefined;
    if (provided !== undefined) {
      const litType = inferLiteralType(provided);
      const declared = variableTypeName(p.type);
      if (litType && declared !== "?" && litType !== declared) {
        // Best-effort literal type-check. Skip null vs declared-nullable etc.
        const loc = (provided as { loc?: { line: number; col: number } }).loc;
        const locStr = loc ? ` (at line ${loc.line}, col ${loc.col})` : "";
        throw new TypeError(
          `argument ${p.name} expected ${declared}, got ${litType}${locStr}`,
        );
      }
      bindings[p.name] = provided;
    } else if (p.default !== undefined) {
      bindings[p.name] = p.default;
    } else {
      throw new TypeError(
        `${aliasName} requires '${p.name}': ${variableTypeName(p.type)}`,
      );
    }
  }

  const newTags = (entry.tags ?? []).map((t) =>
    substituteValueArgsInTag(t, bindings),
  );

  const newBody = substituteValueArgsInType(entry.body, bindings);

  return {
    ...entry,
    body: newBody,
    tags: newTags,
  };
}

/**
 * Walk a `VariableType` tree and substitute value-arg bindings into any
 * inner `typeAliasVariable` or `genericType` reference that itself
 * carries `valueArgs`. This enables wrapping aliases such as
 * `type EvenInRange(low, high) = NumberInRange(low, high)` — when the
 * outer alias is resolved the inner reference's `valueArgs` need their
 * value-param identifier references replaced with the outer alias's
 * bound arguments.
 *
 * Returns a fresh tree along any spine touched by substitution; nodes
 * with no inner valueArgs pass through unchanged.
 */
export function substituteValueArgsInType(
  vt: VariableType,
  bindings: ValueArgBindings,
): VariableType {
  switch (vt.type) {
    case "typeAliasVariable": {
      if (!vt.valueArgs) return vt;
      return {
        ...vt,
        valueArgs: vt.valueArgs.map((a) =>
          substituteValueArgsInExpression(a, bindings),
        ),
      };
    }
    case "genericType": {
      const newTypeArgs = vt.typeArgs.map((a) =>
        substituteValueArgsInType(a, bindings),
      );
      const newValueArgs = vt.valueArgs
        ? vt.valueArgs.map((a) =>
            substituteValueArgsInExpression(a, bindings),
          )
        : undefined;
      return { ...vt, typeArgs: newTypeArgs, valueArgs: newValueArgs };
    }
    case "arrayType":
      return {
        ...vt,
        elementType: substituteValueArgsInType(vt.elementType, bindings),
      };
    case "unionType":
      return {
        ...vt,
        types: vt.types.map((t) => substituteValueArgsInType(t, bindings)),
      };
    case "objectType":
      return {
        ...vt,
        properties: vt.properties.map((p) => ({
          ...p,
          value: substituteValueArgsInType(p.value, bindings),
        })),
      };
    case "resultType":
      return {
        ...vt,
        successType: substituteValueArgsInType(vt.successType, bindings),
        failureType: substituteValueArgsInType(vt.failureType, bindings),
      };
    case "schemaType":
      return {
        ...vt,
        inner: substituteValueArgsInType(vt.inner, bindings),
      };
    case "blockType":
      return {
        ...vt,
        params: vt.params.map((p) => ({
          ...p,
          typeAnnotation: substituteValueArgsInType(p.typeAnnotation, bindings),
        })),
        returnType: substituteValueArgsInType(vt.returnType, bindings),
      };
    default:
      // primitiveType, stringLiteralType, numberLiteralType,
      // booleanLiteralType, functionRefType — no inner VariableType /
      // valueArgs to walk.
      return vt;
  }
}
