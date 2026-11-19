import type { Policy } from "../../runtime/policy.js";
import { SESSION_INPUT_EFFECT } from "./interface.js";

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
