// The approvals one pause asks for, answered in order. A front-end says
// how to answer the ones something already on record decides (`Settle`),
// and asks a person about the rest. See docs/dev/agents/session-driver.md.
import type { Interrupt, InterruptResponse } from "../../runtime/interrupts.js";
import { reject } from "../../runtime/interruptResponse.js";

/** The approvals one pause asks for, and the answers given so far, in
 *  order. */
export type ApprovalQueue = {
  interrupts: Interrupt[];
  responses: InterruptResponse[];
};

/** An answer given without asking. `by` says what gave it: a rule, such as
 *  one the person saved by answering "always" a moment ago. */
export type SettledBy = { response: InterruptResponse; by: "rule" };

/** The answer something already on record gives an interrupt, or null
 *  when nothing decides it and a person must be asked. A raise that wants
 *  a typed value is passed here too: a front-end that cannot ask for one
 *  declines it here. */
export type Settle = (interrupt: Interrupt) => SettledBy | null;

/** One interrupt `settle` answered. */
export type Settled = { interrupt: Interrupt } & SettledBy;

/** A queue after a step, and what `settle` answered on the way. */
export type QueueStep = { queue: ApprovalQueue; settled: Settled[] };

/** The interrupt waiting for an answer, or null once all are answered. */
export function currentApproval(queue: ApprovalQueue): Interrupt | null {
  return queue.interrupts[queue.responses.length] ?? null;
}

function withResponse(queue: ApprovalQueue, response: InterruptResponse): ApprovalQueue {
  return { ...queue, responses: [...queue.responses, response] };
}

/** Answers the next interrupts that `settle` decides, and stops at the
 *  first it does not. */
function settleAhead(args: { queue: ApprovalQueue; settle: Settle }): QueueStep {
  const settled: Settled[] = [];
  let queue = args.queue;
  let current = currentApproval(queue);
  while (current !== null) {
    const answer = args.settle(current);
    if (answer === null) {
      break;
    }
    settled.push({ interrupt: current, ...answer });
    queue = withResponse(queue, answer.response);
    current = currentApproval(queue);
  }
  return { queue, settled };
}

/** A queue for the interrupts of one pause, with the ones `settle`
 *  decides at the front already answered. */
export function startQueue(args: { interrupts: Interrupt[]; settle: Settle }): QueueStep {
  return settleAhead({
    queue: { interrupts: args.interrupts, responses: [] },
    settle: args.settle,
  });
}

/** Answers the current interrupt, then lets `settle` take any that follow.
 *  `settle` is asked again after every answer, so a rule saved by this
 *  answer covers the rest. */
export function respondWith(args: {
  queue: ApprovalQueue;
  response: InterruptResponse;
  settle: Settle;
}): QueueStep {
  return settleAhead({ queue: withResponse(args.queue, args.response), settle: args.settle });
}

/** When no one can be asked: declines the current interrupt, lets
 *  `settle` take what follows, and repeats until every interrupt is
 *  answered. Declining only the current one keeps an interrupt a rule
 *  answers on the rule's answer. */
export function declineUndecided(args: {
  queue: ApprovalQueue;
  settle: Settle;
  reasonFor: (interrupt: Interrupt) => string;
}): QueueStep {
  const settled: Settled[] = [];
  let queue = args.queue;
  let current = currentApproval(queue);
  while (current !== null) {
    const response = reject(args.reasonFor(current));
    const step = respondWith({ queue, response, settle: args.settle });
    settled.push(...step.settled);
    queue = step.queue;
    current = currentApproval(queue);
  }
  return { queue, settled };
}
