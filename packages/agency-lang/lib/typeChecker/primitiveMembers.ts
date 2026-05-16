import type { VariableType } from "../types.js";
import type { BuiltinSignature } from "./types.js";
import {
  ANY_T,
  BOOLEAN_T,
  NUMBER_T,
  REGEX_T,
  STRING_T,
} from "./primitives.js";

/**
 * Built-in members of primitive Agency types (string, array, …) — analogous
 * to {@link JS_GLOBALS} but keyed by the *type* of the receiver value rather
 * than by a name in scope. Consumed by synthValueAccess to resolve property
 * and method access through chains like `s.length`, `xs.slice(1).join(",")`.
 *
 * Two member kinds:
 *   - `property` — `.foo` returns `type` (e.g. `.length` → number).
 *   - `method`   — `.foo(args)` validated against `sig`, returns `sig.returnType`.
 *
 * `type` / `sig` may be a function of the receiver type for cases where
 * the result depends on the element type (e.g. `Array<T>.slice` returns
 * `Array<T>`, `Array<T>.indexOf(T) → number`).
 *
 * Phase 1 scope: string + array members that don't take callbacks.
 * Callback-taking methods (`map`/`filter`/`reduce`/…) need to wire a
 * functionRefType param — Phase 2.
 */
type SigOrThunk =
  | BuiltinSignature
  | ((receiver: VariableType) => BuiltinSignature);

type TypeOrThunk =
  | VariableType
  | ((receiver: VariableType) => VariableType);

export type PrimitiveMember =
  | { kind: "property"; type: TypeOrThunk }
  | { kind: "method"; sig: SigOrThunk };

const stringArray: VariableType = { type: "arrayType", elementType: STRING_T };

/** `T` for `Array<T>`, fall back to `any` for non-array receivers. */
const elementOf = (receiver: VariableType): VariableType =>
  receiver.type === "arrayType" ? receiver.elementType : ANY_T;

const STRING_MEMBERS: Record<string, PrimitiveMember> = {
  length: { kind: "property", type: NUMBER_T },

  // Case / whitespace
  toUpperCase: { kind: "method", sig: { params: [], returnType: STRING_T } },
  toLowerCase: { kind: "method", sig: { params: [], returnType: STRING_T } },
  trim:        { kind: "method", sig: { params: [], returnType: STRING_T } },
  trimStart:   { kind: "method", sig: { params: [], returnType: STRING_T } },
  trimEnd:     { kind: "method", sig: { params: [], returnType: STRING_T } },

  // Search
  indexOf:     { kind: "method", sig: {
    params: [STRING_T, NUMBER_T], minParams: 1, returnType: NUMBER_T,
  } },
  lastIndexOf: { kind: "method", sig: {
    params: [STRING_T, NUMBER_T], minParams: 1, returnType: NUMBER_T,
  } },
  includes:    { kind: "method", sig: {
    params: [STRING_T, NUMBER_T], minParams: 1, returnType: BOOLEAN_T,
  } },
  startsWith:  { kind: "method", sig: {
    params: [STRING_T, NUMBER_T], minParams: 1, returnType: BOOLEAN_T,
  } },
  endsWith:    { kind: "method", sig: {
    params: [STRING_T, NUMBER_T], minParams: 1, returnType: BOOLEAN_T,
  } },

  // Slicing
  slice:       { kind: "method", sig: {
    params: [NUMBER_T, NUMBER_T], minParams: 0, returnType: STRING_T,
  } },
  substring:   { kind: "method", sig: {
    params: [NUMBER_T, NUMBER_T], minParams: 1, returnType: STRING_T,
  } },
  charAt:      { kind: "method", sig: { params: [NUMBER_T], returnType: STRING_T } },
  charCodeAt:  { kind: "method", sig: { params: [NUMBER_T], returnType: NUMBER_T } },
  repeat:      { kind: "method", sig: { params: [NUMBER_T], returnType: STRING_T } },

  // Replace / split — second arg of replace can be a function in JS, but
  // we don't model that yet; type as string for now.
  split:       { kind: "method", sig: {
    params: [{ type: "unionType", types: [STRING_T, REGEX_T] }],
    returnType: stringArray,
  } },
  replace:     { kind: "method", sig: {
    params: [{ type: "unionType", types: [STRING_T, REGEX_T] }, STRING_T],
    returnType: STRING_T,
  } },
  replaceAll:  { kind: "method", sig: {
    params: [{ type: "unionType", types: [STRING_T, REGEX_T] }, STRING_T],
    returnType: STRING_T,
  } },

  // Padding / concat
  padStart:    { kind: "method", sig: {
    params: [NUMBER_T, STRING_T], minParams: 1, returnType: STRING_T,
  } },
  padEnd:      { kind: "method", sig: {
    params: [NUMBER_T, STRING_T], minParams: 1, returnType: STRING_T,
  } },
  concat:      { kind: "method", sig: {
    params: [], restParam: STRING_T, returnType: STRING_T,
  } },

  // Regex
  match:       { kind: "method", sig: {
    params: [REGEX_T], returnType: { type: "unionType", types: [stringArray, { type: "primitiveType", value: "undefined" }] },
  } },
};

const ARRAY_MEMBERS: Record<string, PrimitiveMember> = {
  length: { kind: "property", type: NUMBER_T },

  // Search — element-typed param.
  indexOf:     { kind: "method", sig: (r) => ({
    params: [elementOf(r), NUMBER_T], minParams: 1, returnType: NUMBER_T,
  }) },
  lastIndexOf: { kind: "method", sig: (r) => ({
    params: [elementOf(r), NUMBER_T], minParams: 1, returnType: NUMBER_T,
  }) },
  includes:    { kind: "method", sig: (r) => ({
    params: [elementOf(r), NUMBER_T], minParams: 1, returnType: BOOLEAN_T,
  }) },

  // Joining
  join:        { kind: "method", sig: {
    params: [STRING_T], minParams: 0, returnType: STRING_T,
  } },

  // Slice / concat preserve receiver type.
  slice:       { kind: "method", sig: (r) => ({
    params: [NUMBER_T, NUMBER_T], minParams: 0, returnType: r,
  }) },
  concat:      { kind: "method", sig: (r) => ({
    params: [r], returnType: r,
  }) },

  // Mutation — push/unshift return new length, pop/shift return element|undefined.
  push:        { kind: "method", sig: (r) => ({
    params: [], restParam: elementOf(r), returnType: NUMBER_T,
  }) },
  unshift:     { kind: "method", sig: (r) => ({
    params: [], restParam: elementOf(r), returnType: NUMBER_T,
  }) },
  pop:         { kind: "method", sig: (r) => ({
    params: [], returnType: {
      type: "unionType",
      types: [elementOf(r), { type: "primitiveType", value: "undefined" }],
    },
  }) },
  shift:       { kind: "method", sig: (r) => ({
    params: [], returnType: {
      type: "unionType",
      types: [elementOf(r), { type: "primitiveType", value: "undefined" }],
    },
  }) },
  reverse:     { kind: "method", sig: (r) => ({ params: [], returnType: r }) },
};

/**
 * Look up a built-in member on a primitive receiver type. Returns `null`
 * if `type` isn't a recognized primitive shape or `name` isn't a known
 * member of it.
 *
 * Recognized receiver shapes:
 *   - primitiveType "string" / stringLiteralType → STRING_MEMBERS
 *   - arrayType                                  → ARRAY_MEMBERS
 *
 * Other shapes (number, boolean, object, …) return null for now — the
 * caller falls back to its existing "property does not exist" error.
 */
export function lookupPrimitiveMember(
  type: VariableType,
  name: string,
): PrimitiveMember | null {
  // Own-property lookup — `name in obj` walks the prototype chain, so
  // names like `toString` / `constructor` would falsely resolve against
  // these plain-object registries.
  const own = (obj: Record<string, PrimitiveMember>) =>
    Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : null;

  if (type.type === "primitiveType" && type.value === "string") {
    return own(STRING_MEMBERS);
  }
  if (type.type === "stringLiteralType") {
    return own(STRING_MEMBERS);
  }
  if (type.type === "arrayType") {
    return own(ARRAY_MEMBERS);
  }
  return null;
}

/** Resolve a `SigOrThunk` against a concrete receiver type. */
export function resolveSig(
  sig: SigOrThunk,
  receiver: VariableType,
): BuiltinSignature {
  return typeof sig === "function" ? sig(receiver) : sig;
}

/** Resolve a `TypeOrThunk` against a concrete receiver type. */
export function resolvePropertyType(
  type: TypeOrThunk,
  receiver: VariableType,
): VariableType {
  return typeof type === "function" ? type(receiver) : type;
}

/**
 * How to compute the return type of a callback-taking array method, given
 * the receiver `Array<T>` and the callback's own return type `U`.
 *
 *   "arrayU"      — `Array<U>`. e.g. `map`.
 *   "sameArray"   — `Array<T>` (callback's return is irrelevant). `filter`/`sort`.
 *   "void"        — `void`. `forEach`.
 *   "elementOrUndef" — `T | undefined`. `find`.
 *   "boolean"     — boolean. `some`/`every`.
 *   "flatten"     — `Array<U>` where the callback's return is `Array<U>` —
 *                   we unwrap one level. `flatMap`.
 *   "reduce"      — `U` (or accumulator init type if available). `reduce`.
 *
 * Methods are not parsed via the BUILTIN_FUNCTION_TYPES path — instead,
 * `synthValueAccess` consults this table directly when it sees a known
 * callback method on an `arrayType` receiver. Callback signature
 * validation (arity, body return type vs. expected slot) is left to a
 * future phase; today we trust the body and inherit best-effort.
 */
export const ARRAY_CALLBACK_METHOD_KINDS = {
  map: "arrayU",
  filter: "sameArray",
  forEach: "void",
  find: "elementOrUndef",
  some: "boolean",
  every: "boolean",
  sort: "sameArray",
  flatMap: "flatten",
  reduce: "reduce",
} as const;

export type ArrayCallbackKind =
  (typeof ARRAY_CALLBACK_METHOD_KINDS)[keyof typeof ARRAY_CALLBACK_METHOD_KINDS];

/** Look up an array callback method, or null if `name` isn't a known one. */
export function lookupArrayCallbackMethod(
  name: string,
): ArrayCallbackKind | null {
  return Object.prototype.hasOwnProperty.call(ARRAY_CALLBACK_METHOD_KINDS, name)
    ? ARRAY_CALLBACK_METHOD_KINDS[name as keyof typeof ARRAY_CALLBACK_METHOD_KINDS]
    : null;
}
