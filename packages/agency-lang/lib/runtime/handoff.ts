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
import type { StateStack, TurnMarks, TurnScope } from "./state/stateStack.js";
import { isSuccess } from "./result.js";
import { extractStructuredResponse } from "./utils.js";

export type { TurnMarks, TurnScope };

/** The refusal for a handoff call made in the same response as another
 *  handoff call. `names` lists the round's handoff calls, one entry per
 *  call, so a tool called twice appears twice. */
export function tooManyHandoffsMessage(toolName: string, names: string[]): string {
  const distinct = names.filter((name, i) => names.indexOf(name) === i);
  if (distinct.length === 1) {
    return (
      `Error: ${toolName} was not run. It was called ${names.length} times in this response, and only one call can run per response. ` +
      `Call it once in a new response.`
    );
  }
  return (
    `Error: ${toolName} was not run. ${joinNames(distinct)} were called in the same response, and only one of them can run per response. ` +
    `Call one of them again in a new response.`
  );
}

/** The text for a handoff whose round stopped before it could start,
 *  for example when a guard trip was rejected. It answers the handoff's
 *  tool call, which would otherwise be left without a result. */
export function handoffNotStartedMessage(toolName: string, reason: string): string {
  return `Error: ${toolName} was not run. The run stopped before it could start: ${reason}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
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
 * it: the last assistant message on the thread. The other calls in the
 * round have run by now, so their tool results, and any guard feedback,
 * may follow that message. `call.index` is the call's position in the
 * message's tool calls.
 *
 * When other calls remain, only this one is removed, so their tool
 * results still pair with them. When it was the only call, its text
 * stays and a message that was only the call is removed, so the thread
 * reads as the user's request followed by the body's work.
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

// ---------------------------------------------------------------------------
// Ending the turn from a tool (std::thread.endTurn and handBack). The
// functions below make every decision the feature needs; prompt.ts calls
// them and stores what they return. See docs/dev/language/handoff-functions.md.

/** A marked handoff's hand-back, held until the round's decision step
 *  knows whether the turn ends. */
export type DeferredHandBack = { scopeKey: string; body: string; message: string | null };

/** One marked call, kept in runnerState.turnMarks[round][callIndex]. Only
 *  calls that set something are recorded, and the answer value only when
 *  endTurn is set: runnerState rides in every later checkpoint. */
export type TurnMark = {
  toolName: string;
  isHandoff: boolean;
  endTurn: boolean;
  scope: TurnScope;
  message: string | null;
  /** The answer value; present only when endTurn is set. */
  value?: unknown;
  /** Set when a marked handoff deferred its hand-back message. */
  deferredHandBack: DeferredHandBack | null;
};

/** The value a tool answered with: unwrapped from success(), as the model
 *  sees it, but without the "ran successfully" placeholder the tool loop
 *  substitutes for a missing value. A tool that returned nothing answers
 *  null, which is not a string, so it never ends the turn. */
export function answerValueOf(rawToolResult: unknown): unknown {
  if (rawToolResult === undefined) {
    return null;
  }
  if (isSuccess(rawToolResult)) {
    return rawToolResult.value ?? null;
  }
  return rawToolResult;
}

/** How a handoff's body finished, from the tool loop's point of view. */
export type HandoffOutcome =
  | { kind: "success"; body: string }
  | { kind: "stopped"; reason: string }
  | { kind: "rejected"; body: string };

/**
 * Close a handoff: strip the body's system messages, then hand control
 * back with a user-role message, or defer that message when the handoff
 * asked to end the turn. The custom text from handBack replaces the
 * default when the outcome allows it: never for a rejection, whose text
 * tells the model the user said no, and never when empty, because a
 * follow-up request needs a user-role message in front of it. Returns
 * the deferred record for the decision step, or null when the message
 * was pushed here.
 */
export function closeHandoff(args: {
  thread: MessageThread;
  scopeKey: string;
  toolName: string;
  outcome: HandoffOutcome;
  marks: TurnMarks;
  warn: (message: string) => void;
}): DeferredHandBack | null {
  const { thread, scopeKey, toolName, outcome, marks, warn } = args;
  stripHandoffSystemMessages(thread, scopeKey);
  const message = customHandBackMessage(toolName, outcome, marks, warn);
  if (outcome.kind === "success" && marks.endTurn) {
    return { scopeKey, body: outcome.body, message };
  }
  thread.push(smoltalk.userMessage(message ?? defaultHandBackText(toolName, outcome)));
  return null;
}

function customHandBackMessage(
  toolName: string,
  outcome: HandoffOutcome,
  marks: TurnMarks,
  warn: (message: string) => void,
): string | null {
  if (marks.message === null) {
    return null;
  }
  if (marks.message === "") {
    warn(`${toolName}: handBack("") ignored; the hand-back message cannot be empty`);
    return null;
  }
  if (outcome.kind === "rejected") {
    warn(`${toolName}: handBack ignored; the handoff was rejected and the model must see the rejection`);
    return null;
  }
  return marks.message;
}

function defaultHandBackText(toolName: string, outcome: HandoffOutcome): string {
  if (outcome.kind === "stopped") {
    return handoffStoppedText(toolName, outcome.reason);
  }
  return handoffResumeText(toolName, outcome.body);
}

export type EndTurnDecision =
  | { kind: "end"; callIndex: number; scope: TurnScope; answerText: string; returnValue: unknown }
  | { kind: "continue" };

const CONTINUE: EndTurnDecision = { kind: "continue" };

type IndexedMark = { callIndex: number; mark: TurnMark };

/**
 * Decide from a round's recorded marks whether the turn ends. A mark
 * counts only when its call was the last to run in the round, since only
 * then has the tool seen everything the model asked for: a handoff (it
 * runs alone after the others), or an ordinary tool that was the round's
 * only call that ran. Then the value has to fit what llm() returns: the
 * caller's structured output type, or a string. Calls `warn` once per
 * mark that is dropped or falls back, naming the tool and the reason.
 */
export function decideEndTurn(args: {
  marks: Record<number, TurnMark>;
  /** Dispatch indexes of the calls that ran (success, failure, or rejection). */
  ranCallIndexes: number[];
  responseFormat: unknown;
  pendingAttachments: number;
  warn: (message: string) => void;
}): EndTurnDecision {
  const { marks, ranCallIndexes, responseFormat, pendingAttachments, warn } = args;
  const entries: IndexedMark[] = Object.entries(marks).map(([index, mark]) => ({
    callIndex: Number(index),
    mark,
  }));
  for (const { mark } of entries) {
    if (mark.message !== null && !mark.isHandoff) {
      warn(`${mark.toolName}: handBack ignored; only a handoff hands back`);
    }
  }
  const ranLast = (entry: IndexedMark): boolean =>
    entry.mark.isHandoff || (ranCallIndexes.length === 1 && ranCallIndexes[0] === entry.callIndex);
  const marked = entries.filter((entry) => entry.mark.endTurn);
  const counting = marked.filter(ranLast);
  for (const { mark } of marked.filter((entry) => !ranLast(entry))) {
    warn(`${mark.toolName}: endTurn ignored; it ran beside other tool calls in the same response`);
  }
  if (counting.length === 0) {
    return CONTINUE;
  }
  if (counting.length > 1) {
    // Unreachable by construction (one handoff per round, an ordinary
    // tool counts only alone), kept as a backstop against guessing.
    warn(`endTurn ignored; ${counting.length} tool calls in one response asked to end the turn`);
    return CONTINUE;
  }
  const { callIndex, mark } = counting[0];
  const ignored = (reason: string): EndTurnDecision => {
    warn(`${mark.toolName}: endTurn ignored; ${reason}`);
    return CONTINUE;
  };
  if (pendingAttachments > 0) {
    return ignored("a reply attachment is waiting to be delivered");
  }
  const value = mark.value;
  if (mark.message !== null) {
    warn(`${mark.toolName}: handBack ignored; the turn ended`);
  }
  if (responseFormat) {
    const extracted = extractStructuredResponse(value, responseFormat);
    if (!isSuccess(extracted)) {
      return ignored("the value does not match the caller's structured output");
    }
    return { kind: "end", callIndex, scope: mark.scope, answerText: answerTextOf(value), returnValue: extracted.value };
  }
  if (typeof value !== "string") {
    return ignored("the value is not a string");
  }
  return { kind: "end", callIndex, scope: mark.scope, answerText: value, returnValue: value };
}

function answerTextOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The record the tool loop keeps in runnerState.turnEnded[round]. */
export type TurnEnded = { ended: true; returnValue: unknown } | { ended: false };

/**
 * Apply a decision to the thread. On "end", make the thread end with the
 * answer, and when the scope is "turn" and this llm() call runs inside a
 * tool body, re-mark that body's stack so the enclosing loop ends too. On
 * "continue", push every deferred hand-back, so the follow-up request has
 * its user-role message. Returns the record for runnerState.
 */
export function applyEndTurnDecision(args: {
  thread: MessageThread;
  decision: EndTurnDecision;
  marks: Record<number, TurnMark>;
  /** The stack of the tool body this llm() runs in, or null at the top level. */
  enclosingStack: StateStack | null;
}): TurnEnded {
  const { thread, decision, marks, enclosingStack } = args;
  if (decision.kind === "continue") {
    for (const mark of Object.values(marks)) {
      if (mark.deferredHandBack !== null) {
        const { body, message } = mark.deferredHandBack;
        thread.push(smoltalk.userMessage(message ?? handoffResumeText(mark.toolName, body)));
      }
    }
    return { ended: false };
  }
  endThreadWithAnswer(thread, decision.answerText);
  if (decision.scope === "turn" && enclosingStack !== null) {
    enclosingStack.markTurn("turn");
  }
  return { ended: true, returnValue: decision.returnValue };
}

/**
 * Make the thread end with the answer the user sees, as an assistant
 * message. A trailing assistant message that carries no tool calls is
 * replaced: it is the body's structured reply, or the caller's own text
 * left by dropHandoffToolCall, and keeping it would put two assistant
 * messages in a row, which the Anthropic client merges into one that
 * reads as JSON followed by prose. Anything else (a tool message, the
 * user's request) is followed by a push.
 */
export function endThreadWithAnswer(thread: MessageThread, answerText: string): void {
  const messages = thread.getMessages();
  const index = messages.length - 1;
  const last = messages[index];
  const answer = smoltalk.assistantMessage(answerText);
  if (last !== undefined && last.role === "assistant" && !carriesToolCalls(last)) {
    thread.replaceAt(index, answer);
    return;
  }
  thread.push(answer);
}

function carriesToolCalls(message: smoltalk.Message): boolean {
  const json = (message as smoltalk.AssistantMessage).toJSON();
  return (json.toolCalls ?? []).length > 0;
}
