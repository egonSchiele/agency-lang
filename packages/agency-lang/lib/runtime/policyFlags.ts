import type { Policy, PolicyRule } from "./policy.js";

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
export function policyOverlayFromFlags(
  approve: string | undefined,
  reject: string | undefined,
  base: Policy,
): Policy {
  const approved = splitEffects(approve);
  const rejected = splitEffects(reject);
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
