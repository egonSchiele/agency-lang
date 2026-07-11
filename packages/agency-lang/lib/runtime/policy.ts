import picomatch from "picomatch";
import { z } from "zod";

export const PolicyRuleSchema = z.object({
  match: z.record(z.string(), z.string()).optional(),
  action: z.enum(["approve", "reject", "propagate"]),
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z.record(z.string(), z.array(PolicyRuleSchema));

export type Policy = z.infer<typeof PolicySchema>;

type PolicyResult =
  | { type: "approve" }
  | { type: "reject" }
  | { type: "propagate" };

export function checkPolicy(
  policy: Policy,
  interrupt: { effect: string; message: string; data: any; origin: string },
): PolicyResult {
  return checkPolicyExplicit(policy, interrupt) ?? { type: "propagate" };
}

/** Like `checkPolicy`, but returns null when NO rule matched — callers that
 * need to distinguish an explicit `propagate` rule from plain fall-through
 * (e.g. the run-policy chain handler, which must stay silent on effects the
 * policy never mentions) use this; everyone else keeps `checkPolicy`'s
 * fall-through-is-propagate contract. */
export function checkPolicyExplicit(
  policy: Policy,
  interrupt: { effect: string; message: string; data: any; origin: string },
): PolicyResult | null {
  // Effect-specific rules take precedence over the wildcard.
  const rules = policy[interrupt.effect];
  if (rules) {
    for (const rule of rules) {
      if (matchesRule(rule, interrupt)) {
        return { type: rule.action };
      }
    }
  }

  // Wildcard catch-all: the `"*"` effect key applies to any interrupt whose
  // own effect had no matching rule. This is how an "approve-all" policy
  // covers effects it doesn't enumerate (a plain per-effect map would
  // `propagate` — i.e. surface to the user — on anything unlisted).
  const wildcard = policy["*"];
  if (wildcard) {
    for (const rule of wildcard) {
      if (matchesRule(rule, interrupt)) {
        return { type: rule.action };
      }
    }
  }

  return null;
}

// picomatch fails to match patterns starting with `./` when combined
// with `**` or brace expansions (e.g. `./docs/guide{,/**}` vs
// `./docs/guide` returns false). Strip a leading `./` from both
// pattern and value so paths normalize before matching.
function stripDotSlash(s: string): string {
  return s.startsWith("./") ? s.slice(2) : s;
}

function matchesRule(
  rule: PolicyRule,
  interrupt: { effect: string; message: string; data: any; origin: string },
): boolean {
  if (!rule.match) return true; // catch-all

  for (const [key, pattern] of Object.entries(rule.match)) {
    let value: string | undefined;
    if (key === "origin") {
      value = interrupt.origin;
    } else if (key === "message") {
      value = interrupt.message;
    } else {
      value = interrupt.data?.[key];
    }

    if (value === undefined) return false;
    if (typeof value !== "string") value = String(value);

    if (!picomatch.isMatch(stripDotSlash(value), stripDotSlash(pattern))) {
      return false;
    }
  }

  return true;
}

export function validatePolicy(policy: any): { success: boolean; error?: string } {
  const result = PolicySchema.safeParse(policy);
  if (!result.success) {
    return { success: false, error: result.error.message };
  }
  return { success: true };
}
