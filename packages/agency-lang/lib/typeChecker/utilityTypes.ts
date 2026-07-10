import type { VariableType } from "../types.js";
import type { ObjectType } from "../types/typeHints.js";
import { formatTypeHint } from "../utils/formatType.js";
import { NEVER_T, NULL_T } from "./primitives.js";

/**
 * Built-in utility types (Partial, Required, Pick, Omit, NonNullable),
 * modeled on TypeScript and adapted to Agency null-based optionality
 * (`p?: V` desugars to `p: V | null` at parse time; there is no undefined).
 *
 * All transforms are EAGER: `evalUtilityType` runs during type resolution
 * (`resolveTypeWithGuard` in assignability.ts) and returns a plain
 * objectType / union, so nothing downstream (assignability, narrowing,
 * codegen) knows these types exist. See
 * docs/superpowers/specs/2026-07-09-utility-types-design.md.
 *
 * CYCLE RULE: this module must not import assignability.ts — the resolver
 * is injected as the `resolve` callback so alias arguments resolve with the
 * caller's in-progress guard (recursion degrades gracefully, see #470).
 */
type Resolve = (t: VariableType) => VariableType;

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

function resolveObjectArg(
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
function resolveKeysArg(
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

/**
 * The single source of truth: name -> arity + transform. Adding a utility
 * type is one entry here; UTILITY_TYPE_ARITY (consumed by validate.ts and
 * RESERVED_TYPE_NAMES in index.ts) is derived from it.
 */
const UTILITY_TYPES: Record<
  string,
  { arity: number; apply: (typeArgs: VariableType[], resolve: Resolve) => VariableType }
> = {
  Partial: {
    arity: 1,
    apply: ([target], resolve) => {
      const obj = resolveObjectArg("Partial", target, resolve);
      return {
        ...obj,
        properties: obj.properties.map((p) =>
          // Resolve only to DECIDE nullability; keep the written value in the
          // output so alias references survive into codegen/doc output.
          includesNull(resolve(p.value)) ? p : { ...p, value: addNull(p.value) },
        ),
      };
    },
  },
  Required: {
    arity: 1,
    apply: ([target], resolve) => {
      const obj = resolveObjectArg("Required", target, resolve);
      return {
        ...obj,
        // Must resolve to rewrite: an alias to `string | null` has to strip.
        // This inlines aliased property types; acceptable, spec-noted.
        properties: obj.properties.map((p) => ({
          ...p,
          value: stripNull(resolve(p.value)),
        })),
      };
    },
  },
  Pick: {
    arity: 2,
    apply: ([target, keyArg], resolve) => {
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
      return {
        ...obj,
        properties: obj.properties.filter((p) => keys.includes(p.key)),
      };
    },
  },
  Omit: {
    arity: 2,
    apply: ([target, keyArg], resolve) => {
      const obj = resolveObjectArg("Omit", target, resolve);
      const keys = resolveKeysArg("Omit", keyArg, resolve);
      return {
        ...obj,
        properties: obj.properties.filter((p) => !keys.includes(p.key)),
      };
    },
  },
  NonNullable: {
    arity: 1,
    apply: ([target], resolve) => stripNull(resolve(target)),
  },
};

/** Derived view for validate.ts (BUILTIN_GENERIC_ARITY) and index.ts. */
export const UTILITY_TYPE_ARITY: Record<string, number> = Object.fromEntries(
  Object.entries(UTILITY_TYPES).map(([name, entry]) => [name, entry.arity]),
);

export function isUtilityTypeName(name: string): boolean {
  return name in UTILITY_TYPES;
}

/**
 * Evaluate one utility-type application. Throws TypeError on invalid
 * input. VERIFIED surfacing (same as Record key errors today): at typecheck
 * time safeResolveType SWALLOWS the throw and the annotation degrades to
 * `any` with no diagnostic; the error becomes fatal at codegen when
 * resolveTypeDeep re-runs the resolver unwrapped. A pipeline test pins
 * this; located diagnostics are a spec follow-up. Arity is ALSO validated
 * as a located diagnostic via BUILTIN_GENERIC_ARITY (validate.ts); the
 * throw here is the resolver-level backstop.
 */
export function evalUtilityType(
  name: string,
  typeArgs: VariableType[],
  resolve: Resolve,
): VariableType {
  const entry = UTILITY_TYPES[name];
  if (!entry) {
    throw new TypeError(`Unknown utility type ${name}`);
  }
  if (typeArgs.length !== entry.arity) {
    throw new TypeError(
      `${name} expects ${entry.arity} type argument${entry.arity === 1 ? "" : "s"}, got ${typeArgs.length}`,
    );
  }
  return entry.apply(typeArgs, resolve);
}
