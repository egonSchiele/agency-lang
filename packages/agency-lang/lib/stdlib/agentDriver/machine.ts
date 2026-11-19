// What the session run does next. A pure reducer over one phase. It does
// not build a transcript: it reports what happened, and each front-end
// shows that its own way. See docs/dev/agents/session-driver.md.
import type { Interrupt, InterruptResponse } from "../../runtime/interrupts.js";
import type { Policy } from "../../runtime/policy.js";
import { approve } from "../../runtime/interruptResponse.js";
import type { Result } from "../../types/result.js";
import {
  currentApproval,
  declineUndecided,
  respondWith,
  startQueue,
  type ApprovalQueue,
  type QueueStep,
  type Settle,
} from "./approvals.js";
import {
  messageAnswer,
  pauseData,
  type Answer,
  type PauseData,
  type SettingsAnswer,
} from "./interface.js";
import { withCancelNote, type AgentStep } from "./run.js";

/** One resume of the run: the interrupts it answers and the answers. */
export type Leg = { interrupts: Interrupt[]; responses: InterruptResponse[] };

/** Where the session is. `pause` is the pause the current turn started
 *  from, so a cancel or a failure can go back to it. `text` is the
 *  person's message for the turn, as typed. `cancelledTexts` are the
 *  requests cancelled since the last turn that finished.
 *
 *  `answering` is a settings change on its way into the run. It is not a
 *  turn: the run applies it and pauses again. Only a `compact` calls a
 *  model, for its summary. */
export type DriverPhase =
  | { kind: "starting" }
  | { kind: "waitingForUser"; pause: Interrupt[]; cancelledTexts: string[] }
  | { kind: "working"; pause: Interrupt[]; text: string; cancelledTexts: string[]; leg: Leg }
  | {
      kind: "approving";
      pause: Interrupt[];
      text: string;
      cancelledTexts: string[];
      queue: ApprovalQueue;
    }
  | { kind: "answering"; pause: Interrupt[]; cancelledTexts: string[]; answer: Answer; leg: Leg }
  | { kind: "ended"; reason: string };

/** What a front-end shows for a step the machine took. */
export type Happened =
  | { type: "submitted"; text: string }
  | { type: "turnCancelled" }
  // A turn ran to its end: the run waits for a message again. A settings
  // change that comes back reports `answered` instead.
  | { type: "turnFinished" }
  | { type: "legFailed"; error: string }
  | { type: "startFailed"; error: string }
  // An approval answered without asking. `by` says what answered it.
  | { type: "settled"; interrupt: Interrupt; response: InterruptResponse; by: "rule" }
  | { type: "answered"; before: PauseData | null; after: PauseData | null }
  // A loaded session runs under a policy of its own (`restoredPhase`).
  // The front-end shows what it approves before the first leg.
  | { type: "carriedPolicy"; policy: Policy };

export type DriverAction =
  | { type: "submitted"; text: string }
  // A change to the chat's settings, as the answer the core takes for it.
  // Taken only while the run waits for a message.
  | { type: "answered"; answer: SettingsAnswer }
  // The answer to the approval showing. `interruptId` is the one the
  // person answered: an answer for any other (a repeated key that arrives
  // after the next prompt is up) is ignored. `settle` then answers the
  // approvals after it that a rule decides.
  | { type: "decided"; response: InterruptResponse; interruptId: string; settle: Settle }
  // A call into the run came back. `settle` answers the approvals of a
  // new pause that a rule decides.
  | { type: "legFinished"; result: Result<AgentStep>; settle: Settle }
  // The person cancelled at an approval prompt. No leg is running, so
  // nothing is aborted: the turn is dropped, as an aborted one is.
  | { type: "approvalCancelled" }
  // No one can be asked: every approval still open is declined, with the
  // reason `reasonFor` gives for it.
  | {
      type: "undecidedDeclined";
      reasonFor: (interrupt: Interrupt) => string;
      settle: Settle;
    };

export type DriverStep = { phase: DriverPhase; happened: Happened[] };

type WorkingPhase = Extract<DriverPhase, { kind: "working" }>;
type AnsweringPhase = Extract<DriverPhase, { kind: "answering" }>;
type ApprovingPhase = Extract<DriverPhase, { kind: "approving" }>;
type WaitingPhase = Extract<DriverPhase, { kind: "waitingForUser" }>;
/** A turn in progress: running a leg, or paused at an approval. */
type TurnPhase = WorkingPhase | ApprovingPhase;
type Turn = Pick<TurnPhase, "pause" | "text" | "cancelledTexts">;

export const initialPhase: DriverPhase = { kind: "starting" };

function unchanged(phase: DriverPhase): DriverStep {
  return { phase, happened: [] };
}

function settledHappened(step: QueueStep): Happened[] {
  return step.settled.map(({ interrupt, response, by }) => ({
    type: "settled",
    interrupt,
    response,
    by,
  }));
}

function submit(phase: WaitingPhase, text: string): DriverStep {
  const message = withCancelNote({ message: text, cancelledTexts: phase.cancelledTexts });
  return {
    phase: {
      kind: "working",
      pause: phase.pause,
      text,
      cancelledTexts: phase.cancelledTexts,
      leg: { interrupts: phase.pause, responses: [approve(messageAnswer(message))] },
    },
    happened: [{ type: "submitted", text }],
  };
}

/** Sends the change into the run. The requests cancelled so far are kept,
 *  so the next message still says they were cancelled. */
function answerWith(phase: WaitingPhase, answer: SettingsAnswer): DriverStep {
  return unchanged({
    kind: "answering",
    pause: phase.pause,
    cancelledTexts: phase.cancelledTexts,
    answer,
    leg: { interrupts: phase.pause, responses: [approve(answer)] },
  });
}

function unexpected(result: Result<AgentStep>): string {
  return result.success ? `unexpected ${result.value.kind}` : result.error;
}

/** The run came back from a settings change. When it paused again, the
 *  front-end is told what it reported before and after, and shows what
 *  changed. When the core refused the change it reports the same, and it
 *  has already said why in a notice of its own. */
function answerFinished(phase: AnsweringPhase, result: Result<AgentStep>): DriverStep {
  const { cancelledTexts } = phase;
  if (result.success && result.value.kind === "waitingForUser") {
    const pause = result.value.interrupts;
    return {
      phase: { kind: "waitingForUser", pause, cancelledTexts },
      happened: [{ type: "answered", before: pauseData(phase.pause), after: pauseData(pause) }],
    };
  }
  const waiting: WaitingPhase = { kind: "waitingForUser", pause: phase.pause, cancelledTexts };
  if (result.success && result.value.kind === "cancelled") {
    return unchanged(waiting);
  }
  return { phase: waiting, happened: [{ type: "legFailed", error: unexpected(result) }] };
}

/** Resume at once when every approval is answered; otherwise ask. */
function toApprovalOrWork(turn: Turn, step: QueueStep): DriverStep {
  const { queue } = step;
  const happened = settledHappened(step);
  if (currentApproval(queue) === null) {
    const leg: Leg = { interrupts: queue.interrupts, responses: queue.responses };
    return { phase: { kind: "working", ...turn, leg }, happened };
  }
  return { phase: { kind: "approving", ...turn, queue }, happened };
}

function turnOf(phase: TurnPhase): Turn {
  return { pause: phase.pause, text: phase.text, cancelledTexts: phase.cancelledTexts };
}

/** Drops the turn: the run goes back to the pause it started from, and the
 *  next message says this request was cancelled. */
function cancelTurn(phase: TurnPhase): DriverStep {
  const cancelledTexts = [...phase.cancelledTexts, phase.text];
  return {
    phase: { kind: "waitingForUser", pause: phase.pause, cancelledTexts },
    happened: [{ type: "turnCancelled" }],
  };
}

function legSucceeded(args: { phase: WorkingPhase; step: AgentStep; settle: Settle }): DriverStep {
  const { phase, step, settle } = args;
  switch (step.kind) {
    case "waitingForUser":
      return {
        phase: { kind: "waitingForUser", pause: step.interrupts, cancelledTexts: [] },
        happened: [{ type: "turnFinished" }],
      };
    case "needsApproval":
      return toApprovalOrWork(turnOf(phase), startQueue({ interrupts: step.interrupts, settle }));
    case "cancelled":
      return cancelTurn(phase);
  }
}

/** A leg that failed goes back to the pause the turn started from. */
function legFinished(args: {
  phase: WorkingPhase;
  result: Result<AgentStep>;
  settle: Settle;
}): DriverStep {
  const { phase, result, settle } = args;
  if (result.success) {
    return legSucceeded({ phase, step: result.value, settle });
  }
  const back: WaitingPhase = {
    kind: "waitingForUser",
    pause: phase.pause,
    cancelledTexts: phase.cancelledTexts,
  };
  return { phase: back, happened: [{ type: "legFailed", error: result.error }] };
}

function startFinished(result: Result<AgentStep>): DriverStep {
  if (result.success && result.value.kind === "waitingForUser") {
    const pause = result.value.interrupts;
    return unchanged({ kind: "waitingForUser", pause, cancelledTexts: [] });
  }
  const error = result.success
    ? `unexpected ${result.value.kind} before the first message`
    : result.error;
  return {
    phase: { kind: "ended", reason: `Could not start the agent: ${error}` },
    happened: [{ type: "startFailed", error }],
  };
}

function decide(
  phase: ApprovingPhase,
  action: Extract<DriverAction, { type: "decided" }>,
): DriverStep {
  if (currentApproval(phase.queue)?.interruptId !== action.interruptId) {
    return unchanged(phase);
  }
  const { response, settle } = action;
  return toApprovalOrWork(turnOf(phase), respondWith({ queue: phase.queue, response, settle }));
}

function declineAll(
  phase: ApprovingPhase,
  action: Extract<DriverAction, { type: "undecidedDeclined" }>,
): DriverStep {
  const { reasonFor, settle } = action;
  return toApprovalOrWork(
    turnOf(phase),
    declineUndecided({ queue: phase.queue, settle, reasonFor }),
  );
}

function finished(
  phase: DriverPhase,
  action: Extract<DriverAction, { type: "legFinished" }>,
): DriverStep {
  switch (phase.kind) {
    case "starting":
      return startFinished(action.result);
    case "answering":
      return answerFinished(phase, action.result);
    case "working":
      return legFinished({ phase, result: action.result, settle: action.settle });
    default:
      return unchanged(phase);
  }
}

/** The one place that decides what the run does next. An action that does
 *  not apply to the current phase changes nothing and reports nothing,
 *  which makes a double Enter or a stray answer harmless. */
export function reduceDriver(phase: DriverPhase, action: DriverAction): DriverStep {
  switch (action.type) {
    case "submitted":
      return phase.kind === "waitingForUser" ? submit(phase, action.text) : unchanged(phase);
    case "answered":
      return phase.kind === "waitingForUser" ? answerWith(phase, action.answer) : unchanged(phase);
    case "decided":
      return phase.kind === "approving" ? decide(phase, action) : unchanged(phase);
    case "legFinished":
      return finished(phase, action);
    case "approvalCancelled":
      return phase.kind === "approving" ? cancelTurn(phase) : unchanged(phase);
    case "undecidedDeclined":
      return phase.kind === "approving" ? declineAll(phase, action) : unchanged(phase);
  }
}
