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

// A rule with no `match` matches every interrupt of its effect.
function isCatchAll(rule: PolicyRule): boolean {
  return rule.match === undefined || Object.keys(rule.match).length === 0;
}

// The first matching rule wins, so a rule with no `match` decides every
// interrupt of its effect and anything listed after it is never reached.
function decidesEverything(rules: PolicyRule[]): boolean {
  return rules.some(isCatchAll);
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

// Where a new approve rule goes in an effect's list: just after the last
// reject rule that can still decide something. A catch-all that is not a
// reject decides every interrupt, so a reject after it never decides, and
// a new rule placed after it would never decide either.
function insertionIndex(rules: PolicyRule[]): number {
  const blocker = rules.findIndex((one) => isCatchAll(one) && one.action !== "reject");
  const reachable = blocker === -1 ? rules : rules.slice(0, blocker);
  return reachable.findLastIndex((one) => one.action === "reject") + 1;
}

/**
 * `policy` with the approve rule `rule` added under each of `effects`.
 * The first match wins, and the rule goes where every reject still
 * decides ahead of it while it decides ahead of the approve and propagate
 * rules already there. So a rule that approves a parent folder never
 * overturns a rule that rejects a folder inside it:
 *
 * - Under the effect, it goes just after the last reject rule, and ahead
 *   of any catch-all approve or propagate rule, which would hide it.
 * - The scoped reject rules under `"*"` are copied in ahead of it. The
 *   matcher tries an effect's own rules before `"*"`, so without the copy
 *   a `"*"` reject for `/p/secrets` would lose to an approve for `/p`.
 *   The copies also decide ahead of the rules after them, which can only
 *   turn an approval into a rejection. A `"*"` catch-all reject is not
 *   copied: it would hide every rule after it.
 *
 * A scoped propagate rule ahead of a reject is left where it is, so a new
 * rule behind it does not decide what it covers, and that interrupt still
 * asks. An effect that already has the same rule is left as it is, so one
 * answer given twice saves one rule.
 */
export function insertApproveRule(policy: Policy, effects: string[], rule: PolicyRule): Policy {
  const wildcardRejects = (policy["*"] ?? []).filter(
    (one) => one.action === "reject" && !isCatchAll(one),
  );
  const next: Policy = { ...policy };
  for (const effect of effects) {
    const existing = policy[effect] ?? [];
    if (existing.some((one) => sameRule(one, rule))) {
      continue;
    }
    const at = insertionIndex(existing);
    const copied = wildcardRejects.filter(
      (reject) => !existing.some((one) => sameRule(one, reject)),
    );
    next[effect] = [...existing.slice(0, at), ...copied, rule, ...existing.slice(at)];
  }
  return next;
}
