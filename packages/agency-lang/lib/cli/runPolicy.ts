import { existsSync, readFileSync } from "fs";
import type { Policy, PolicyRule } from "@/runtime/policy.js";
import { validatePolicy } from "@/runtime/policy.js";
import {
  builtinPolicy,
  builtinPolicyNames,
} from "@/runtime/builtinPolicies.js";

export type RunPolicyFlags = {
  policy?: string;
  approve?: string;
  reject?: string;
  interactive?: boolean;
  cwd: string;
};

// Split on commas and/or whitespace, so `--approve "std::read, std::ls"`,
// `--approve std::read,std::ls`, and `--approve "std::read std::ls"` all work.
function splitEffects(list: string | undefined): string[] {
  if (!list) return [];
  return list.split(/[\s,]+/).filter((s) => s.length > 0);
}

function loadBase(policy: string | undefined, cwd: string): Policy {
  if (!policy) return {};
  const builtin = builtinPolicy(policy, cwd);
  if (builtin) {
    // Clone so inline overlay never mutates the shared built-in object.
    return JSON.parse(JSON.stringify(builtin));
  }
  if (!existsSync(policy)) {
    throw new Error(
      `unknown policy "${policy}": not a built-in (${builtinPolicyNames().join(
        ", ",
      )}) or a readable file`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(policy, "utf-8");
  } catch (e) {
    // A read failure (permissions, an ENOENT race after existsSync) is a
    // distinct failure mode from bad JSON — report it as such.
    throw new Error(`could not read policy file ${policy}: ${String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`policy file ${policy} is not valid JSON: ${String(e)}`);
  }
  const valid = validatePolicy(parsed);
  if (!valid.success) {
    throw new Error(`invalid policy file ${policy}: ${valid.error}`);
  }
  return parsed as Policy;
}

export function resolveRunPolicy(
  flags: RunPolicyFlags,
): { policyJson: string; interactive: boolean } | null {
  const hasAny =
    !!flags.policy || !!flags.approve || !!flags.reject || !!flags.interactive;
  if (!hasAny) return null;

  const policy = loadBase(flags.policy, flags.cwd);

  const approved = splitEffects(flags.approve);
  const rejected = splitEffects(flags.reject);

  // Build each affected effect's rule list in ONE construction so precedence
  // is visible in the literal, not implied by statement order: reject rule,
  // then approve rule, then the base's own rules. Reject-ahead-of-approve is
  // how overlap resolves to reject under checkPolicy's first-match-wins — and
  // you cannot break it by reordering statements.
  const rejectRule: PolicyRule = { action: "reject" };
  const approveRule: PolicyRule = { action: "approve" };
  const affected = [...approved, ...rejected].filter(
    (e, i, a) => a.indexOf(e) === i,
  );
  for (const effect of affected) {
    policy[effect] = [
      ...(rejected.includes(effect) ? [rejectRule] : []),
      ...(approved.includes(effect) ? [approveRule] : []),
      ...(policy[effect] ?? []),
    ];
  }

  return { policyJson: JSON.stringify(policy), interactive: !!flags.interactive };
}
