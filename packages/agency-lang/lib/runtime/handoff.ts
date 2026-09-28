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

/** The refusal for a handoff call made in the same round as another
 *  handoff call. `names` lists every handoff tool the round called. */
export function tooManyHandoffsMessage(toolName: string, names: string[]): string {
  return (
    `Error: ${toolName} was not run. It continues this conversation, and this response called more than one tool that does (${names.join(", ")}). ` +
    `Only one of them can run per round. Call one of them again in a new response. Other tools may be called alongside it.`
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
 * Drop the handoff's tool call from the assistant message that carried
 * it. `callIndex` is the call's position in that message's tool calls.
 *
 * The handoff runs after every other call in its round, so the thread
 * may end on those calls' tool results, and on the guard feedback
 * delivered just before the handoff, rather than on the assistant
 * message itself. That message is the last assistant message on the
 * thread.
 *
 * When other calls remain, only this one is removed, so the tool
 * results that follow still pair with their calls. When it was the only
 * call, its text stays and a message that was only the call is removed,
 * so the thread reads as the user's request followed by the body's work.
 * Nothing is added in its place: a model that sees dispatch narration in
 * its history learns to write it instead of calling the tool.
 */
export function dropHandoffToolCall(
  thread: MessageThread,
  call: { index: number; id: string; name: string },
): void {
  const messages = thread.getMessages();
  const index = messages.findLastIndex((message) => message.role === "assistant");
  if (index === -1) {
    throw new Error("handoff: expected an assistant message carrying the tool call, found none");
  }
  const carrier = messages[index] as smoltalk.AssistantMessage;
  const json = carrier.toJSON();
  const calls = json.toolCalls ?? [];
  const target = calls[call.index];
  if (target === undefined || target.name !== call.name || target.id !== call.id) {
    throw new Error(
      `handoff: expected tool call ${call.index} of the last assistant message to be ${call.name} (${call.id})`,
    );
  }
  const siblings = calls.filter((_, i) => i !== call.index);
  if (siblings.length > 0) {
    thread.replaceAt(index, smoltalk.AssistantMessage.fromJSON({ ...json, toolCalls: siblings }));
    return;
  }
  const text = typeof carrier.content === "string" ? carrier.content.trim() : "";
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
