import type { Policy, PolicyRule } from "./policy.js";

// A saved policy file is a copy of a built-in policy taken on the day it
// was created, plus the user's own "always" answers. Rules added to the
// built-in later never reach it. These two functions are what the agent's
// /policy command shows and applies; nothing here runs on its own.

function sameMatch(a: PolicyRule["match"], b: PolicyRule["match"]): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function sameRule(a: PolicyRule, b: PolicyRule): boolean {
  return (
    a.action === b.action && a.rejectMessage === b.rejectMessage && sameMatch(a.match, b.match)
  );
}

// The first matching rule wins, so a rule with no `match` decides every
// interrupt of its effect and anything listed after it is never reached.
function decidesEverything(rules: PolicyRule[]): boolean {
  return rules.some((rule) => rule.match === undefined || Object.keys(rule.match).length === 0);
}

/** The rules `base` has and `saved` lacks, keyed by effect. An effect the
 *  saved policy already decides outright is left out: a rule added after
 *  its catch-all could never match. */
export function missingPolicyRules(saved: Policy, base: Policy): Policy {
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
