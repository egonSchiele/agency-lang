import type { VariableType } from "../types.js";
import type { ObjectProperty, ObjectType } from "../types/typeHints.js";
import { formatTypeHint } from "../utils/formatType.js";
import { mergeTagSets } from "./mergeTags.js";
import { resolveKeysArg, resolveObjectArg } from "./builtinGenerics.js";
import { NEVER_T } from "./primitives.js";

/**
 * Eager evaluation for the type operators `keyof T` and `T["key"]`.
 * Both run during type resolution and produce ordinary types, so nothing
 * downstream knows the operator nodes exist.
 *
 * Argument validation is SHARED with the builtin generics
 * (resolveObjectArg / resolveKeysArg) so the error wording stays one
 * family across Partial, Pick, keyof, and indexed access.
 *
 * CYCLE RULE: this module must not import assignability.ts. The resolver
 * arrives as the `resolve` callback, carrying the caller's in-progress
 * guard, so recursive alias operands degrade the same way they do
 * everywhere else.
 */
type Resolve = (t: VariableType) => VariableType;

export function evalKeyof(
  operand: VariableType,
  resolve: Resolve,
): VariableType {
  const obj = resolveObjectArg("keyof", operand, resolve);
  const keys: VariableType[] = obj.properties.map((p) => ({
    type: "stringLiteralType",
    value: p.key,
  }));
  if (keys.length === 0) return NEVER_T;
  if (keys.length === 1) return keys[0];
  return { type: "unionType", types: keys };
}

export function evalIndexedAccess(
  objectType: VariableType,
  index: VariableType,
  resolve: Resolve,
): VariableType {
  const obj = resolveObjectArg("indexed access", objectType, resolve);
  const keys = resolveKeysArg("indexed access", index, resolve);
  const results = keys.map((key) => {
    const prop = obj.properties.find((p) => p.key === key);
    if (!prop) {
      const available = obj.properties.map((p) => p.key).join(", ");
      throw new TypeError(
        `indexed access key '${key}' does not exist on the target type. Available keys: ${available}`,
      );
    }
    return prop.value;
  });
  if (results.length === 1) return results[0];
  return { type: "unionType", types: results };
}

/** Injected structural-identity comparator — see the CYCLE RULE above:
 *  typeKey lives behind assignability, so the caller provides equality
 *  the same way it provides `resolve`. */
export type TypeEquals = (a: VariableType, b: VariableType) => boolean;

/**
 * `A & B & ...` — merge object types. Four steps:
 *
 *   RESOLVE  every operand to an object type
 *   GROUP    all properties across all operands by key,
 *            in first-seen key order
 *   COMBINE  each key group into one property (the shared-key
 *            rules live in intersectPropertyValues)
 *   BUILD    an ordinary object type
 *
 * Grouping ALL operands at once (rather than folding pairwise) is what
 * makes the merge n-ary and associative by construction.
 */
export function evalIntersection(
  members: VariableType[],
  resolve: Resolve,
  typesEqual: TypeEquals,
): VariableType {
  const objects = members.map((m) =>
    resolveObjectArg("intersection", m, resolve),
  );
  return mergeObjects(objects, resolve, typesEqual);
}

function mergeObjects(
  objects: ObjectType[],
  resolve: Resolve,
  typesEqual: TypeEquals,
): ObjectType {
  const groups = groupPropertiesByKey(objects);
  const properties = groups.map((group) =>
    combineGroup(group, resolve, typesEqual),
  );
  return { type: "objectType", properties };
}

/**
 * Every declaration of every key, grouped, in first-seen key order.
 * A disjoint key produces a one-element group; a shared key produces
 * one group holding each side's declaration.
 */
function groupPropertiesByKey(objects: ObjectType[]): ObjectProperty[][] {
  // keyOrder preserves first-seen order; a plain Record iterated via
  // Object.entries (or the groupBy in effectPayloadCheck.ts) reorders
  // integer-like keys ("0", "1") ahead of string keys, and all-digit
  // property keys are parseable.
  const keyOrder: string[] = [];
  // Null-prototype dict: keys are user-controlled property names, so
  // "__proto__"/"toString" must not collide with Object.prototype
  // (the scope.ts discipline).
  const byKey: Record<string, ObjectProperty[]> = Object.create(null);
  for (const obj of objects) {
    for (const prop of obj.properties) {
      if (byKey[prop.key] === undefined) {
        byKey[prop.key] = [];
        keyOrder.push(prop.key);
      }
      byKey[prop.key].push(prop);
    }
  }
  return keyOrder.map((key) => byKey[key]);
}

/**
 * Fold a key group into one property. A one-element group returns its
 * property untouched (reduce with no initial value). A shared key
 * intersects the value types and merges the tags — a value of `A & B`
 * must satisfy BOTH sides, so both validate chains apply. The LEFT
 * declaration keeps its description (the spread).
 */
function combineGroup(
  group: ObjectProperty[],
  resolve: Resolve,
  typesEqual: TypeEquals,
): ObjectProperty {
  return group.reduce((left, right) => ({
    ...left,
    value: intersectPropertyValues(
      left.key,
      left.value,
      right.value,
      resolve,
      typesEqual,
    ),
    tags: mergeTagSets(left.tags, right.tags),
  }));
}

/**
 * The three shared-key rules, in order:
 *
 *   identical types   -> keep one copy
 *   two object types  -> merge recursively (same pipeline)
 *   anything else     -> no overlap; error naming the key
 */
function intersectPropertyValues(
  key: string,
  leftValue: VariableType,
  rightValue: VariableType,
  resolve: Resolve,
  typesEqual: TypeEquals,
): VariableType {
  const left = resolve(leftValue);
  const right = resolve(rightValue);
  if (typesEqual(left, right)) return left;
  if (left.type === "objectType" && right.type === "objectType") {
    return mergeObjects([left, right], resolve, typesEqual);
  }
  throw new TypeError(
    `cannot intersect key '${key}': '${formatTypeHint(left)}' and '${formatTypeHint(right)}' have no overlap`,
  );
}
