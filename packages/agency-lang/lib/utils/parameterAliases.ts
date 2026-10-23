/**
 * Parameter aliases: `def fetch(baseUrl | url: string)`.
 *
 * An alias is a misspelling the tool forgives. It is not a second name
 * for the parameter. This module is the one place that answers "which
 * parameter does this key name, and did it get there through an alias?".
 * The type checker, the synthesizer, and the runtime all call it, so the
 * answer cannot drift between them. Spec:
 * `docs/superpowers/specs/2026-10-23-parameter-aliases.md`.
 *
 * The functions here are pure and never throw. `resolveNamed` in
 * `lib/runtime/agencyFunction.ts` is the only place that decides what a
 * correction or a conflict means for a given caller.
 */

/** The shape both the static `FunctionParameter` and the runtime
 *  `FuncParam` share, which is all this module needs. */
export type NamedParameter = { name: string; aliases?: string[] };

export type ParameterMatch = { param: NamedParameter; viaAlias: boolean };

/** One key renamed to its canonical name. */
export type AliasCorrection = { from: string; to: string };

export type CanonicalKeysResult = {
  /** The arguments with alias keys renamed. On a conflict, the arguments
   *  exactly as given. */
  args: Record<string, unknown>;
  corrections: AliasCorrection[];
  /** The conflict sentence when two keys name one parameter, else null. */
  conflict: string | null;
};

/** The parameter a caller's key names: the canonical name wins, then an
 *  alias. Null when the key names nothing. */
export function parameterForKey(
  params: readonly NamedParameter[],
  key: string,
): ParameterMatch | null {
  const canonical = params.find((param) => param.name === key);
  if (canonical) {
    return { param: canonical, viaAlias: false };
  }
  const aliased = params.find((param) => (param.aliases ?? []).includes(key));
  if (aliased) {
    return { param: aliased, viaAlias: true };
  }
  return null;
}

/** The one sentence every layer uses when Agency code writes an alias. */
export function aliasHint(key: string, canonical: string): string {
  return `'${key}' is an alias of '${canonical}'; use '${canonical}'.`;
}

/** The conflict sentence when two keys land on one parameter. The keys
 *  are named in the order the caller wrote them. */
export function aliasConflictMessage(first: string, second: string, canonical: string): string {
  return `Both '${first}' and '${second}' were given for parameter '${canonical}'. Pass one.`;
}

/**
 * Rename every alias key in `args` to its canonical name.
 *
 * Keys that name nothing pass through untouched, so a true typo still
 * reaches the caller's own unknown-argument error. An alias key whose
 * value is null counts as absent: it is dropped, not renamed, and never
 * conflicts, because a model sends null for a parameter it means to leave
 * out. The function is idempotent: canonical input comes back equal with
 * no corrections.
 */
export function canonicalKeys(
  args: Record<string, unknown>,
  params: readonly NamedParameter[],
): CanonicalKeysResult {
  const renamed: Record<string, unknown> = {};
  const corrections: AliasCorrection[] = [];
  const keyThatFilled: Record<string, string> = {};
  for (const key of Object.keys(args)) {
    const match = parameterForKey(params, key);
    if (match?.viaAlias && args[key] === null) {
      continue;
    }
    const target = match?.viaAlias ? match.param.name : key;
    if (Object.hasOwn(keyThatFilled, target)) {
      return {
        args: { ...args },
        corrections: [],
        conflict: aliasConflictMessage(keyThatFilled[target], key, target),
      };
    }
    keyThatFilled[target] = key;
    renamed[target] = args[key];
    if (match?.viaAlias) {
      corrections.push({ from: key, to: target });
    }
  }
  return { args: renamed, corrections, conflict: null };
}
