import * as smoltalk from "smoltalk";
import type { Run } from "./asyncContext.js";
import { callHook } from "./hooks.js";
import {
  CUT_OFF_NOTE,
  CUT_OFF_RETRIES,
  DROPPED_TOOL_CALL_NOTE,
  decideCutOff,
  type CutOffDecision,
  type FinalReplyRetryReason,
} from "./llmRetry.js";
import type { MessageThread } from "./state/messageThread.js";

/** The pieces of the tool loop's retry for a final reply that cannot be the
 *  answer: one the output limit cut off before it held any text or tool
 *  call, or one that stopped to call a tool but lost the call. `runPrompt`
 *  runs them inside the steps of `resendRequest`. See "A reply cut off by
 *  the output limit" and "A reply whose tool call was lost" in
 *  docs/dev/agents/tool-loop-guards.md. */

/** The tool loop's frame fields this retry reads and writes. `initLoopFrame`
 *  sets all four, so a checkpoint carries them. */
export type CutOffFrame = {
  cutOffAttempt: number;
  cutOffPending: number | null;
  /** Why the pending retry was prepared. A retry resumed after a pause
   *  reads it to send the right note. */
  cutOffReason: FinalReplyRetryReason | null;
  lastStopReason: smoltalk.StopReason | null;
};

/** What to do with the reply that ended the tool loop. A retry prepared
 *  before a pause is finished, not judged again: its `feedback` step already
 *  removed the reply the decision was about. A checkpoint from before
 *  `cutOffReason` existed can only hold a cut-off retry. */
export function cutOffDecision(frame: CutOffFrame, thread: MessageThread): CutOffDecision {
  if (frame.cutOffPending !== null) {
    return { kind: "retry", reason: frame.cutOffReason ?? "cutOff" };
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

const RETRY_DETAIL: Record<FinalReplyRetryReason, string> = {
  cutOff: "The reply reached the output limit before it held any text or tool call.",
  droppedToolCall: "The reply stopped to call a tool, but no tool call arrived.",
};

const RETRY_NOTE: Record<FinalReplyRetryReason, string> = {
  cutOff: CUT_OFF_NOTE,
  droppedToolCall: DROPPED_TOOL_CALL_NOTE,
};

/** The `feedback` step of retry `attempt`: tell the hooks, remove the reply,
 *  and record the prepared retry and its reason on the frame. */
export async function removeCutOffReply(
  run: Run,
  thread: MessageThread,
  frame: CutOffFrame,
  attempt: number,
  reason: FinalReplyRetryReason,
): Promise<void> {
  await callHook(run, {
    name: "onLLMRetry",
    data: {
      attempt: attempt + 1,
      maxRetries: CUT_OFF_RETRIES,
      delayMs: 0,
      reason,
      detail: RETRY_DETAIL[reason],
    },
  });
  thread.removeAt(lastAssistantIndex(thread));
  frame.cutOffPending = attempt;
  frame.cutOffReason = reason;
}

/** The note sent with the retried request. It expires with that request. */
export function pushCutOffNote(
  thread: MessageThread,
  expiryKey: string,
  reason: FinalReplyRetryReason,
): void {
  thread.push(smoltalk.userMessage(RETRY_NOTE[reason]), null, { at: "request", key: expiryKey });
}

/** Called inside the retried request's step, after the request returns. */
export function advanceCutOffAttempt(frame: CutOffFrame, attempt: number): void {
  frame.cutOffAttempt = attempt + 1;
  frame.cutOffPending = null;
  frame.cutOffReason = null;
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
