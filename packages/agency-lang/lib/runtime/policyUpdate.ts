import type { Policy, PolicyRule } from "./policy.js";

// A saved policy file is a copy of a built-in policy from the day it was
// created, plus the user's own "always" answers. Rules added to the
// built-in later never reach it. The agent's /policy command uses these
// two functions to show the difference and apply it.

function sameMatch(a: PolicyRule["match"], b: PolicyRule["match"]): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function sameRule(a: PolicyRule, b: PolicyRule): boolean {
  return (
    a.action === b.action &&
    a.rejectMessage === b.rejectMessage &&
    (a.matchDotFolders === true) === (b.matchDotFolders === true) &&
    sameMatch(a.match, b.match)
  );
}

// The first matching rule wins, so a rule with no `match` decides every
// interrupt of its effect and anything listed after it is never reached.
function decidesEverything(rules: PolicyRule[]): boolean {
  return rules.some((rule) => rule.match === undefined || Object.keys(rule.match).length === 0);
}

/** The rules `base` has and `saved` lacks, keyed by effect. An effect the
 *  saved policy already decides outright is left out: a rule added after
 *  its catch-all could never match.
 *
 *  A saved `"*"` rule with no `match` decides every interrupt the
 *  effect's own rules do not. An effect-specific rule is checked before
 *  the wildcard, so adding one would overturn the wildcard's decision.
 *  Such a policy is missing nothing. */
export function missingPolicyRules(saved: Policy, base: Policy): Policy {
  if (decidesEverything(saved["*"] ?? [])) return {};
  const missing: Policy = {};
  for (const effect of Object.keys(base)) {
    const have = saved[effect] ?? [];
    if (decidesEverything(have)) continue;
    const lacking = base[effect].filter((rule) => !have.some((mine) => sameRule(mine, rule)));
    if (lacking.length > 0) missing[effect] = lacking;
  }
  return missing;
}

/** `saved` with `additions` appended per effect. Appended, never put in
 *  front: the first match wins, so every rule the user already has,
 *  a reject included, keeps deciding what it decided before. */
export function appendPolicyRules(saved: Policy, additions: Policy): Policy {
  const merged: Policy = { ...saved };
  for (const effect of Object.keys(additions)) {
    merged[effect] = [...(saved[effect] ?? []), ...additions[effect]];
  }
  return merged;
}

/** `policy` with the approve rule `rule` added under each of `effects`,
 *  just after that effect's last reject rule, or first when it has none.
 *  The first match wins, so the new rule decides ahead of the approve and
 *  propagate rules already there, and every reject rule still decides
 *  ahead of it. A rule that approves a parent folder then never overturns
 *  a rule that rejects a folder inside it. An effect that already has the
 *  same rule is left as it is, so one answer given twice saves one rule. */
export function insertApproveRule(policy: Policy, effects: string[], rule: PolicyRule): Policy {
  const next: Policy = { ...policy };
  for (const effect of effects) {
    const existing = policy[effect] ?? [];
    if (existing.some((one) => sameRule(one, rule))) {
      continue;
    }
    const at = existing.findLastIndex((one) => one.action === "reject") + 1;
    next[effect] = [...existing.slice(0, at), rule, ...existing.slice(at)];
  }
  return next;
}
