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
 * Rewrite the assistant message that carried the handoff tool call: keep
 * its text, drop the tool call, append the marker. Returns the thread
 * length afterwards, which is the index of the first message the body
 * will push.
 */
export function applyHandoffMarker(
  thread: MessageThread,
  toolName: string,
  args: Record<string, unknown>,
): number {
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
  return messages.length;
}

/**
 * Close a handoff: remove the system messages the body pushed (its
 * persona is not useful to the caller afterwards and would grow the
 * context on every dispatch), then hand control back with a user-role
 * message that carries the body's result. A system message has no
 * partner to unpair, which is what makes removing it safe.
 */
export function finishHandoff(
  thread: MessageThread,
  startIndex: number,
  toolName: string,
  body: string,
): void {
  thread.removeMatching(startIndex, (message) => message.role === "system");
  thread.push(smoltalk.userMessage(handoffResumeText(toolName, body)));
}
