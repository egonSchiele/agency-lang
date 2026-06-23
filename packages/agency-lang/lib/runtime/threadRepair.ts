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
 * responses that did return in a partial batch. (The previous implementation
 * truncated back to the last user message, discarding all of that.) A neutral
 * `[Response cancelled.]` breadcrumb is appended so the next turn's model sees
 * the interruption. `messages` is the live, persisted MessageThread (see
 * agencyLlm.llm), so this repair sticks for the next turn.
 */
export function markThreadCancelled(messages: MessageThread): void {
  const all = messages.getMessages();
  let lastAssistant = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i] instanceof smoltalk.AssistantMessage) {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) return; // no assistant turn — thread already valid

  const calls = (all[lastAssistant] as smoltalk.AssistantMessage).toolCalls ?? [];
  const answered = new Set(
    all
      .slice(lastAssistant + 1)
      .filter((m): m is smoltalk.ToolMessage => m instanceof smoltalk.ToolMessage)
      .map((m) => m.tool_call_id),
  );

  const repaired = [...all];
  for (const call of calls) {
    if (!answered.has(call.id)) {
      // Synthetic response — the model sees WHICH tool was cancelled (not a
      // mysterious gap), AND the thread becomes structurally valid for the
      // next provider call, which requires a `tool` reply per `tool_call`.
      repaired.push(
        smoltalk.toolMessage("[Tool call cancelled before completion.]", {
          tool_call_id: call.id,
          name: call.name,
        }),
      );
    }
  }
  repaired.push(smoltalk.assistantMessage("[Response cancelled.]"));
  messages.setMessages(repaired);
}
