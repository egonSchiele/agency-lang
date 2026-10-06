import { checkPolicy, validatePolicy } from "@/runtime/policy.js";
import { currentRun } from "@/runtime/asyncContext.js";
import { wholePath, writeText } from "./contained.js";
import { assertContained } from "./assertContained.js";
export { validatePolicy as _validatePolicy, escapeGlob as _escapeGlob } from "@/runtime/policy.js";

/** `checkPolicy` from Agency: the `dir` patterns stand for the directories
 *  the run resolved when its context was built. */
export function _checkPolicy(
  policy: Policy,
  interrupt: { effect: string; message: string; data: any; origin: string },
): ReturnType<typeof checkPolicy> {
  const { ctx } = currentRun();
  return checkPolicy(policy, interrupt, ctx.policyDirs);
}
export {
  alwaysScopeFor as _alwaysScopeFor,
  allAlwaysScopes as _allAlwaysScopes,
} from "@/runtime/alwaysScope.js";
import type { Policy } from "@/runtime/policy.js";

// Built-in policies live in the runtime (single source of truth, shared with
// the `agency run --policy` CLI resolver and the runtime handler); re-export
// them so `std::policy` can surface the same set to Agency code (the agent).
// The --approve / --reject overlay, shared with `agency run` (resolveRunPolicy).
export { policyOverlayFromFlags as _policyOverlayFromFlags } from "@/runtime/policyFlags.js";
export {
  missingPolicyRules as _missingPolicyRules,
  appendPolicyRules as _appendPolicyRules,
} from "@/runtime/policyUpdate.js";

export {
  builtinPolicy as _builtinPolicy,
  builtinPolicyNames as _builtinPolicyNames,
  BUILTIN_POLICIES as _BUILTIN_POLICIES,
  minimalAutoApprovePolicy as _minimalAutoApprovePolicy,
  recommendedAutoApprovePolicy as _recommendedAutoApprovePolicy,
  withWritesPolicy as _withWritesPolicy,
  approveAllPolicy as _approveAllPolicy,
} from "@/runtime/builtinPolicies.js";

export async function _writePolicyFile(filePath: string, policy: Policy, allowedPaths?: string[]) {
  const result = validatePolicy(policy);
  if (!result.success) throw new Error(`Invalid policy: ${result.error}`);
  await assertContained(filePath, allowedPaths ?? []);
  const located = wholePath(filePath);
  writeText(located.root, located.target, JSON.stringify(policy, null, 2) + "\n", {
    fileMode: 0o600,
  });
}
