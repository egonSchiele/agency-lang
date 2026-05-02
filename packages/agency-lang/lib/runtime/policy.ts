import picomatch from "picomatch";

type PolicyRule = {
  match?: Record<string, string>;
  action: "allow" | "deny" | "propagate";
};

type Policy = Record<string, PolicyRule[]>;

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
      return actionToResult(rule.action);
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

function actionToResult(action: string): PolicyResult {
  switch (action) {
    case "allow": return { type: "approve" };
    case "deny": return { type: "reject" };
    case "propagate": return { type: "propagate" };
    default: return { type: "propagate" };
  }
}

export function validatePolicy(policy: any): { success: boolean; error?: string } {
  if (typeof policy !== "object" || policy === null) {
    return { success: false, error: "Policy must be an object" };
  }
  for (const [kind, rules] of Object.entries(policy)) {
    if (!Array.isArray(rules)) {
      return { success: false, error: `Rules for "${kind}" must be an array` };
    }
    for (const rule of rules as any[]) {
      if (!rule.action || !["allow", "deny", "propagate"].includes(rule.action)) {
        return { success: false, error: `Invalid action in rules for "${kind}": ${rule.action}` };
      }
    }
  }
  return { success: true };
}
