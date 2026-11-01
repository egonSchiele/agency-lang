import { BUILTIN_EFFECT_SETS } from "./effectSets.data.js";

/** One built-in effect set from `stdlib/effectSets.agency`. */
export type EffectSetInfo = {
  name: string;
  /** The declaration's doc comment, whitespace-trimmed. */
  doc: string;
  /** Effect names only; nested sets resolved to their members. */
  members: string[];
  /** The other sets this one was declared from, e.g. FileSystem's
   *  ["FileRead", "FileWrite"]. Empty for a set declared from effects. */
  composedOf: string[];
};

/**
 * The built-in effect sets, keyed by name (null-prototype record —
 * callers look up CLI-supplied names). They come from
 * `effectSets.data.ts`, which `scripts/generate-effect-sets.mjs` writes
 * from `stdlib/effectSets.agency` during `make`, so nothing is read from
 * disk at run time. The doc comments live only in the source, so the
 * source stays the single definition; the test in effectSets.test.ts
 * fails when the data file is stale.
 */
export function builtinEffectSets(): Record<string, EffectSetInfo> {
  const sets: Record<string, EffectSetInfo> = Object.create(null);
  for (const [name, info] of Object.entries(BUILTIN_EFFECT_SETS)) {
    sets[name] = info;
  }
  return sets;
}

/** Each name as the effects it stands for: a built-in set's members, or
 *  the name itself. This is Agency's rule for a bare name in `raises`, and
 *  the one the `--approve` and `--reject` flags use. A name with `::` is
 *  always a plain effect. */
export function expandEffectNames(names: string[]): string[] {
  const sets = builtinEffectSets();
  return names.flatMap((name) => {
    const set = name.includes("::") ? undefined : sets[name];
    return set === undefined ? [name] : set.members;
  });
}
