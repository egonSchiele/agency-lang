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
  interrupt: { kind: string; message: string; data: any; origin: string },
): PolicyResult {
  const rules = policy[interrupt.kind];
  if (!rules) {
    return { type: "propagate" };
  }

  for (const rule of rules) {
    if (matchesRule(rule, interrupt)) {
      return { type: rule.action };
    }
  }

  return { type: "propagate" };
}

function matchesRule(
  rule: PolicyRule,
  interrupt: { kind: string; message: string; data: any; origin: string },
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

    if (!picomatch.isMatch(value, pattern)) return false;
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
