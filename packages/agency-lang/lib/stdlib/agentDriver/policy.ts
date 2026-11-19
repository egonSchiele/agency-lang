import type { Policy } from "../../runtime/policy.js";
import { layerPolicy } from "../../runtime/policyFlags.js";
import { success, type Result } from "../../types/result.js";
import { SESSION_INPUT_EFFECT } from "./interface.js";

/** The policy a front-end runs this session under: the session's own when
 *  it carries one, else `saved`. `carried` is what `carriedPolicy(pause)`
 *  gives. When it failed (the session's policy can't be read), so does
 *  this, and `saved` is never used: the session's own policy may ask
 *  about what `saved` approves. `extra` is what the front-end adds for
 *  this sitting, layered on top as flags are: flags given at resume, and
 *  "always" answers given in a session that carries a policy.
 *
 *  ```ts
 *  const policy = sessionRunPolicy({ carried: carriedPolicy(pause), saved, extra: null });
 *  if (!policy.success) {
 *    // show policy.error; do not resume
 *  }
 *  ```
 *
 *  The session's policy replaces `saved`, and does not sit beside it.
 *  Every handler is consulted, and a policy with no rule for an effect
 *  says nothing. So beside `recommended`, a session started with
 *  `--policy minimal` would keep only its rejects: `minimal` says nothing
 *  about `std::read`, and `recommended` would approve the read.
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
  const base = carried.value ?? saved;
  return success(extra === null ? base : layerPolicy({ top: extra, base }));
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
