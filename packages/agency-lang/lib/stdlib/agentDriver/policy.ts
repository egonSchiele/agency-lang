import type { Policy } from "../../runtime/policy.js";
import { layerPolicy } from "../../runtime/policyFlags.js";
import { success, type Result } from "../../types/result.js";
import { SESSION_INPUT_EFFECT } from "./interface.js";

/** The policy a front-end runs this session under. `carried` is what
 *  `readCarriedPolicy` gives for the session, and `saved` is the user's
 *  saved policy.
 *
 *  - The session has a policy of its own: that policy, with the reject
 *    rules of `saved` ahead of its rules. Only the rejects: beside
 *    `recommended`, a session started with `--policy minimal` would have
 *    its reads approved, since `minimal` says nothing about `std::read`.
 *  - It has none: `saved`.
 *  - Its policy can't be read: this fails, and `saved` is never used.
 *
 *  `extra` is the flags given at resume, laid over the rest as flags are.
 *  "Always" answers given in a session that has a policy of its own are
 *  saved to its policy file, so `carried` already holds them.
 *
 *  ```ts
 *  const carried = await readCarriedPolicy({ home, id });
 *  const policy = sessionRunPolicy({ carried, saved, extra: null });
 *  if (!policy.success) {
 *    // show policy.error; do not resume
 *  }
 *  ```
 *
 *  It does not pin the core's pause. `startRun` and `resumeRun` do that to
 *  every policy they are given. */
export function sessionRunPolicy(args: {
  carried: Result<Policy | null>;
  saved: Policy;
  extra: Policy | null;
}): Result<Policy> {
  const { carried, saved, extra } = args;
  if (!carried.success) {
    return carried;
  }
  const base =
    carried.value === null
      ? saved
      : layerPolicy({ top: rejectRulesOf(saved), base: carried.value });
  return success(extra === null ? base : layerPolicy({ top: extra, base }));
}

/** Each effect's reject rules, in order. An effect with none is left out. */
export function rejectRulesOf(policy: Policy): Policy {
  const rejects: Policy = Object.create(null);
  for (const effect of Object.keys(policy)) {
    const rules = policy[effect].filter((rule) => rule.action === "reject");
    if (rules.length > 0) {
      rejects[effect] = rules;
    }
  }
  return rejects;
}

/** `policy` with the core's pause pinned to `propagate`.
 *
 *  A `*` rule matches every effect, the core's pause included. Either
 *  answer would reach the pause with no message, and the core ends the
 *  session when its pause is answered with nothing. An effect's own rule
 *  beats `*`, so this pin always hands the pause on to the front-end,
 *  whatever the rest of the policy says.
 *
 *  A run given a policy that holds only this pin behaves as a run given no
 *  policy: the run's policy handler says nothing about an effect with no
 *  rule, so every other interrupt still reaches the front-end. */
export function withPauseLeftAlone(policy: Policy): Policy {
  return { ...policy, [SESSION_INPUT_EFFECT]: [{ action: "propagate" }] };
}
