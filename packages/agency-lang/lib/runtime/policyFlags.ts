import type { Policy, PolicyRule } from "./policy.js";
import { builtinEffectSets } from "./effectSets.js";

/** Split a flag's effect list on commas and/or whitespace, so
 *  `--approve "std::read, std::ls"`, `--approve std::read,std::ls`, and
 *  `--approve "std::read std::ls"` all work. */
export function splitEffects(list: string | undefined): string[] {
  if (!list) {
    return [];
  }
  return list.split(/[\s,]+/).filter((s) => s.length > 0);
}

/** Overlay blanket rules from `--approve` / `--reject` flag values onto a
 *  base policy. Returns a new policy; `base` is not mutated.
 *
 *  Each affected effect's rule list is built in one construction so
 *  precedence is visible in the literal, not implied by statement order:
 *  reject rule, then approve rule, then the base's own rules.
 *  Reject-ahead-of-approve is how overlap resolves to reject under
 *  checkPolicy's first-match-wins — and you cannot break it by reordering
 *  statements.
 *
 *  Shared by `agency run` (via `resolveRunPolicy`) and the agent's flags. */
/** Expand any built-in capability-set names in a flag's effect list to
 *  their member effects. A name with `::` is always a plain effect. A
 *  bare name that matches no set passes through as an effect name — bare
 *  effect declarations are legal, and the bare `interrupt("msg")` form
 *  raises the effect named "unknown", so an unmatched bare name must
 *  keep working; a near-miss of a set name gets a stderr warning. */
function expandSetNames(names: string[], flag: string): string[] {
  if (names.every((name) => name.includes("::"))) {
    return names;
  }
  const sets = builtinEffectSets();
  const expanded: string[] = [];
  for (const name of names) {
    if (name.includes("::")) {
      expanded.push(name);
      continue;
    }
    const set = sets[name];
    if (set !== undefined) {
      expanded.push(...set.members);
      continue;
    }
    const near = nearMissSetName(name, Object.keys(sets));
    if (near !== null) {
      console.error(
        `Warning: "${name}" in ${flag} matches no built-in effect set. Did you mean ${near}? It was kept as a plain effect name.`,
      );
    }
    expanded.push(name);
  }
  return expanded;
}

/** A set name this one probably meant: a case-only mismatch, or one edit
 *  (insert, delete, or replace) away. */
function nearMissSetName(name: string, setNames: string[]): string | null {
  const exact = setNames.find((s) => s.toLowerCase() === name.toLowerCase());
  if (exact !== undefined) {
    return exact;
  }
  return setNames.find((s) => withinOneEdit(name.toLowerCase(), s.toLowerCase())) ?? null;
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) {
    return false;
  }
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  // Skip one edit at the first mismatch; the remainders must match.
  const restA = a.length > b.length ? a.slice(i + 1) : a.slice(a.length === b.length ? i + 1 : i);
  const restB = b.length > a.length ? b.slice(i + 1) : b.slice(a.length === b.length ? i + 1 : i);
  return restA === restB;
}

export function policyOverlayFromFlags(
  approve: string | undefined,
  reject: string | undefined,
  base: Policy,
): Policy {
  const approved = expandSetNames(splitEffects(approve), "--approve");
  const rejected = expandSetNames(splitEffects(reject), "--reject");
  // Null-prototype: effect names come straight from a CLI flag, and on a
  // plain object a name like "toString" would read an inherited function
  // out of `policy[effect]` below, and "__proto__" would be a prototype
  // write instead of a key.
  const policy: Policy = Object.assign(Object.create(null), base);
  const rejectRule: PolicyRule = { action: "reject" };
  const approveRule: PolicyRule = { action: "approve" };
  const affected = [...approved, ...rejected].filter((e, i, a) => a.indexOf(e) === i);
  for (const effect of affected) {
    policy[effect] = [
      ...(rejected.includes(effect) ? [rejectRule] : []),
      ...(approved.includes(effect) ? [approveRule] : []),
      ...(policy[effect] ?? []),
    ];
  }
  return policy;
}
