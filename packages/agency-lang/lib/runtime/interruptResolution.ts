// The transport-agnostic interrupt loop: given a result that may carry surfaced
// interrupts, decide each one and resume until the run finishes. This is the
// loop `resolveCliInterrupts` used to inline; extracting it lets both a local
// run (resume in-process) and `remote call` (resume over HTTP) share one
// mechanism, differing only in the injected `respond` and `decide`.

import { hasInterrupts } from "./interrupts.js";
import type { Interrupt, InterruptResult } from "./interrupts.js";
import type { InterruptResponse } from "./interruptResponse.js";

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
