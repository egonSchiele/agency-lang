// The user endpoint for a CLI-driven run: called by the generated bootstrap
// after the top-level node returns. The handler chain has already had its say —
// anything still in `result.data` is an interrupt the program's own handlers
// (and the policy's explicit rules) did NOT settle, i.e. it has surfaced to the
// user. This resolves each surfaced interrupt and resumes until the run
// finishes, over the shared interrupt core.
//
// It sits ABOVE the core (interruptResolution) and above runPolicyHandler, so
// neither imports it — keeping the runtime graph one-way and cycle-free.

import { resolveInterrupts, buildDecider } from "./interruptResolution.js";
import type { ResumeFn } from "./interruptResolution.js";
import { hasInterrupts, reportUnhandledInterrupts } from "./interrupts.js";
import type { RunNodeResult } from "./types.js";
import { isIpcMode } from "./subprocessRunInfo.js";
import { hasRunPolicyMechanism } from "./runPolicyHandler.js";
import {
  AGENCY_RUN_POLICY_INTERACTIVE,
  AGENCY_RUN_POLICY_INTERACTIVE_ON,
} from "@/constants.js";
import type { PromptFn, ValuePromptFn } from "./interruptPrompts.js";

export type ResolveCliInterruptOptions = {
  prompt?: PromptFn;
  valuePrompt?: ValuePromptFn;
};

/**
 * Decisions: `--interactive` prompts on the terminal ("always" answers are
 * remembered for the rest of the run); without it every surfaced interrupt is
 * rejected (the documented default). Value-expecting interrupts get the answer
 * prompt instead. Without any policy flag at all (or in an IPC subprocess, which
 * never owns the terminal), this reports the unhandled interrupt and exits
 * non-zero — the historical no-flag behavior.
 */
export async function resolveCliInterrupts(
  result: RunNodeResult<any>,
  respond: ResumeFn<RunNodeResult<any>>,
  options?: ResolveCliInterruptOptions,
): Promise<RunNodeResult<any>> {
  if (!hasInterrupts(result.data)) {
    return result;
  }
  if (isIpcMode() || !hasRunPolicyMechanism()) {
    reportUnhandledInterrupts(result);
    return result;
  }

  const interactive =
    process.env[AGENCY_RUN_POLICY_INTERACTIVE] === AGENCY_RUN_POLICY_INTERACTIVE_ON;
  // No policy at the endpoint (finding 1): run's policy acts only in the
  // in-chain handler. Re-applying it here would auto-approve an interrupt a
  // program handler deliberately propagated despite an approve rule.
  const decide = buildDecider({
    interactive,
    prompt: options?.prompt,
    valuePrompt: options?.valuePrompt,
  });
  return resolveInterrupts(result, respond, decide);
}
