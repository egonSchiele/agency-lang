import type { VariableType } from "../types.js";
import type { TypeAliasEntry } from "../types/typeHints.js";

export type ResolvedEffectSet = {
  /** True if this set is `<*>` / the `any` primitive — no upper bound. */
  any: boolean;
  /** Deduped effect labels, in first-seen order. */
  labels: string[];
  /** Names of references that resolved to a KNOWN type alias that is NOT an
   *  effect set (e.g. `raises Color` where `Color` is a string union). These
   *  are errors. An unknown bare name is NOT here — it is a literal effect. */
  nonEffectSetRefs: string[];
};

/**
 * Resolve an effect-set type (a flagged UnionType, the `any` primitive, or
 * a TypeAliasVariable) to its concrete set of effect labels. Disambiguation
 * for a TypeAliasVariable (effects need not be namespaced):
 *   - resolves to a KNOWN effect set (isEffectSet)  → spread its members;
 *   - resolves to a KNOWN non-effect-set alias       → record in
 *     `nonEffectSetRefs` (an error);
 *   - does NOT resolve to any alias                   → treat the bare name
 *     as a literal effect label.
 *
 * Cycles are guarded with a `seen` set so a self-referential alias can't
 * loop forever.
 */
export function resolveEffectSet(
  type: VariableType | undefined,
  aliases: Record<string, TypeAliasEntry>,
): ResolvedEffectSet {
  const labels: string[] = [];
  const nonEffectSetRefs: string[] = [];
  const seen: string[] = [];
  let any = false;

  const addLabel = (label: string) => {
    if (!labels.includes(label)) labels.push(label);
  };

  const isEffectSetEntry = (entry: TypeAliasEntry): boolean =>
    entry.isEffectSet === true ||
    (entry.body?.type === "unionType" && entry.body.isEffectSet === true);

  const walk = (t: VariableType | undefined): void => {
    if (!t) return;
    if (t.type === "primitiveType" && t.value === "any") {
      any = true;
      return;
    }
    if (t.type === "stringLiteralType") {
      addLabel(t.value);
      return;
    }
    if (t.type === "unionType") {
      for (const member of t.types) walk(member);
      return;
    }
    if (t.type === "typeAliasVariable") {
      const name = t.aliasName;
      if (seen.includes(name)) return; // cycle guard
      const entry = aliases[name];
      if (!entry) {
        // Bare name that isn't a declared alias → a literal effect label.
        addLabel(name);
        return;
      }
      if (!isEffectSetEntry(entry)) {
        if (!nonEffectSetRefs.includes(name)) nonEffectSetRefs.push(name);
        return;
      }
      seen.push(name);
      walk(entry.body);
      return;
    }
    // Any other shape is not a valid effect-set member; ignore.
  };

  walk(type);
  return { any, labels, nonEffectSetRefs };
}
