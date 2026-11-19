import { resolveRunPolicy } from "@/cli/runPolicy.js";
import type { Policy } from "@/runtime/policy.js";
import { failure, success, type Result } from "@/types/result.js";

export type PolicyFlags = { policy?: string; approve?: string; reject?: string };

/** The policy the `--policy`, `--approve` and `--reject` flags resolve to,
 *  the same way `agency run` does it. `value` is null when none of the
 *  three was given. A bad policy name or file is a failure. */
export function _resolveRunPolicy(flags: PolicyFlags, cwd: string): Result<Policy | null> {
  try {
    const resolved = resolveRunPolicy({
      policy: flags.policy,
      approve: flags.approve,
      reject: flags.reject,
      cwd,
    });
    return success(resolved === null ? null : resolved.policy);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
