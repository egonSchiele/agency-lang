import { Tag, TypeAliasEntry, TypeParam, VariableType } from "../types.js";
import { ANY_T, BOOLEAN_T, NUMBER_T, STRING_T } from "./primitives.js";
import { substituteTypeParams } from "./substitute.js";
import { mapTypes } from "./typeWalker.js";
import { mergeTagSets } from "./mergeTags.js";
import { applyValueArgs } from "./valueParamSubstitution.js";
import { resultToObjectUnion } from "./resultUnion.js";
import { typeKey } from "./typeKey.js";
import {
  evalBuiltinGeneric,
  isBuiltinGenericName,
  withUseSiteTags,
} from "./builtinGenerics.js";
import { evalIndexedAccess, evalKeyof } from "./typeOperators.js";

/**
 * Public resolveType: normalizes a VariableType by resolving type-alias
 * references and built-in generic forms.
 *
 *   `Array<T>`  → `arrayType { elementType: T }`
 *   `Schema<T>` → `schemaType { inner: T }`
 *   `Record<K, V>` → unchanged `genericType` (survives to codegen) after
 *                    validating the key type
 *   `typeAliasVariable("X")` → body of alias X (recursively)
 *
 * Recursion guarding for self-referential generic aliases (added in
 * Task 9) lives in the private `resolveTypeWithGuard` helper. The public
 * signature stays small.
 */
export function resolveType(
  vt: VariableType,
  typeAliases: Record<string, TypeAliasEntry>,
): VariableType {
  return resolveTypeWithGuard(vt, typeAliases, new Set());
}

/**
 * Non-throwing wrapper around `resolveType` for use inside the main
 * typecheck pipeline (synthesizer, isAssignable, etc.). If the input
 * contains an invalid generic form (unknown name, wrong arity, bad
 * Record key, missing required type args, …) we don't want to crash the
 * entire typecheck run — the user-facing diagnostic is reported by
 * `validateTypeReferences` as part of the regular validation pass, and
 * callers here just need a usable VariableType to continue with.
 *
 * Falling back to `any` matches how unresolved/unknown types are handled
 * everywhere else in the checker — it short-circuits further constraints
 * without producing spurious assignability errors.
 */
export function safeResolveType(
  vt: VariableType,
  typeAliases: Record<string, TypeAliasEntry>,
): VariableType {
  try {
    return resolveType(vt, typeAliases);
  } catch (e) {
    if (e instanceof TypeError) return ANY_T;
    throw e;
  }
}

function resolveTypeWithGuard(
  vt: VariableType,
  typeAliases: Record<string, TypeAliasEntry>,
  inProgress: Set<string>,
): VariableType {
  if (vt.type === "typeAliasVariable") {
    const entry = typeAliases[vt.aliasName];
    if (!entry) return vt;

    // Bare use of a generic alias is only allowed if every parameter has a default.
    if (entry.typeParams && entry.typeParams.some((p) => !p.default)) {
      throw new TypeError(`${vt.aliasName} requires type arguments`);
    }

    // Self-reference inside the same alias body — stop recursing.
    if (inProgress.has(vt.aliasName)) return vt;
    const next = new Set(inProgress).add(vt.aliasName);

    // Apply value-arg substitution to the alias entry's tags (no-op
    // when the alias has no `valueParams`). For combined `<T>(n)`
    // aliases we still substitute type params first via the existing
    // path below; value-arg substitution touches only the tags.
    const substitutedEntry = entry.valueParams
      ? applyValueArgs(entry, vt.valueArgs, vt.aliasName)
      : entry;

    if (substitutedEntry.typeParams) {
      const args = substitutedEntry.typeParams.map((p) => p.default!);
      const substituted = substituteTypeParams(
        substitutedEntry.body,
        substitutedEntry.typeParams.map((p) => p.name),
        args,
      );
      const resolved = resolveTypeWithGuard(substituted, typeAliases, next);
      return attachAliasTags(resolved, substitutedEntry.tags);
    }
    const resolved = resolveTypeWithGuard(substitutedEntry.body, typeAliases, next);
    return attachAliasTags(resolved, substitutedEntry.tags);
  }

  if (vt.type === "keyofType") {
    // Eager evaluation (lib/typeChecker/typeOperators.ts): the node never
    // survives resolution. Occurrence tags thread through like the
    // genericType branch below.
    return withUseSiteTags(
      evalKeyof(vt.operand, (t) =>
        resolveTypeWithGuard(t, typeAliases, inProgress),
      ),
      vt.tags,
    );
  }
  if (vt.type === "indexedAccessType") {
    return withUseSiteTags(
      evalIndexedAccess(vt.objectType, vt.index, (t) =>
        resolveTypeWithGuard(t, typeAliases, inProgress),
      ),
      vt.tags,
    );
  }

  if (vt.type === "genericType") {
    // ALL built-in generic forms (Array, Schema, Record, and the utility
    // types) live in the builtinGenerics.ts registry and evaluate eagerly.
    // The resolver callback carries this call's in-progress guard, so
    // recursive alias arguments degrade gracefully (self-refs stay
    // nominal). Tag handling is per-entry: utility types merge the
    // occurrence's tags as the use-site layer; Array/Schema/Record keep
    // their historical behavior.
    if (isBuiltinGenericName(vt.name)) {
      return evalBuiltinGeneric(
        vt.name,
        vt.typeArgs,
        (t) => resolveTypeWithGuard(t, typeAliases, inProgress),
        vt.tags,
      );
    }
    // User-defined generic alias.
    const entry = typeAliases[vt.name];
    if (!entry) throw new TypeError(`Unknown generic type ${vt.name}`);
    if (!entry.typeParams) {
      throw new TypeError(`${vt.name} is not a generic type`);
    }

    // Self-reference within the alias body: preserve the genericType wrapper
    // with substituted args; don't try to re-expand or we'd recurse forever.
    if (inProgress.has(vt.name)) {
      return {
        ...vt,
        typeArgs: vt.typeArgs.map((a) =>
          resolveTypeWithGuard(a, typeAliases, inProgress),
        ),
      };
    }

    const args = fillDefaults(vt.typeArgs, entry.typeParams, vt.name);
    const next = new Set(inProgress).add(vt.name);
    const substituted = substituteTypeParams(
      entry.body,
      entry.typeParams.map((p) => p.name),
      args,
    );
    // Apply value-arg substitution (no-op when the alias has no
    // `valueParams`). Type-param substitution happened first (above);
    // value-arg substitution must run on the type-substituted body so
    // forwarded value args inside the body (e.g.
    // `type Wrap<T>(n: number) = BoundedList<T>(n)`) get the literal
    // substituted at use sites.
    const valueSubstituted = entry.valueParams
      ? applyValueArgs({ ...entry, body: substituted }, vt.valueArgs, vt.name)
      : { ...entry, body: substituted };
    const resolved = resolveTypeWithGuard(valueSubstituted.body, typeAliases, next);
    return attachAliasTags(resolved, valueSubstituted.tags);
  }

  return vt;
}

/**
 * Return a shallow copy of `vt` with the alias's tags concatenated onto
 * any tags the resolved type already has. We never mutate `vt`.
 *
 * The merge rule between alias and use-site tags is documented in
 * `mergeTagSets` (lib/typeChecker/mergeTags.ts) and applied by callers
 * that have both available. resolveType only ever has the alias side.
 */
function attachAliasTags(vt: VariableType, aliasTags: Tag[] | undefined): VariableType {
  if (!aliasTags || aliasTags.length === 0) return vt;
  const merged = mergeTagSets(aliasTags, vt.tags);
  return { ...vt, tags: merged } as VariableType;
}

/**
 * Fill in defaults for omitted type arguments on a user-defined generic.
 * Errors if too many args are supplied or a required (defaultless) param is missing.
 */
function fillDefaults(
  args: VariableType[],
  params: TypeParam[],
  name: string,
): VariableType[] {
  if (args.length > params.length) {
    throw new TypeError(
      `${name} expects at most ${params.length} type arguments, got ${args.length}`,
    );
  }
  const result = [...args];
  for (let i = args.length; i < params.length; i++) {
    const p = params[i];
    if (!p.default) {
      throw new TypeError(
        `${name} requires at least ${i + 1} type arguments`,
      );
    }
    result.push(p.default);
  }
  return result;
}

/**
 * Upper bound on how many full-tree passes `resolveTypeDeep` will run before
 * giving up. Real generic-alias depth is tiny in practice (each pass strips
 * one level); this is purely a runaway-loop guard, not a real depth limit.
 */
const MAX_GENERIC_RESOLUTION_PASSES = 32;

/**
 * Recursively resolve generic types and type aliases throughout a type tree.
 *
 * `resolveType` only normalizes a single node — when a user-defined generic
 * alias like `Container<T>` is substituted, the resulting body may contain
 * further generic forms (e.g. `Wrapper<number>`) that the substituting call
 * hasn't seen. Codegen needs every generic resolved away (other than the
 * survivable `Record<K, V>` form), so this function applies `resolveType`
 * iteratively until a pass produces no change.
 *
 * Used by the TypeScript builder before calling `mapTypeToValidationSchema`
 * / `mapTypeToZodSchema`, neither of which knows how to substitute user-
 * defined generic aliases.
 */
export function resolveTypeDeep(
  t: VariableType,
  typeAliases: Record<string, TypeAliasEntry>,
): VariableType {
  let current = t;
  // Iterate until a pass produces no change. Generic-alias depth is bounded
  // in practice; MAX_GENERIC_RESOLUTION_PASSES exists only to prevent
  // runaway loops on a bug.
  for (let i = 0; i < MAX_GENERIC_RESOLUTION_PASSES; i++) {
    const next = mapTypes(current, (n) => deepResolveNode(n, typeAliases));
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
    current = next;
  }
  return current;
}

/**
 * Per-node rewrite used by resolveTypeDeep. Expands:
 *
 * - `genericType` nodes: built-in Array/Schema get lowered; Record stays a
 *   genericType (with args normalized); user-defined generic aliases get
 *   substituted with their type args.
 * - bare `typeAliasVariable` references *to a generic alias* (e.g. a
 *   `StringMap` written without `<...>` that relies on parameter defaults)
 *   get inlined too, so codegen never sees an unresolved generic alias.
 *
 * Plain non-generic `typeAliasVariable` references are deliberately left
 * intact so codegen can emit them by name (e.g. `Coords` referencing the
 * already-declared zod schema constant).
 */
function deepResolveNode(
  n: VariableType,
  typeAliases: Record<string, TypeAliasEntry>,
): VariableType {
  if (n.type === "genericType") return resolveType(n, typeAliases);
  if (n.type === "keyofType" || n.type === "indexedAccessType") {
    // Same routing as genericType: these evaluate to concrete types and
    // must never reach the zod mapper unresolved — the mapper's fallback
    // silently emits z.string(). See docs/dev/adding-features.md.
    return resolveType(n, typeAliases);
  }
  if (n.type === "typeAliasVariable") {
    const entry = typeAliases[n.aliasName];
    // Inline only generic aliases that can resolve themselves via defaults.
    // Non-generic aliases stay as-is; defaultless generic aliases would
    // throw inside resolveType — let that surface as a typecheck error
    // through the normal pipeline rather than swallowing it here.
    if (entry?.typeParams && entry.typeParams.every((p) => p.default)) {
      return resolveType(n, typeAliases);
    }
  }
  return n;
}

/** True if `t` is the built-in `Record<K, V>` generic (after resolution). */
function isRecord(
  t: VariableType,
): t is VariableType & { type: "genericType"; name: "Record" } {
  return t.type === "genericType" && t.name === "Record";
}

/**
 * If the key type is a literal or a union of literals, return the
 * concrete key strings (number keys are stringified). Returns `null`
 * for open key types like `string` / `number` where no specific keys
 * are required.
 */
function collectLiteralKeys(keyType: VariableType): string[] | null {
  if (keyType.type === "stringLiteralType") return [keyType.value];
  if (keyType.type === "numberLiteralType") return [keyType.value];
  if (keyType.type === "unionType") {
    const keys: string[] = [];
    for (const m of keyType.types) {
      const inner = collectLiteralKeys(m);
      if (inner === null) return null;
      keys.push(...inner);
    }
    return keys;
  }
  return null;
}

export function widenType(vt: VariableType | "any"): VariableType | "any" {
  if (vt === "any") return "any";
  switch (vt.type) {
    case "stringLiteralType":
      return STRING_T;
    case "numberLiteralType":
      return NUMBER_T;
    case "booleanLiteralType":
      return BOOLEAN_T;
    case "objectType":
      return {
        type: "objectType",
        properties: vt.properties.map((p) => ({
          key: p.key,
          value: widenType(p.value) as VariableType,
        })),
      };
    case "arrayType":
      return {
        type: "arrayType",
        elementType: widenType(vt.elementType) as VariableType,
      };
    case "unionType":
      return {
        type: "unionType",
        types: vt.types.map((t) => widenType(t) as VariableType),
      };
    case "resultType":
      return {
        type: "resultType",
        successType: widenType(vt.successType) as VariableType,
        failureType: widenType(vt.failureType) as VariableType,
      };
    case "schemaType":
      return {
        type: "schemaType",
        inner: widenType(vt.inner) as VariableType,
      };
    case "genericType":
      return {
        type: "genericType",
        name: vt.name,
        typeArgs: vt.typeArgs.map((a) => widenType(a) as VariableType),
      };
    default:
      return vt;
  }
}

/** True iff `vt` is the bottom type `never`. */
export function isNever(vt: VariableType | "any"): boolean {
  return vt !== "any" && vt.type === "primitiveType" && vt.value === "never";
}

/**
 * A type that admits `null` as a value, so the corresponding object
 * property may be absent from the source. Covers the `key?: T` desugaring
 * (parsed as `T | null`) plus `any`, which subsumes null.
 */
export function isOptionalType(
  vt: VariableType,
  typeAliases: Record<string, TypeAliasEntry>,
): boolean {
  const resolved = safeResolveType(vt, typeAliases);
  if (resolved.type === "primitiveType")
    return resolved.value === "null" || resolved.value === "any";
  if (resolved.type === "unionType")
    return resolved.types.some((t) => isOptionalType(t, typeAliases));
  return false;
}

export function isAssignable(
  source: VariableType | "any",
  target: VariableType | "any",
  typeAliases: Record<string, TypeAliasEntry>,
): boolean {
  return isAssignableGuarded(source, target, typeAliases, new Set());
}

/**
 * Coinductive entry point (issue #470). Cycles can only re-enter through a
 * NAMED reference (typeAliasVariable / genericType) — internal recursive
 * calls otherwise pass structurally smaller resolved nodes — so the pair
 * key is only computed when a named node is involved (perf: typeKey stays
 * off the hot path for plain structural comparisons). Re-encountering an
 * in-flight pair means we are inside the very comparison that would prove
 * or refute it — assume it holds, exactly like resolveTypeWithGuard's
 * inProgress set and TypeScript's relation stack. Entries are REMOVED on
 * exit (try/finally): only genuine in-flight cycles short-circuit; sibling
 * repeats recompute real results.
 */
function isAssignableGuarded(
  source: VariableType | "any",
  target: VariableType | "any",
  typeAliases: Record<string, TypeAliasEntry>,
  inProgress: Set<string>,
): boolean {
  if (source === "any" || target === "any") return true;

  const named =
    source.type === "typeAliasVariable" ||
    source.type === "genericType" ||
    target.type === "typeAliasVariable" ||
    target.type === "genericType";
  if (!named) {
    return isAssignableInner(source, target, typeAliases, inProgress);
  }
  const pair = `${typeKey(source, typeAliases)}~>${typeKey(target, typeAliases)}`;
  if (inProgress.has(pair)) return true;
  inProgress.add(pair);
  try {
    return isAssignableInner(source, target, typeAliases, inProgress);
  } finally {
    inProgress.delete(pair);
  }
}

// eslint-disable-next-line max-lines-per-function -- large switch over type kinds; refactor tracked separately
function isAssignableInner(
  source: VariableType,
  target: VariableType,
  typeAliases: Record<string, TypeAliasEntry>,
  inProgress: Set<string>,
): boolean {
  const resolvedSource = safeResolveType(source, typeAliases);
  const resolvedTarget = safeResolveType(target, typeAliases);

  // Two unresolved type alias references with the same name are
  // treated as equal. `resolveType` leaves unknown aliases as
  // `typeAliasVariable` nodes (rather than throwing or falling back
  // to `any`); without this rule, `f(x: Foo): void` and a caller
  // passing a `Foo`-typed value would both resolve to the same
  // unresolved alias yet fail assignability with the confusing
  // message "Foo is not assignable to Foo". The real diagnostic
  // ("type alias not defined") is emitted by validateTypeReferences.
  if (
    resolvedSource.type === "typeAliasVariable" &&
    resolvedTarget.type === "typeAliasVariable" &&
    resolvedSource.aliasName === resolvedTarget.aliasName &&
    !typeAliases[resolvedSource.aliasName]
  ) {
    return true;
  }

  // primitiveType("any") behaves the same as the "any" sentinel
  if (
    (resolvedSource.type === "primitiveType" && resolvedSource.value === "any") ||
    (resolvedTarget.type === "primitiveType" && resolvedTarget.value === "any")
  ) {
    return true;
  }

  // never is the bottom type: assignable to every type. The converse — what is
  // assignable TO never — is only never itself (falls out of the same-kind
  // primitive equality check below, since never's value equals only never's)
  // and `any` (the universal `any` rule above already accepts any -> anything).
  if (resolvedSource.type === "primitiveType" && resolvedSource.value === "never") {
    return true;
  }

  // unknown as target: anything can be assigned to unknown
  if (resolvedTarget.type === "primitiveType" && resolvedTarget.value === "unknown") {
    return true;
  }

  // unknown as source: only assignable to any (handled above) or unknown
  if (resolvedSource.type === "primitiveType" && resolvedSource.value === "unknown") {
    return false;
  }

  // Union type as source: every member must be assignable to target
  if (resolvedSource.type === "unionType") {
    return resolvedSource.types.every((t) =>
      isAssignableGuarded(t, resolvedTarget, typeAliases, inProgress),
    );
  }

  // Union type as target: source must be assignable to at least one member
  if (resolvedTarget.type === "unionType") {
    return resolvedTarget.types.some((t) =>
      isAssignableGuarded(resolvedSource, t, typeAliases, inProgress),
    );
  }

  // Literal types assignable to their base primitives
  if (resolvedTarget.type === "primitiveType") {
    if (
      resolvedSource.type === "stringLiteralType" &&
      resolvedTarget.value === "string"
    )
      return true;
    if (
      resolvedSource.type === "numberLiteralType" &&
      resolvedTarget.value === "number"
    )
      return true;
    if (
      resolvedSource.type === "booleanLiteralType" &&
      resolvedTarget.value === "boolean"
    )
      return true;
  }

  // ObjectType assignable to object primitive (but not the reverse)
  if (
    resolvedSource.type === "objectType" &&
    resolvedTarget.type === "primitiveType" &&
    resolvedTarget.value === "object"
  ) {
    return true;
  }

  // The `object` primitive is assignable to the empty objectType `{}`. The
  // empty target imposes no structural requirements, so any object value
  // trivially satisfies it. This mirrors TypeScript, where `object` is a
  // subtype of `{}`.
  //
  // Example:
  //   let policy: object = someApiCall();
  //   let bag: {} = policy;            // OK: {} requires no properties
  //
  // The reverse and the non-empty cases (e.g., `object` -> `{ foo: string }`)
  // remain unsafe and are correctly rejected: an arbitrary object isn't
  // guaranteed to have specific properties.
  if (
    resolvedSource.type === "primitiveType" &&
    resolvedSource.value === "object" &&
    resolvedTarget.type === "objectType" &&
    resolvedTarget.properties.length === 0
  ) {
    return true;
  }

  // Same kind matching
  if (
    resolvedSource.type === "primitiveType" &&
    resolvedTarget.type === "primitiveType"
  ) {
    return resolvedSource.value === resolvedTarget.value;
  }

  if (
    resolvedSource.type === "stringLiteralType" &&
    resolvedTarget.type === "stringLiteralType"
  ) {
    return resolvedSource.value === resolvedTarget.value;
  }

  if (
    resolvedSource.type === "numberLiteralType" &&
    resolvedTarget.type === "numberLiteralType"
  ) {
    return resolvedSource.value === resolvedTarget.value;
  }

  if (
    resolvedSource.type === "booleanLiteralType" &&
    resolvedTarget.type === "booleanLiteralType"
  ) {
    return resolvedSource.value === resolvedTarget.value;
  }

  if (
    resolvedSource.type === "arrayType" &&
    resolvedTarget.type === "arrayType"
  ) {
    return isAssignableGuarded(
      resolvedSource.elementType,
      resolvedTarget.elementType,
      typeAliases, inProgress);
  }

  // Block types: contravariant in parameters, covariant in return — standard
  // function compatibility. Arity must match exactly (no auto-extension).
  if (
    resolvedSource.type === "blockType" &&
    resolvedTarget.type === "blockType"
  ) {
    if (resolvedSource.params.length !== resolvedTarget.params.length)
      return false;
    for (let i = 0; i < resolvedSource.params.length; i++) {
      if (
        !isAssignableGuarded(
          resolvedTarget.params[i].typeAnnotation,
          resolvedSource.params[i].typeAnnotation,
          typeAliases, inProgress)
      )
        return false;
    }
    return isAssignableGuarded(
      resolvedSource.returnType,
      resolvedTarget.returnType,
      typeAliases, inProgress);
  }

  // Result<T, E>: covariant in both type parameters.
  if (
    resolvedSource.type === "resultType" &&
    resolvedTarget.type === "resultType"
  ) {
    return (
      isAssignableGuarded(resolvedSource.successType, resolvedTarget.successType, typeAliases, inProgress) &&
      isAssignableGuarded(resolvedSource.failureType, resolvedTarget.failureType, typeAliases, inProgress)
    );
  }

  // A narrowed Result *member* (object form, produced by viewing Result as a
  // discriminated union via resultToObjectUnion) is assignable back to the
  // Result type it came from — e.g. `return parsed` where `parsed` was narrowed
  // to `{ success: true, value: T }` by an `isFailure` early-return guard. The
  // flow checker (PR 2) surfaces this on returns/args/assignments. Expand the
  // target Result to its object union and check structurally. Only when the
  // source is NOT itself a Result (that case is handled covariantly above).
  if (resolvedTarget.type === "resultType" && resolvedSource.type !== "resultType") {
    return isAssignableGuarded(
      resolvedSource,
      resultToObjectUnion(resolvedTarget, typeAliases),
      typeAliases, inProgress);
  }

  // Schema<T>: covariant in the validated type. There's no parser surface
  // for `Schema<T>` annotations yet — this rule lets a synthed schema flow
  // through `let` bindings whose RHS is `schema(T)` without false positives.
  if (
    resolvedSource.type === "schemaType" &&
    resolvedTarget.type === "schemaType"
  ) {
    return isAssignableGuarded(resolvedSource.inner, resolvedTarget.inner, typeAliases, inProgress);
  }

  // Record<K, V> -> Record<K, V>: covariant in both K and V.
  // Deliberately unsound for mutable records (writes through the wider type
  // could break the narrower one) — we accept this for ergonomics, so users
  // can pass Record<string, "approve"> where Record<string, string> is expected.
  if (isRecord(resolvedSource) && isRecord(resolvedTarget)) {
    return (
      isAssignableGuarded(
        resolvedSource.typeArgs[0],
        resolvedTarget.typeArgs[0],
        typeAliases, inProgress) &&
      isAssignableGuarded(
        resolvedSource.typeArgs[1],
        resolvedTarget.typeArgs[1],
        typeAliases, inProgress)
    );
  }

  // objectType -> Record<K, V>: structural. Every source property value
  // must be assignable to V. If K is a literal-key union, all listed keys
  // must be present.
  if (resolvedSource.type === "objectType" && isRecord(resolvedTarget)) {
    const [keyType, valueType] = resolvedTarget.typeArgs;
    if (resolvedSource.properties.length === 0) return true;
    const requiredKeys = collectLiteralKeys(keyType);
    if (requiredKeys) {
      const sourceKeys = new Set(resolvedSource.properties.map((p) => p.key));
      for (const k of requiredKeys) if (!sourceKeys.has(k)) return false;
    }
    return resolvedSource.properties.every((p) =>
      isAssignableGuarded(p.value, valueType, typeAliases, inProgress),
    );
  }

  // Record<K, V> -> objectType: only safe when target is the empty object,
  // since arbitrary record contents can't guarantee specific properties.
  if (isRecord(resolvedSource) && resolvedTarget.type === "objectType") {
    return resolvedTarget.properties.length === 0;
  }

  if (
    resolvedSource.type === "objectType" &&
    resolvedTarget.type === "objectType"
  ) {
    // Structural: source must have all properties of target with compatible
    // types. A target property whose type permits `undefined` (the desugaring
    // of `key?:`) may be omitted from the source.
    for (const targetProp of resolvedTarget.properties) {
      const sourceProp = resolvedSource.properties.find(
        (p) => p.key === targetProp.key,
      );
      if (!sourceProp) {
        if (isOptionalType(targetProp.value, typeAliases)) continue;
        return false;
      }
      if (!isAssignableGuarded(sourceProp.value, targetProp.value, typeAliases, inProgress))
        return false;
    }
    return true;
  }

  // functionRefType is assignable to the "function" primitive
  if (
    resolvedSource.type === "functionRefType" &&
    resolvedTarget.type === "primitiveType" &&
    resolvedTarget.value === "function"
  ) {
    return true;
  }

  // Two functionRefTypes: compatible if same arity and compatible param/return types
  if (
    resolvedSource.type === "functionRefType" &&
    resolvedTarget.type === "functionRefType"
  ) {
    const sourceVariadic = resolvedSource.params.some((p) => p.variadic);
    const targetVariadic = resolvedTarget.params.some((p) => p.variadic);
    if (sourceVariadic !== targetVariadic) return false;
    const sourceParams = resolvedSource.params.filter((p) => !p.variadic);
    const targetParams = resolvedTarget.params.filter((p) => !p.variadic);
    if (sourceParams.length !== targetParams.length) return false;
    for (let i = 0; i < sourceParams.length; i++) {
      const sourceHint = sourceParams[i].typeHint;
      const targetHint = targetParams[i].typeHint;
      if (!sourceHint || !targetHint) continue;
      if (!isAssignableGuarded(targetHint, sourceHint, typeAliases, inProgress)) return false;
    }
    if (resolvedSource.returnType && resolvedTarget.returnType) {
      return isAssignableGuarded(resolvedSource.returnType, resolvedTarget.returnType, typeAliases, inProgress);
    }
    return true;
  }

  // functionRefType -> blockType: a named `def` reference is compatible
  // with a parameter declared as a lambda type when arities match,
  // parameters are contravariant, and the return type is covariant —
  // the same rules `blockType -> blockType` uses.
  //
  // Without this rule, every call site that passes a `def` to a higher-
  // order built-in like `map(arr, helper)` (where the parameter is
  // typed `(any) => any`) would emit a false-positive warning, even
  // when the helper's signature is structurally compatible.
  if (
    resolvedSource.type === "functionRefType" &&
    resolvedTarget.type === "blockType"
  ) {
    const sourceVariadic = resolvedSource.params.some((p) => p.variadic);
    if (sourceVariadic) return false;
    const sourceParams = resolvedSource.params.filter((p) => !p.variadic);
    if (sourceParams.length !== resolvedTarget.params.length) return false;
    for (let i = 0; i < sourceParams.length; i++) {
      const sourceHint = sourceParams[i].typeHint;
      const targetHint = resolvedTarget.params[i].typeAnnotation;
      if (!sourceHint || !targetHint) continue;
      if (!isAssignableGuarded(targetHint, sourceHint, typeAliases, inProgress)) return false;
    }
    if (resolvedSource.returnType && resolvedTarget.returnType) {
      return isAssignableGuarded(
        resolvedSource.returnType,
        resolvedTarget.returnType,
        typeAliases, inProgress);
    }
    return true;
  }

  return false;
}
