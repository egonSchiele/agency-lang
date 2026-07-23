import * as smoltalk from "smoltalk";
import type { AbortCause } from "./errors.js";
import type { MessageThread } from "./state/messageThread.js";

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
