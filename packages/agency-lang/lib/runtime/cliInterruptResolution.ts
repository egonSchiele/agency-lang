// The user endpoint for a CLI-driven run: called by the generated bootstrap
// after the top-level node returns. The handler chain has already had its say —
// anything still in `result.data` is an interrupt the program's own handlers
// (and the policy's explicit rules) did NOT settle, i.e. it has surfaced to the
// user. This resolves each surfaced interrupt and resumes until the run
// finishes, over the shared interrupt core.
//
// It sits ABOVE the core (interruptResolution) and above runPolicyHandler, so
// neither imports it — keeping the runtime graph one-way and cycle-free.

import { resolveInterrupts, resolveInterruptBatches, buildDecider } from "./interruptResolution.js";
import type { ResumeFn } from "./interruptResolution.js";
import { hasInterrupts, reportUnhandledInterrupts } from "./interrupts.js";
import type { Interrupt } from "./interrupts.js";
import type { InterruptResponse } from "./interruptResponse.js";
import type { RunNodeCoreResult } from "./types.js";
import { isIpcMode } from "./subprocessRunInfo.js";
import { hasRunPolicyMechanism, unansweredMode } from "./runPolicyHandler.js";
import { holdForAnswers, holdNotice } from "./heldQuestions.js";
import { removeHeldCheckpoint, saveHeldCheckpoint } from "./heldCheckpoint.js";
import { isAttachable } from "./platform.node.js";
import { defaultHost } from "#default-host";
import { AGENCY_CARRIER_ON, AGENCY_SAVE_HELD_CHECKPOINT } from "@/constants.js";
import type { PromptFn, ValuePromptFn } from "./interruptPrompts.js";

export type ResolveCliInterruptOptions = {
  prompt?: PromptFn;
  valuePrompt?: ValuePromptFn;
};

/**
 * Hold one batch for `--wait-for-response`: save its checkpoint when the
 * setting asks for that, tell the person how to answer, and wait. The
 * process never answers the batch itself, even when nothing can attach.
 */
async function waitForResponse(interrupts: Interrupt[]): Promise<InterruptResponse[]> {
  const host = defaultHost();
  const saving = host.settings.read(AGENCY_SAVE_HELD_CHECKPOINT) === AGENCY_CARRIER_ON;
  const checkpointFile = saving ? await saveHeldCheckpoint(interrupts, host) : null;
  console.error(
    holdNotice({
      questionCount: interrupts.length,
      pid: host.system.processId(),
      canAttach: isAttachable(),
      checkpointFile,
    }),
  );
  try {
    return await holdForAnswers(interrupts);
  } finally {
    if (checkpointFile !== null) {
      await removeHeldCheckpoint(checkpointFile, host);
    }
  }
}

/**
 * Decisions: `--interactive` prompts on the terminal ("always" answers are
 * remembered for the rest of the run); `--wait-for-response` holds each batch
 * until `agency attach` answers it; without either every surfaced interrupt
 * is rejected (the documented default). Value-expecting interrupts get the
 * answer prompt instead. Without any policy flag at all (or in an IPC
 * subprocess, which never owns the terminal), this reports the unhandled
 * interrupt and exits non-zero — the historical no-flag behavior.
 */
export async function resolveCliInterrupts(
  result: RunNodeCoreResult<any>,
  respond: ResumeFn<RunNodeCoreResult<any>>,
  options?: ResolveCliInterruptOptions,
): Promise<RunNodeCoreResult<any>> {
  if (!hasInterrupts(result.data)) {
    return result;
  }
  if (isIpcMode() || !hasRunPolicyMechanism(defaultHost().settings)) {
    await reportUnhandledInterrupts(result);
    return result;
  }

  const mode = unansweredMode(defaultHost().settings);
  if (mode === "wait") {
    return resolveInterruptBatches(result, respond, waitForResponse);
  }
  // No policy at the endpoint (finding 1): run's policy acts only in the
  // in-chain handler. Re-applying it here would auto-approve an interrupt a
  // program handler deliberately propagated despite an approve rule.
  const decide = buildDecider({
    interactive: mode === "prompt",
    prompt: options?.prompt,
    valuePrompt: options?.valuePrompt,
  });
  return resolveInterrupts(result, respond, decide);
}
