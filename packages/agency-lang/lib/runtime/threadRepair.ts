import * as smoltalk from "smoltalk";
import { agencyStore } from "./asyncContext.js";
import type { AbortCause } from "./errors.js";
import { MessageThread } from "./state/messageThread.js";
import type { MessageThreadJSON } from "./state/messageThread.js";

/**
 * Thread repair after a hard cancellation, extracted from prompt.ts so the
 * prompt execution loop stays focused. `needsThreadRepair` is the single
 * source of truth for WHEN to repair; `markThreadCancelled` does the repair.
 */

/** Thread repair (stubbing a dangling assistant tool-call turn) is only
 *  needed for a user-initiated cancel mid-LLM-turn. A guard trip or a
 *  race-loser abort doesn't leave the thread mid-tool-call in a way the
 *  next user turn would choke on, and repairing then would discard a turn
 *  the guard's Failure path still wants intact. Unknown / absent causes
 *  default to repair (conservative: matches pre-cause behavior). This is
 *  the single source of truth for the repair policy — future cause variants
 *  (connectionLost, callTimeout) decide their policy HERE, not at the catch
 *  site. */
export function needsThreadRepair(cause: AbortCause | undefined): boolean {
  if (cause === undefined) return true;
  return cause.kind === "userInterrupt" || cause.kind === "userKill";
}

export type DanglingToolCall = { id: string; name: string };

/** The trailing assistant turn's tool calls that have no ToolMessage
 *  answering them — the only structurally invalid shape a mid-round stop
 *  can leave (every earlier round is complete, or the tool loop would not
 *  have advanced past it). Deliberately NOT a whole-thread validity check;
 *  do not reach for it as one. Empty when the tail is valid or there is
 *  no assistant turn at all. */
export function unansweredToolCalls(
  messages: MessageThread,
): DanglingToolCall[] {
  const all = messages.getMessages();
  const lastAssistant = all.findLastIndex(
    (m) => m instanceof smoltalk.AssistantMessage,
  );
  if (lastAssistant === -1) return [];
  const calls =
    (all[lastAssistant] as smoltalk.AssistantMessage).toolCalls ?? [];
  const answeredIds = all
    .slice(lastAssistant + 1)
    .filter(
      (m): m is smoltalk.ToolMessage => m instanceof smoltalk.ToolMessage,
    )
    .map((m) => m.tool_call_id);
  return calls.filter((c) => !answeredIds.includes(c.id));
}

function hasAssistantTurn(messages: MessageThread): boolean {
  return messages
    .getMessages()
    .some((m) => m instanceof smoltalk.AssistantMessage);
}

type RepairWording = { perCall: string; breadcrumb: string };

/** The one append procedure every repair shares: stub each dangling call,
 *  then leave a breadcrumb assistant message. Appends via `push`, so
 *  per-message debug labels on existing messages survive. Only the
 *  wording varies between repairs; the policy of WHEN to run lives in the
 *  named repair functions. */
function appendRepair(
  messages: MessageThread,
  dangling: DanglingToolCall[],
  wording: RepairWording,
): void {
  for (const call of dangling) {
    // Synthetic response — the model sees WHICH tool was cut off (not a
    // mysterious gap), AND the thread becomes structurally valid for the
    // next provider call, which requires a `tool` reply per `tool_call`.
    messages.push(
      smoltalk.toolMessage(wording.perCall, {
        tool_call_id: call.id,
        name: call.name,
      }),
    );
  }
  messages.push(smoltalk.assistantMessage(wording.breadcrumb));
}

/**
 * Leave a thread in a role-valid state after a hard cancellation
 * (AgencyCancelledError / abort). A cancel can land mid-tool-round, so the
 * thread may end on an assistant turn with unanswered `tool_calls` — which
 * some providers reject on the next call.
 *
 * Repair is NON-DESTRUCTIVE: the only structurally invalid state a mid-turn
 * cancel can leave is "trailing assistant with unanswered tool_calls". Every
 * EARLIER assistant turn already has its tool responses (otherwise the
 * runPrompt loop would not have advanced past it), so we synthesize ONLY the
 * specific `tool` messages the trailing assistant is missing — preserving
 * earlier complete rounds, the dangling assistant's text body, and any tool
 * responses that did return in a partial batch. A neutral
 * `[Response cancelled.]` breadcrumb is appended so the next turn's model sees
 * the interruption. `messages` is the live, persisted MessageThread (see
 * agencyLlm.llm), so this repair sticks for the next turn. Appends via
 * `push`, so per-message debug labels survive. Returns the calls it stubbed
 * (its sibling `repairAbandonedTurn` shares the contract).
 */
export function markThreadCancelled(
  messages: MessageThread,
): DanglingToolCall[] {
  if (!hasAssistantTurn(messages)) return []; // nothing sent yet — already valid
  const dangling = unansweredToolCalls(messages);
  appendRepair(messages, dangling, {
    perCall: "[Tool call cancelled before completion.]",
    breadcrumb: "[Response cancelled.]",
  });
  return dangling;
}

export const ABANDONED_CALL_TEXT =
  "[Tool call interrupted; the turn was never resumed.]";
export const ABANDONED_TURN_TEXT =
  "[The previous turn was interrupted before it finished.]";

/** Repair a thread whose previous turn parked on an unanswered interrupt
 *  and was then abandoned (the user started a new turn instead of
 *  answering). Distinct wording from `markThreadCancelled` on purpose:
 *  nobody cancelled anything, so the breadcrumb tells the next turn's
 *  model the work was interrupted — it can offer to pick it back up.
 *  Bumps the thread's repair generation so a late restore of the
 *  abandoned turn's checkpoint is refused instead of clobbering the
 *  thread — see `restoreThreadForResume`. Total no-op on a valid
 *  thread. */
export function repairAbandonedTurn(
  messages: MessageThread,
): DanglingToolCall[] {
  const dangling = unansweredToolCalls(messages);
  if (dangling.length === 0) return [];
  appendRepair(messages, dangling, {
    perCall: ABANDONED_CALL_TEXT,
    breadcrumb: ABANDONED_TURN_TEXT,
  });
  messages.markRepaired();
  return dangling;
}

export type ThreadRepairedSink = {
  threadRepaired?: (event: {
    threadId: string;
    toolCallIds: string[];
  }) => Promise<void> | void;
};

/** Everything the reopen seam needs, so `Runner.thread()` stays one line.
 *
 *  A reopen (session second+ entry, or `thread(continue: id)`) means the
 *  previous turn on this thread stopped mattering — at least for the
 *  REPL, where a parked turn blocks the loop, so a reopen implies
 *  abandonment. (Within a single run a reopen from a second step path is
 *  also possible; it is harmless here because a healthy in-run thread
 *  has no dangling tail.) If the abandoned turn parked mid-tool-round,
 *  the thread still ends on an assistant message with unanswered tool
 *  calls — a shape the provider rejects outright, which would otherwise
 *  poison every later request on this session.
 *
 *  Safe at the reopen seam and ONLY there: a checkpoint resume of a
 *  parked turn never reaches it — `Runner.thread()` guards the open side
 *  effect behind `frame.locals[threadKey]`, which is restored with the
 *  checkpoint, and `restoreBranchView` reinstates the active stack by
 *  direct assignment. If either mechanism changes, this repair would
 *  start firing mid-resume; the resume-re-entry test in runner.test.ts
 *  exists to catch exactly that. */
export function repairReopenedThread(
  thread: MessageThread | undefined,
  statelog: ThreadRepairedSink | undefined,
  tid: string,
): void {
  if (!thread) return;
  const repaired = repairAbandonedTurn(thread);
  if (repaired.length === 0) return;
  void statelog?.threadRepaired?.({
    threadId: `t${tid}`,
    toolCallIds: repaired.map((c) => c.id),
  });
}

/** Rebuild the message thread when resuming from a checkpoint.
 *
 *  On resume the caller's `live` thread must stay ALIASED — mutations
 *  during the resumed run (tool responses, the final assistant message)
 *  must propagate to every other holder of the thread. So the restored
 *  JSON is written INTO `live` via `adoptFrom` rather than swapping in a
 *  fresh object (and adoptFrom, not setMessages: setMessages takes only
 *  the messages and would drop the labels fromJSON just restored). On a
 *  normal resume this is a no-op overwrite: both sides were captured in
 *  the same checkpoint.
 *
 *  The exception is a checkpoint that predates a repair of the live
 *  thread. Once `repairAbandonedTurn` has run, the parked turn that took
 *  this snapshot was abandoned and newer turns may exist; restoring would
 *  overwrite all of it. Refusing loudly is correct. The generation check
 *  MUST run before `adoptFrom` — adoptFrom copies the snapshot's (lower)
 *  generation onto the live thread, so checking after would always pass.
 *  The ordering is pinned by tests. */
export function restoreThreadForResume(
  snapshot: MessageThreadJSON | smoltalk.MessageJSON[],
  live: MessageThread | undefined,
): MessageThread {
  const restored = MessageThread.fromJSON(snapshot);
  if (!live) return restored;
  if (live.isNewerThan(restored)) {
    const msg =
      "Cannot resume this turn: its conversation thread was repaired after " +
      "this checkpoint was taken (the parked turn was abandoned and newer " +
      "turns have run since). Restoring would overwrite the newer " +
      "conversation, so it is refused.";
    // Best-effort statelog BEFORE the throw: a throw converts to a Failure
    // at the next def boundary, and Failures can get laundered into prose
    // by the time a model or user sees them — the refusal must stay
    // findable in the trace regardless. Same rationale and shape as
    // claimFrameForScope in state/stateStack.ts.
    agencyStore.getStore()?.ctx?.statelogClient?.error?.({
      errorType: "runtimeError",
      message: msg,
      functionName: "restoreThreadForResume",
    });
    throw new Error(msg);
  }
  live.adoptFrom(restored);
  return live;
}
