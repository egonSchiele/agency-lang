import { existsSync, readFileSync } from "fs";
import type { Policy } from "@/runtime/policy.js";
import { validatePolicy } from "@/runtime/policy.js";
import { builtinPolicy, builtinPolicyNames } from "@/runtime/builtinPolicies.js";
import { policyOverlayFromFlags } from "@/runtime/policyFlags.js";

export type RunPolicyFlags = {
  policy?: string;
  approve?: string;
  reject?: string;
  interactive?: boolean;
  cwd: string;
};

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

/** The resolved run policy. `policyJson` is threaded into the subprocess
 *  environment (AGENCY_RUN_POLICY); `policy` is the same object, exposed so
 *  in-process callers (e.g. `remote call`'s decider) use it without re-parsing
 *  the JSON or rebuilding the policy. */
export type ResolvedRunPolicy = {
  policy: Policy;
  policyJson: string;
  interactive: boolean;
};

export function resolveRunPolicy(flags: RunPolicyFlags): ResolvedRunPolicy | null {
  const hasAny = !!flags.policy || !!flags.approve || !!flags.reject || !!flags.interactive;
  if (!hasAny) return null;

  // The overlay semantics (rule order, reject-over-approve) live in
  // policyOverlayFromFlags, shared with the agent's flags.
  const policy = policyOverlayFromFlags(
    flags.approve,
    flags.reject,
    loadBase(flags.policy, flags.cwd),
  );

  return { policy, policyJson: JSON.stringify(policy), interactive: !!flags.interactive };
}
