import { checkPolicy, validatePolicy } from "@/runtime/policy.js";
import { currentRun } from "@/runtime/asyncContext.js";
import { currentHost } from "@/runtime/currentHost.js";
import path from "#path";
import { assertContained } from "./assertContained.js";
import { allAlwaysScopes, type ScopedField } from "@/runtime/alwaysScope.js";
import { builtinEffectSets } from "@/runtime/effectSets.js";
import {
  folderChoices,
  inSharedApprovalSet,
  resolvedScopes,
  sharedApprovalSet,
  type FolderChoice,
} from "@/runtime/alwaysChoices.js";
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
export { describeScope as _describeScope } from "@/runtime/alwaysChoices.js";
import type { Policy } from "@/runtime/policy.js";

/** The folders the prompt's folder step offers for `value`, measured
 *  against the directories the run resolved when its context was built. */
export function _folderChoices(value: string): FolderChoice[] {
  const { ctx } = currentRun();
  return folderChoices(value, ctx.policyDirs);
}

/** The listed effect set one answer may cover for `effect`, with each
 *  member's scope resolved through the caller's `fields:` overrides. An
 *  empty name and member list when no set applies. */
export function _sharedApprovalSet(
  effect: string,
  overrides: Record<string, ScopedField[]>,
): { name: string; members: string[] } {
  const scopes = resolvedScopes(allAlwaysScopes(), overrides);
  const set = sharedApprovalSet(effect, scopes, builtinEffectSets());
  return set === null ? { name: "", members: [] } : { name: set.name, members: set.members };
}

/** Whether `effect` belongs to a set that gets the broader answers. */
export function _inSharedApprovalSet(effect: string): boolean {
  return inSharedApprovalSet(effect, builtinEffectSets());
}

// Built-in policies live in the runtime (single source of truth, shared with
// the `agency run --policy` CLI resolver and the runtime handler); re-export
// them so `std::policy` can surface the same set to Agency code (the agent).
// The --approve / --reject overlay, shared with `agency run` (resolveRunPolicy).
export { policyOverlayFromFlags as _policyOverlayFromFlags } from "@/runtime/policyFlags.js";
export {
  missingPolicyRules as _missingPolicyRules,
  appendPolicyRules as _appendPolicyRules,
  prependPolicyRule as _prependPolicyRule,
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

/** A policy save, worked out before its `std::write` interrupt: the real
 *  directory and file name the interrupt names, and the exact text that
 *  will be written, so the approver sees what the file will say. */
export type PolicyWrite = { dir: string; filename: string; content: string };

/** Validate a policy and resolve where it goes. Nothing is written. */
export async function _preparePolicyWrite(
  filePath: string,
  policy: Policy,
  allowedPaths?: string[],
): Promise<PolicyWrite> {
  const host = currentHost();
  const result = validatePolicy(policy);
  if (!result.success) throw new Error(`Invalid policy: ${result.error}`);
  await assertContained(host, filePath, allowedPaths ?? []);
  const real = await host.files.realPath(filePath);
  return {
    dir: path.dirname(real),
    filename: path.basename(real),
    content: JSON.stringify(policy, null, 2) + "\n",
  };
}

/** The real directory of a policy file, spelled the way a `std::read` or
 *  `std::write` payload spells it. The CLI handler compares it with the
 *  payload to recognize interrupts for its own file. */
export async function _policyFileDir(filePath: string): Promise<string> {
  const host = currentHost();
  return path.dirname(await host.files.realPath(filePath));
}

/** Write a prepared policy to the directory its approval named. The file
 *  is created readable by its owner only. */
export async function _writePreparedPolicy(write: PolicyWrite): Promise<void> {
  const host = currentHost();
  await host.files.writeText(await host.files.fixedRoot(write.dir), write.filename, write.content, {
    fileMode: 0o600,
  });
}

/** Validate and write a policy with no interrupt. Only the bundled agents
 *  call this, for a save their user asked for in the agent's own setup.
 *  Agency code goes through `writePolicyFile` in std::policy, which raises
 *  `std::write` first. */
export async function _writePolicyFile(filePath: string, policy: Policy, allowedPaths?: string[]) {
  await _writePreparedPolicy(await _preparePolicyWrite(filePath, policy, allowedPaths));
}
