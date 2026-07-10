import type { Tag, VariableType } from "../types.js";
import type { ObjectType } from "../types/typeHints.js";
import { formatTypeHint } from "../utils/formatType.js";
import { mergeTagSets } from "./mergeTags.js";
import { NEVER_T, NULL_T } from "./primitives.js";

/**
 * The registry of ALL built-in generic types — the container forms
 * (`Array`, `Schema`, `Record`) and the utility types (`Partial`,
 * `Required`, `Pick`, `Omit`, `NonNullable`, modeled on TypeScript and
 * adapted to Agency null-based optionality: `p?: V` desugars to
 * `p: V | null` at parse time; there is no undefined).
 *
 * Every form is evaluated EAGERLY: `evalBuiltinGeneric` runs during type
 * resolution (`resolveTypeWithGuard` in assignability.ts) and returns a
 * plain type — except `Record`, which keeps its `genericType` wrapper so
 * codegen can lower it to `z.record(...)`. Nothing downstream knows the
 * other forms exist. See
 * docs/superpowers/specs/2026-07-09-utility-types-design.md.
 *
 * Adding a built-in generic is one entry here: `BUILTIN_GENERIC_ARITY`
 * (consumed by validate.ts) and `RESERVED_GENERIC_NAMES` (consumed by
 * index.ts) are derived from the table.
 *
 * `reserved` controls whether users may declare a type alias with the
 * name. The five utility types are reserved (a user alias is a hard
 * error); `Array`/`Schema`/`Record` keep their historical behavior — a
 * user alias with those names is silently shadowed by the builtin, not
 * rejected. Flipping them to reserved would be a breaking change beyond
 * this feature.
 *
 * CYCLE RULE: this module must not import assignability.ts — the resolver
 * is injected as the `resolve` callback so alias arguments resolve with the
 * caller's in-progress guard (recursion degrades gracefully, see #470).
 */
type Resolve = (t: VariableType) => VariableType;

type BuiltinGeneric = {
  arity: number;
  /** Users may not declare a type alias with this name. */
  reserved?: boolean;
  apply: (
    typeArgs: VariableType[],
    resolve: Resolve,
    useSiteTags: Tag[] | undefined,
  ) => VariableType;
};

function isNullType(t: VariableType): boolean {
  return t.type === "primitiveType" && t.value === "null";
}

function includesNull(t: VariableType): boolean {
  if (isNullType(t)) return true;
  return t.type === "unionType" && t.types.some(isNullType);
}

/** V -> V | null. Caller has already checked `includesNull`. */
function addNull(t: VariableType): VariableType {
  if (t.type === "unionType") return { ...t, types: [...t.types, NULL_T] };
  return { type: "unionType", types: [t, NULL_T] };
}

/**
 * Strip null members; a type that is ONLY null becomes never.
 *
 * NEAR-DUPLICATE of the private `stripNullable` in synthesizer.ts — kept
 * separate ON PURPOSE: that copy serves value-level narrowing (returns
 * `undefined` for the empty case and also strips `undefined`); this one is
 * type-level and must produce `never`. Do not deduplicate them.
 */
function stripNull(t: VariableType): VariableType {
  if (isNullType(t)) return NEVER_T;
  if (t.type !== "unionType") return t;
  const kept = t.types.filter((m) => !isNullType(m));
  if (kept.length === 0) return NEVER_T;
  if (kept.length === 1) return kept[0];
  return { ...t, types: kept };
}

/**
 * Merge the use-site tags of a `Partial<...>` / `Pick<...>` occurrence onto
 * a transform's result. The result's own tags came from resolving the
 * ARGUMENT (alias-side per the `mergeTagSets` contract); the occurrence's
 * tags are the use-site layer and override on `@jsonSchema` key conflicts.
 */
export function withUseSiteTags(
  t: VariableType,
  useSiteTags: Tag[] | undefined,
): VariableType {
  const merged = mergeTagSets(t.tags, useSiteTags);
  if (!merged) return t;
  return { ...t, tags: merged } as VariableType;
}

function isValidRecordKey(t: VariableType): boolean {
  if (t.type === "primitiveType")
    return t.value === "string" || t.value === "number";
  if (t.type === "stringLiteralType" || t.type === "numberLiteralType")
    return true;
  if (t.type === "unionType") return t.types.every(isValidRecordKey);
  return false;
}

export function resolveObjectArg(
  name: string,
  arg: VariableType,
  resolve: Resolve,
): ObjectType {
  const resolved = resolve(arg);
  if (resolved.type !== "objectType") {
    throw new TypeError(
      `${name} expects an object type, got '${formatTypeHint(resolved)}'`,
    );
  }
  return resolved;
}

/** K must resolve to a string literal or a union of string literals. */
export function resolveKeysArg(
  name: string,
  arg: VariableType,
  resolve: Resolve,
): string[] {
  const resolved = resolve(arg);
  const members = resolved.type === "unionType" ? resolved.types : [resolved];
  return members.map((member) => {
    const resolvedMember = resolve(member);
    if (resolvedMember.type !== "stringLiteralType") {
      throw new TypeError(
        `${name} expects string literal keys, got '${formatTypeHint(resolved)}'`,
      );
    }
    return resolvedMember.value;
  });
}

const BUILTIN_GENERICS: Record<string, BuiltinGeneric> = {
  // Container forms. Array/Schema lower to their dedicated type nodes and
  // (historical behavior, preserved) DROP use-site tags; Record keeps its
  // genericType wrapper so codegen can emit z.record, and keeps use-site
  // tags verbatim on that wrapper.
  Array: {
    arity: 1,
    apply: ([element], resolve) => ({
      type: "arrayType",
      elementType: resolve(element),
    }),
  },
  Schema: {
    arity: 1,
    apply: ([inner], resolve) => ({
      type: "schemaType",
      inner: resolve(inner),
    }),
  },
  Record: {
    arity: 2,
    apply: ([keyArg, valueArg], resolve, useSiteTags) => {
      const key = resolve(keyArg);
      if (!isValidRecordKey(key)) {
        throw new TypeError(
          `Record key type must be string, number, a string literal, a number literal, or a union of those`,
        );
      }
      const node: VariableType = {
        type: "genericType",
        name: "Record",
        typeArgs: [key, resolve(valueArg)],
      };
      if (useSiteTags) {
        node.tags = useSiteTags;
      }
      return node;
    },
  },

  // Utility types: eager transforms producing plain object/union types.
  Partial: {
    arity: 1,
    reserved: true,
    apply: ([target], resolve, useSiteTags) => {
      const obj = resolveObjectArg("Partial", target, resolve);
      return withUseSiteTags(
        {
          ...obj,
          properties: obj.properties.map((p) =>
            // Resolve only to DECIDE nullability; keep the written value in
            // the output so alias references survive into codegen/doc output.
            includesNull(resolve(p.value)) ? p : { ...p, value: addNull(p.value) },
          ),
        },
        useSiteTags,
      );
    },
  },
  Required: {
    arity: 1,
    reserved: true,
    apply: ([target], resolve, useSiteTags) => {
      const obj = resolveObjectArg("Required", target, resolve);
      return withUseSiteTags(
        {
          ...obj,
          // Must resolve to rewrite: an alias to `string | null` has to
          // strip. This inlines aliased property types; acceptable,
          // spec-noted.
          properties: obj.properties.map((p) => ({
            ...p,
            value: stripNull(resolve(p.value)),
          })),
        },
        useSiteTags,
      );
    },
  },
  Pick: {
    arity: 2,
    reserved: true,
    apply: ([target, keyArg], resolve, useSiteTags) => {
      const obj = resolveObjectArg("Pick", target, resolve);
      const keys = resolveKeysArg("Pick", keyArg, resolve);
      const available = obj.properties.map((p) => p.key);
      for (const key of keys) {
        if (!available.includes(key)) {
          throw new TypeError(
            `Pick key '${key}' does not exist on the target type. Available keys: ${available.join(", ")}`,
          );
        }
      }
      return withUseSiteTags(
        {
          ...obj,
          properties: obj.properties.filter((p) => keys.includes(p.key)),
        },
        useSiteTags,
      );
    },
  },
  Omit: {
    arity: 2,
    reserved: true,
    apply: ([target, keyArg], resolve, useSiteTags) => {
      const obj = resolveObjectArg("Omit", target, resolve);
      const keys = resolveKeysArg("Omit", keyArg, resolve);
      return withUseSiteTags(
        {
          ...obj,
          properties: obj.properties.filter((p) => !keys.includes(p.key)),
        },
        useSiteTags,
      );
    },
  },
  NonNullable: {
    arity: 1,
    reserved: true,
    apply: ([target], resolve, useSiteTags) =>
      withUseSiteTags(stripNull(resolve(target)), useSiteTags),
  },
};

/**
 * Own-property lookup — `name` comes from user source, so prototype-chain
 * keys ("constructor", "toString", ...) must not match. Mirrors the
 * null-prototype/own-property discipline in scope.ts and flow.ts.
 */
function lookupBuiltinGeneric(name: string): BuiltinGeneric | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_GENERICS, name)
    ? BUILTIN_GENERICS[name]
    : undefined;
}

/**
 * Derived view for validate.ts arity diagnostics. Null-prototype so bare
 * indexing with a user-controlled name ("toString", "constructor", ...)
 * misses instead of finding Object.prototype members — validate.ts indexes
 * this table directly.
 */
export const BUILTIN_GENERIC_ARITY: Record<string, number> = Object.assign(
  Object.create(null) as Record<string, number>,
  Object.fromEntries(
    Object.entries(BUILTIN_GENERICS).map(([name, entry]) => [name, entry.arity]),
  ),
);

/** The names users may not declare type aliases for (index.ts). */
export const RESERVED_GENERIC_NAMES: string[] = Object.entries(BUILTIN_GENERICS)
  .filter(([, entry]) => entry.reserved)
  .map(([name]) => name);

export function isBuiltinGenericName(name: string): boolean {
  return lookupBuiltinGeneric(name) !== undefined;
}

/**
 * Evaluate one built-in generic application. Throws TypeError on invalid
 * input. VERIFIED surfacing (same for all forms): at typecheck time
 * safeResolveType SWALLOWS the throw and the annotation degrades to `any`
 * with no diagnostic; the error becomes fatal at codegen when
 * resolveTypeDeep re-runs the resolver unwrapped. A pipeline test pins
 * this; located diagnostics are a spec follow-up. Arity is ALSO validated
 * as a located diagnostic via BUILTIN_GENERIC_ARITY (validate.ts); the
 * throw here is the resolver-level backstop.
 */
export function evalBuiltinGeneric(
  name: string,
  typeArgs: VariableType[],
  resolve: Resolve,
  useSiteTags?: Tag[],
): VariableType {
  const entry = lookupBuiltinGeneric(name);
  if (!entry) {
    throw new TypeError(`Unknown built-in generic type ${name}`);
  }
  if (typeArgs.length !== entry.arity) {
    throw new TypeError(
      `${name} expects ${entry.arity} type argument${entry.arity === 1 ? "" : "s"}, got ${typeArgs.length}`,
    );
  }
  return entry.apply(typeArgs, resolve, useSiteTags);
}
