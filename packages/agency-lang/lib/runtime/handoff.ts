/**
 * Message plumbing for handoff functions (`handoff def`). When a model
 * calls one as a tool, the tool loop keeps the body on the caller's
 * thread: the tool call is dropped from the assistant message that
 * carried it (providers demand a tool result right after a tool call,
 * and the body's messages land there instead), the body's system
 * messages are tagged with the dispatch's scope key while it runs, and a
 * user-role resume message hands control back when the body returns.
 * These helpers only touch a MessageThread; prompt.ts decides when to
 * call them. See docs/dev/language/handoff-functions.md.
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

/** The scope key one dispatch tags its body's system messages with. The
 *  nesting depth is part of it because a provider that sends no call ids
 *  (Gemini) leaves a handoff nested inside itself with the same name and
 *  the same empty id. Compute it before entering the scope and again after
 *  leaving it; the depth is the same at both points. */
export function handoffScopeKey(
  thread: MessageThread,
  toolName: string,
  toolCallId: string,
): string {
  return `${toolName}:${toolCallId}:${thread.handoffDepth()}`;
}

export function handoffResumeText(toolName: string, body: string): string {
  return `[${toolName} finished. ${body}]\nContinue with the user's request.`;
}

/** The resume message for a handoff that failed or was aborted partway. */
export function handoffStoppedText(toolName: string, reason: string): string {
  return (
    `[${toolName} stopped before finishing: ${reason}]\n` +
    `Its work so far is in the messages above. Continue with the user's request using that work.`
  );
}

/**
 * Drop the tool call from the assistant message that carried the handoff
 * call. Its text stays; a message that was only the call is removed, so
 * the thread reads as the user's request followed by the body's work.
 * Nothing is added in its place: a model that sees dispatch narration in
 * its history learns to write it instead of calling the tool.
 */
export function dropHandoffToolCall(thread: MessageThread): void {
  const messages = thread.getMessages();
  const index = messages.length - 1;
  const last = messages[index];
  if (last === undefined || last.role !== "assistant") {
    throw new Error(
      `handoff: expected the thread to end with the assistant message carrying the tool call, found ${last?.role ?? "an empty thread"}`,
    );
  }
  const text = typeof last.content === "string" ? last.content.trim() : "";
  if (text === "") {
    thread.removeAt(index);
    return;
  }
  thread.replaceAt(index, smoltalk.assistantMessage(text));
}

/**
 * Remove the system messages the body pushed: every message tagged with
 * this dispatch's scope key. Tags survive checkpoints and compaction, and
 * a message compaction summarized away is simply not there to remove.
 */
export function stripHandoffSystemMessages(thread: MessageThread, scopeKey: string): void {
  thread.removeHandoffScoped(scopeKey);
}

/**
 * Close a handoff: remove the body's system messages (its persona is not
 * useful to the caller afterwards and would grow the context on every
 * dispatch), then hand control back with a user-role message that carries
 * the body's result.
 */
export function finishHandoff(args: {
  thread: MessageThread;
  scopeKey: string;
  toolName: string;
  body: string;
}): void {
  stripHandoffSystemMessages(args.thread, args.scopeKey);
  args.thread.push(smoltalk.userMessage(handoffResumeText(args.toolName, args.body)));
}

/** Close a handoff that failed or was aborted. */
export function finishStoppedHandoff(args: {
  thread: MessageThread;
  scopeKey: string;
  toolName: string;
  reason: string;
}): void {
  stripHandoffSystemMessages(args.thread, args.scopeKey);
  args.thread.push(smoltalk.userMessage(handoffStoppedText(args.toolName, args.reason)));
}
