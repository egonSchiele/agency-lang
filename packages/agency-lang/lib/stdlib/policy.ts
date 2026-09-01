import { validatePolicy } from "@/runtime/policy.js";
import { writeFileSync } from "fs";
import { resolveDir } from "./resolveDir.js";
export {
  checkPolicy as _checkPolicy,
  validatePolicy as _validatePolicy,
  escapeGlob as _escapeGlob,
} from "@/runtime/policy.js";
export {
  alwaysScopeFor as _alwaysScopeFor,
  allAlwaysScopes as _allAlwaysScopes,
} from "@/runtime/alwaysScope.js";
import type { Policy } from "@/runtime/policy.js";

// Built-in policies live in the runtime (single source of truth, shared with
// the `agency run --policy` CLI resolver and the runtime handler); re-export
// them so `std::policy` can surface the same set to Agency code (the agent).
// The one definition of what `--approve` / `--reject` flag values mean.
// `agency run` uses it via resolveRunPolicy; the agent's flags reach it
// through std::policy's policyOverlayFromFlags wrapper.
export { policyOverlayFromFlags as _policyOverlayFromFlags } from "@/runtime/policyFlags.js";

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
  // `resolveDir` (cwd-anchored) handles `~` expansion + allow-list
  // enforcement uniformly with the fs.ts / system.ts / speech.ts call sites.
  const full = await resolveDir(filePath, allowedPaths ?? []);
  writeFileSync(full, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
}
