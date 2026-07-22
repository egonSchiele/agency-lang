import * as smoltalk from "smoltalk";
import type { Interrupt } from "./interrupts.js";
import type { MessageThread } from "./state/messageThread.js";
import type { StateStack } from "./state/stateStack.js";
import {
  buildReplyUserMessage,
  type HarvestedReplyAttachment,
} from "./replyAttachments.js";

/**
 * INTERNAL — consumed by prompt.ts only. The public way to inject a message
 * into a running conversation is `MessageThread.queueMessage` (surfaced as
 * `agency.thread.current().queueMessage(...)`); this module is the delivery
 * side. It owns the turn boundary: the safe point between "all tool results
 * are in" and "the next request goes out", where pending messages from
 * every source get pushed with the step-and-snapshot discipline handled
 * once, here, instead of hand-woven per source in prompt.ts.
 *
 * Three sources ("producers") exist, each keeping its own storage and merge
 * rule because those genuinely differ:
 *   - reply attachments: harvested per tool onto runnerState, merged
 *     N-into-1 user message;
 *   - guard feedback: the approver's `approve({message})` text, queued
 *     branch-locally on the stack (an approval in a fork branch must follow
 *     THAT branch's next request), joined into one labeled user message;
 *   - queued messages: `queueMessage` entries on the active thread,
 *     delivered FIFO, roles and labels preserved, never collapsed.
 * Adding a producer is a runtime-maintainer decision; features inject by
 * calling queueMessage, not by registering here.
 */

export type TurnMessage = {
  message: smoltalk.Message;
  label: string | null;
};

export type BoundaryContext = {
  /** The PromptRunner's step method, bound. Injected so this module is
   *  unit-testable with a recording fake. The body's return type matters:
   *  pr.step treats a returned Interrupt[] as "pause here" and stamps a
   *  checkpoint — that is HOW a guard trip suspends the run. */
  step: (
    key: string,
    body: () => Promise<Interrupt[] | void>,
  ) => Promise<void>;
  /** runPrompt's guardGate closure (raiseGuardTripsUntilClear). Its
   *  Interrupt[] return is the pause signal and MUST flow through to
   *  step() unaltered — never wrap this in a void-returning adapter. */
  guardGate: () => Promise<Interrupt[] | void>;
  /** The live conversation of this llm() call. */
  messages: MessageThread;
  /** Per-llm()-call serialized state; home of replyAttachments. */
  runnerState: Record<string, unknown>;
  /** The branch's stack; home of the guard-feedback queue. */
  stateStack: StateStack;
  /** Serializes the given thread into the frame shadow
   *  (self.messagesJSON). Takes the thread as a parameter so the sync
   *  target is explicit rather than a closure over a mutable local. */
  snapshot: (thread: MessageThread) => void;
};

export type TurnMessageProducer = {
  /** Step-key fragment, e.g. "attachReplies". */
  name: string;
  /** Destructive read: return what is pending and clear it at the source.
   *  Runs INSIDE the step, so a replayed-and-skipped step never loses
   *  work. Empty array = nothing this time. */
  take: (bctx: BoundaryContext) => TurnMessage[];
};

export const attachmentsProducer: TurnMessageProducer = {
  name: "attachReplies",
  take: (bctx) => {
    const pending = (bctx.runnerState.replyAttachments ??
      []) as HarvestedReplyAttachment[];
    if (pending.length === 0) return [];
    bctx.runnerState.replyAttachments = [];
    return [
      {
        message: smoltalk.userMessage(
          buildReplyUserMessage(pending) as smoltalk.UserContentInput,
        ),
        label: null,
      },
    ];
  },
};

export const guardFeedbackProducer: TurnMessageProducer = {
  name: "guardFeedback",
  take: (bctx) => {
    const feedback = bctx.stateStack.takeGuardFeedback();
    if (feedback.length === 0) return [];
    // One joined user message, not a run of consecutive user messages —
    // providers want user/assistant alternation. Labels list each
    // contributing guard once, in order. (Transplanted verbatim from the
    // former drainGuardFeedback in prompt.ts.)
    const text = feedback.map((f) => f.text).join("\n");
    const label = feedback
      .map((f) => f.label)
      .filter((l, i, all) => all.indexOf(l) === i)
      .join(",");
    return [{ message: smoltalk.userMessage(text), label }];
  },
};

export const queuedMessagesProducer: TurnMessageProducer = {
  name: "queuedMessages",
  take: (bctx) =>
    bctx.messages.takeQueuedMessages().map((q) => ({
      message:
        q.role === "assistant"
          ? smoltalk.assistantMessage(q.content as string)
          : smoltalk.userMessage(q.content as smoltalk.UserContentInput),
      label: q.label,
    })),
};

/** Deliver one producer's pending messages inside an idempotent step. The
 *  step always opens (uniform emission; cross-version checkpoint
 *  compatibility is not promised); an empty take means the step no-ops —
 *  no push, no snapshot, matching the shipped empty paths. */
export async function drainProducer(
  p: TurnMessageProducer,
  stepKey: string,
  bctx: BoundaryContext,
): Promise<void> {
  await bctx.step(stepKey, async () => {
    const msgs = p.take(bctx);
    if (msgs.length === 0) return;
    for (const m of msgs) {
      bctx.messages.push(m.message, m.label);
    }
    bctx.snapshot(bctx.messages);
  });
}

/** The two-beat figure that appears at four kinds of site in the loop:
 *  raise any pending guard trip, then deliver the approver's feedback.
 *  Keys are passed verbatim — the four sites do not share a naming scheme
 *  and the names are frozen. */
export async function runGateAndFeedback(
  gateKey: string,
  feedbackKey: string,
  bctx: BoundaryContext,
): Promise<void> {
  await bctx.step(gateKey, bctx.guardGate);
  await drainProducer(guardFeedbackProducer, feedbackKey, bctx);
}

/** The full round boundary, in the one canonical order: tool artifacts
 *  first, then queued messages, then the guard machinery gets the last
 *  word before the next request. */
export async function runRoundBoundary(
  round: number,
  bctx: BoundaryContext,
): Promise<void> {
  await drainProducer(attachmentsProducer, `round.${round}.attachReplies`, bctx);
  await drainProducer(
    queuedMessagesProducer,
    `round.${round}.queuedMessages`,
    bctx,
  );
  await runGateAndFeedback(
    `round.${round}.guardGate`,
    `round.${round}.guardFeedback`,
    bctx,
  );
}

/** The call-entry boundary: deliver messages queued before this llm()
 *  call (so a no-tool call still delivers, and queued content precedes
 *  the new prompt — it reviews past work, same positioning as initial
 *  guard feedback), then the gate-and-feedback figure. No attachments
 *  phase: none can exist before the first request. */
export async function runInitialBoundary(
  bctx: BoundaryContext,
): Promise<void> {
  await drainProducer(queuedMessagesProducer, "queuedMessages.initial", bctx);
  await runGateAndFeedback("guardGate.initial", "guardFeedback.initial", bctx);
}
