import * as smoltalk from "smoltalk";
import type { Run } from "./asyncContext.js";
import { callHook } from "./hooks.js";
import {
  CUT_OFF_NOTE,
  DROPPED_TOOL_CALL_NOTE,
  FINAL_REPLY_RETRIES,
  decideFinalReplyRetry,
  type FinalReplyDecision,
  type FinalReplyRetryReason,
} from "./llmRetry.js";
import type { MessageThread } from "./state/messageThread.js";
import type { StatelogErrorType } from "../statelog/wireTypes.js";

/** The pieces of the tool loop's retry for a final reply that cannot be the
 *  answer: one the output limit cut off before it held any text or tool
 *  call, or one that stopped to call a tool but lost the call. `runPrompt`
 *  runs them inside the steps of `resendRequest`. See "A reply cut off by
 *  the output limit" and "A reply whose tool call was lost" in
 *  docs/dev/agents/tool-loop-guards.md. */

/** The tool loop's frame fields this retry reads and writes. `initLoopFrame`
 *  sets all five, so a checkpoint carries them. They keep their `cutOff`
 *  names, which checkpoints store, from before the retry covered lost tool
 *  calls too. */
export type FinalReplyFrame = {
  cutOffAttempt: number;
  cutOffPending: number | null;
  /** Why the pending retry was prepared. A retry resumed after a pause
   *  reads it to send the right note. */
  cutOffReason: FinalReplyRetryReason | null;
  lastStopReason: smoltalk.StopReason | null;
  /** Whether the last request offered any function tools. Null in a
   *  checkpoint from before the field, which is read as true. */
  lastRequestOfferedTools: boolean | null;
};

/** What to do with the reply that ended the tool loop. A retry prepared
 *  before a pause is finished, not judged again: its `feedback` step already
 *  removed the reply the decision was about. A checkpoint from before
 *  `cutOffReason` existed can only hold a cut-off retry. */
export function finalReplyDecision(
  frame: FinalReplyFrame,
  thread: MessageThread,
): FinalReplyDecision {
  if (frame.cutOffPending !== null) {
    return { kind: "retry", reason: frame.cutOffReason ?? "cutOff" };
  }
  const index = lastAssistantIndex(thread);
  if (index === -1) {
    return { kind: "accept" };
  }
  return decideFinalReplyRetry({
    stopReason: frame.lastStopReason ?? undefined,
    content: textContent(thread.getMessages()[index].content),
    attempt: frame.cutOffAttempt,
    offeredTools: frame.lastRequestOfferedTools !== false,
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

/** The statelog error logged when the retries for a reason run out. */
export const RETRY_ERROR_TYPE: Record<FinalReplyRetryReason, StatelogErrorType> = {
  cutOff: "replyCutOff",
  droppedToolCall: "droppedToolCall",
};

/** The `feedback` step of retry `attempt`: tell the hooks, remove the reply,
 *  and record the prepared retry and its reason on the frame. */
export async function removeRetriedReply(
  run: Run,
  thread: MessageThread,
  frame: FinalReplyFrame,
  attempt: number,
  reason: FinalReplyRetryReason,
): Promise<void> {
  await callHook(run, {
    name: "onLLMRetry",
    data: {
      attempt: attempt + 1,
      maxRetries: FINAL_REPLY_RETRIES,
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
export function pushRetryNote(
  thread: MessageThread,
  expiryKey: string,
  reason: FinalReplyRetryReason,
): void {
  thread.push(smoltalk.userMessage(RETRY_NOTE[reason]), null, { at: "request", key: expiryKey });
}

/** Called inside the retried request's step, after the request returns. */
export function advanceRetryAttempt(frame: FinalReplyFrame, attempt: number): void {
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
