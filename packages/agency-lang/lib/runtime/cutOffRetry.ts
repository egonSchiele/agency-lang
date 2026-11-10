import * as smoltalk from "smoltalk";
import type { Run } from "./asyncContext.js";
import { callHook } from "./hooks.js";
import { CUT_OFF_NOTE, CUT_OFF_RETRIES, decideCutOff, type CutOffDecision } from "./llmRetry.js";
import type { MessageThread } from "./state/messageThread.js";

/** The pieces of the tool loop's retry for a reply the output limit cut off
 *  before it held any text or tool call. `runPrompt` runs them inside the
 *  steps of `resendRequest`. See "A reply cut off by the output limit" in
 *  docs/dev/agents/tool-loop-guards.md. */

/** The tool loop's frame fields this retry reads and writes. `initLoopFrame`
 *  sets all three, so a checkpoint carries them. */
export type CutOffFrame = {
  cutOffAttempt: number;
  cutOffPending: number | null;
  lastStopReason: smoltalk.StopReason | null;
};

/** What to do with the reply that ended the tool loop. A retry prepared
 *  before a pause is finished, not judged again: its `feedback` step already
 *  removed the reply the decision was about. */
export function cutOffDecision(frame: CutOffFrame, thread: MessageThread): CutOffDecision {
  if (frame.cutOffPending !== null) {
    return { kind: "retry" };
  }
  const index = lastAssistantIndex(thread);
  if (index === -1) {
    return { kind: "accept" };
  }
  return decideCutOff({
    stopReason: frame.lastStopReason ?? undefined,
    content: textContent(thread.getMessages()[index].content),
    attempt: frame.cutOffAttempt,
  });
}

/** The `feedback` step of retry `attempt`: tell the hooks, remove the empty
 *  reply, and record the prepared retry on the frame. */
export async function removeCutOffReply(
  run: Run,
  thread: MessageThread,
  frame: CutOffFrame,
  attempt: number,
): Promise<void> {
  await callHook(run, {
    name: "onLLMRetry",
    data: {
      attempt: attempt + 1,
      maxRetries: CUT_OFF_RETRIES,
      delayMs: 0,
      reason: "cutOff",
      detail: "The reply reached the output limit before it held any text or tool call.",
    },
  });
  thread.removeAt(lastAssistantIndex(thread));
  frame.cutOffPending = attempt;
}

/** The note sent with the retried request. It expires with that request. */
export function pushCutOffNote(thread: MessageThread, expiryKey: string): void {
  thread.push(smoltalk.userMessage(CUT_OFF_NOTE), null, { at: "request", key: expiryKey });
}

/** Called inside the retried request's step, after the request returns. */
export function advanceCutOffAttempt(frame: CutOffFrame, attempt: number): void {
  frame.cutOffAttempt = attempt + 1;
  frame.cutOffPending = null;
}

function lastAssistantIndex(thread: MessageThread): number {
  return thread.getMessages().findLastIndex((message) => message.role === "assistant");
}

function textContent(content: unknown): string | null {
  if (content === null || content === undefined) {
    return null;
  }
  return typeof content === "string" ? content : JSON.stringify(content);
}
