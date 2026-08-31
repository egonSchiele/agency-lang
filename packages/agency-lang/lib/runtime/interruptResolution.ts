// The transport-agnostic interrupt loop: given a result that may carry surfaced
// interrupts, decide each one and resume until the run finishes. This is the
// loop `resolveCliInterrupts` used to inline; extracting it lets both a local
// run (resume in-process) and `remote call` (resume over HTTP) share one
// mechanism, differing only in the injected `respond` and `decide`.

import { hasInterrupts } from "./interrupts.js";
import type { Interrupt, InterruptResult } from "./interrupts.js";
import { approve, reject } from "./interruptResponse.js";
import type { InterruptResponse } from "./interruptResponse.js";
import { checkPolicyExplicit } from "./policy.js";
import type { Policy } from "./policy.js";
import { terminalPrompt, terminalValuePrompt } from "./interruptPrompts.js";
import type { PromptFn, ValuePromptFn } from "./interruptPrompts.js";

export type { InterruptResult } from "./interrupts.js";

/** Resume a paused run. Kept generic over the result shape so a local run
 *  preserves its full `RunNodeResult` while the remote client uses a minimal
 *  `{ data }`. */
export type ResumeFn<R extends InterruptResult> = (
  interrupts: Interrupt[],
  responses: InterruptResponse[],
) => Promise<R>;

/** Decide one surfaced interrupt. */
export type DecideFn = (interrupt: Interrupt) => Promise<InterruptResponse>;

/**
 * Loop until the run stops pausing: for each surfaced interrupt, `decide` it,
 * then `respond` (resume) with the collected responses, and repeat. Pure of
 * transport, prompts, and policy — those live in the injected callbacks.
 */
export async function resolveInterrupts<R extends InterruptResult>(
  result: R,
  respond: ResumeFn<R>,
  decide: DecideFn,
): Promise<R> {
  while (hasInterrupts(result.data)) {
    const interrupts = result.data;
    const responses: InterruptResponse[] = [];
    for (const interrupt of interrupts) {
      responses.push(await decide(interrupt));
    }
    result = await respond(interrupts, responses);
  }
  return result;
}

export type BuildDeciderOptions = {
  /** Client-endpoint policy. Omitted for local `run` (its policy acts in-chain,
   *  and re-applying it here would auto-approve interrupts a handler propagated
   *  — finding 1). Passed for `remote call`, which has no in-chain handler. */
  policy?: Policy;
  interactive: boolean;
  prompt?: PromptFn;
  valuePrompt?: ValuePromptFn;
};

/**
 * Build the per-interrupt decision function. Policy runs first for every
 * interrupt: an explicit approve/reject settles immediately (a value-expecting
 * interrupt settled this way gets a valueless approve/reject — the runtime
 * resolves the assignment to its default). Only when the policy leaves an
 * interrupt "unsettled" (`propagate` or no-match) does interactivity apply: a
 * value-expecting interrupt uses the value prompt, a statement interrupt the
 * ordinary prompt, and a non-interactive run rejects (fail-closed). "Always"
 * answers are remembered per effect for the run. The result
 * is always an approve/reject response — never `propagate`, so it can never be
 * sent over a resume boundary.
 */
export function buildDecider(options: BuildDeciderOptions): DecideFn {
  const prompt = options.prompt ?? terminalPrompt;
  const valuePrompt = options.valuePrompt ?? terminalValuePrompt;
  const remembered: Record<string, "approve" | "reject"> = Object.create(null);

  return async (interrupt) => {
    const decision = options.policy ? checkPolicyExplicit(options.policy, interrupt) : null;
    if (decision?.type === "approve") {
      return approve();
    }
    if (decision?.type === "reject") {
      return reject(decision.message);
    }
    if (interrupt.expectsValue) {
      if (options.interactive) {
        return valuePrompt(interrupt);
      }
      return reject();
    }

    let action = remembered[interrupt.effect];
    if (!action && options.interactive) {
      const answer = await prompt(interrupt);
      const approves = answer === "approve" || answer === "approve-always";
      action = approves ? "approve" : "reject";
      const remember = answer === "approve-always" || answer === "reject-always";
      if (remember) {
        remembered[interrupt.effect] = action;
      }
    }
    return action === "approve" ? approve() : reject();
  };
}
