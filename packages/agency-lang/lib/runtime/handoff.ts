/**
 * Message plumbing for handoff functions (`handoff def`). When a model
 * calls one as a tool, the tool loop keeps the body on the caller's
 * thread and replaces the tool-call bookkeeping with two plain messages:
 * an assistant-role marker where the tool call was, and a user-role
 * resume message when the body returns. These helpers only touch a
 * MessageThread; prompt.ts decides when to call them. See
 * docs/dev/language/handoff-functions.md.
 */
import * as smoltalk from "smoltalk";
import type { MessageThread } from "./state/messageThread.js";

/** The refusal for a handoff call that shares a round with another call. */
export function handoffNotAloneMessage(toolName: string): string {
  return (
    `Error: ${toolName} continues this conversation, so it must be the only tool call in its round. ` +
    `It was not run. Call it again by itself, with no other tool calls in the same response.`
  );
}

export function handoffMarkerText(toolName: string, args: Record<string, unknown>): string {
  return `[dispatching ${toolName}: ${JSON.stringify(args)}]`;
}

export function handoffResumeText(toolName: string, body: string): string {
  return `[${toolName} finished. ${body}]\nContinue with the user's request.`;
}

/**
 * The resume message for a handoff that failed or was aborted partway.
 * A handoff leaves everything it did on the caller's thread, so the
 * caller is told where that work is and to carry on from it.
 */
export function handoffStoppedText(toolName: string, reason: string): string {
  return (
    `[${toolName} stopped before finishing: ${reason}]\n` +
    `Its work so far is in the messages above, from the line where it was dispatched onward. ` +
    `Continue with the user's request using that work, and say what is unfinished.`
  );
}

/**
 * Rewrite the assistant message that carried the handoff tool call: keep
 * its text, drop the tool call, append the marker.
 */
export function applyHandoffMarker(
  thread: MessageThread,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const messages = thread.getMessages();
  const index = messages.length - 1;
  const last = messages[index];
  if (last === undefined || last.role !== "assistant") {
    throw new Error(
      `handoff: expected the thread to end with the assistant message carrying the tool call, found ${last?.role ?? "an empty thread"}`,
    );
  }
  const text = typeof last.content === "string" ? last.content.trim() : "";
  const marker = handoffMarkerText(toolName, args);
  const content = text === "" ? marker : `${text}\n\n${marker}`;
  thread.replaceAt(index, smoltalk.assistantMessage(content));
}

/** The index of this dispatch's marker, searching from the end so the
 *  newest dispatch of a tool wins. -1 when memory compaction has
 *  summarized the marker away. */
function markerIndex(
  thread: MessageThread,
  toolName: string,
  args: Record<string, unknown>,
): number {
  const marker = handoffMarkerText(toolName, args);
  const messages = thread.getMessages();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.endsWith(marker)
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Remove the system messages the body pushed: every system message after
 * this dispatch's marker. Anchored on the marker rather than on a recorded
 * position because memory compaction rewrites the thread and shifts every
 * index. A marker that compaction summarized away took the body's earlier
 * system messages with it, so there is nothing left to remove.
 */
export function stripHandoffSystemMessages(
  thread: MessageThread,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const index = markerIndex(thread, toolName, args);
  if (index === -1) {
    return;
  }
  thread.removeMatching(index + 1, (message) => message.role === "system");
}

/**
 * Close a handoff: remove the body's system messages (its persona is not
 * useful to the caller afterwards and would grow the context on every
 * dispatch), then hand control back with a user-role message that carries
 * the body's result.
 */
export function finishHandoff(
  thread: MessageThread,
  toolName: string,
  args: Record<string, unknown>,
  body: string,
): void {
  stripHandoffSystemMessages(thread, toolName, args);
  thread.push(smoltalk.userMessage(handoffResumeText(toolName, body)));
}

/** Close a handoff that failed or was aborted: same cleanup as
 *  finishHandoff, but the resume message says the work is above. */
export function finishStoppedHandoff(
  thread: MessageThread,
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
): void {
  stripHandoffSystemMessages(thread, toolName, args);
  thread.push(smoltalk.userMessage(handoffStoppedText(toolName, reason)));
}
