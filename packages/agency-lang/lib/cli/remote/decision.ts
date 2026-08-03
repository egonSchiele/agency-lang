// CLI flags -> interrupt decider for `remote call`. Owns the flag → resolved
// policy → buildDecider path, so the command recipe never parses policy JSON or
// touches buildDecider directly. Returns null when no interrupt-handling flag
// was given — the command then reports a surfaced interrupt as unhandled, just
// like `agency run` with no policy flag.

import { resolveRunPolicy } from "@/cli/runPolicy.js";
import { buildDecider } from "@/runtime/interruptResolution.js";
import type { DecideFn } from "@/runtime/interruptResolution.js";

export type RemoteDecisionFlags = {
  policy?: string;
  approve?: string;
  reject?: string;
  interactive?: boolean;
};

/** Build the decider from the flags, or null when none were given. Throws the
 *  same error `agency run` reports for an invalid policy (the command's catch
 *  turns it into a clean CLI error). */
export function resolveRemoteDecision(flags: RemoteDecisionFlags): DecideFn | null {
  const resolved = resolveRunPolicy({
    policy: flags.policy,
    approve: flags.approve,
    reject: flags.reject,
    interactive: flags.interactive,
    cwd: process.cwd(),
  });
  if (!resolved) {
    return null;
  }
  // Consume the parsed policy directly — never re-parse policyJson.
  return buildDecider({ policy: resolved.policy, interactive: resolved.interactive });
}
