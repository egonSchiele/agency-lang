// Whether this process is answering an interrupt a subprocess raised.
//
// A parent answers a child's interrupt with its own handler chain
// (`handleInterruptMessage` in ipc.ts). A handler that leaves an interrupt
// unanswered so the program can save its checkpoint, as `cliPolicyHandler`
// does under `deferUndecided`, must not do that here. The child would
// pause, and the parent's restore of that checkpoint has no answer to give
// it: the resume fails with "Missing user response for subprocess
// interrupt". So such a handler asks in place while this is true.
//
// It is a count kept for the process, since several children can be
// answered at once. While any is, a deferring handler asks, including about
// an interrupt of the parent's own raised at the same moment. That is the
// behaviour without deferring, so nothing is answered that would not be.
import { processSlot } from "./processSlot.js";

const answering = processSlot<number>("agency.answeringSubprocess", () => 0);

/** Runs `answer`, which answers one interrupt a subprocess raised. */
export async function whileAnsweringSubprocess<T>(answer: () => Promise<T>): Promise<T> {
  answering.set(answering.get() + 1);
  try {
    return await answer();
  } finally {
    answering.set(answering.get() - 1);
  }
}

export function isAnsweringSubprocess(): boolean {
  return answering.get() > 0;
}
