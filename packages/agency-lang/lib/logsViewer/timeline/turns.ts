// Turns of a session: the stretches of work between the messages a person
// sent. A chat session's trace is mostly waiting for the next message, so
// the timeline shows one turn at a time and lists the turns above them.
import { contentText } from "../../statelog/wireAccessors.js";
import { walkNodes } from "../forest.js";
import { roundDeltas, type RoundDelta } from "../messageDelta.js";
import type { TreeNode } from "../types.js";
import type { Round } from "./rounds.js";
import { spanExtent } from "./spans.js";

export type Turn = {
  /** 0-based; screens print `index + 1`. */
  index: number;
  /** When the turn began: the trace start, or the `threadResumed` that
   *  brought the person's message. */
  start: number;
  /** When the next turn began, or the trace end. */
  end: number;
  /** The last event of the turn's work; the wait for the person runs
   *  from here to `end`. */
  workEnd: number;
  /** The message that started the turn, when a call recorded one. */
  userText: string | undefined;
  /** The calls that started in the turn. */
  rounds: Round[];
};

/** Events that end the run rather than do work in it. */
const RUN_END_EVENTS = ["exitNode", "agentEnd"];

/** The session's turns, split at every `threadResumed` event, the one the
 *  runtime logs when a person's next message arrives. A trace with no
 *  resume is one turn. */
export function traceTurns(
  trace: TreeNode,
  rounds: Round[],
  deltas: RoundDelta[] = roundDeltas(rounds),
): Turn[] {
  const extent = spanExtent(trace);
  if (extent === undefined) {
    return [];
  }
  const events = walkNodes(trace)
    .filter((node) => node.event !== undefined)
    .map((node) => ({
      type: String(node.event!.data.type),
      at: Date.parse(node.event!.data.timestamp),
    }))
    .filter((entry) => Number.isFinite(entry.at));
  const resumes = events
    .filter((entry) => entry.type === "threadResumed")
    .map((entry) => entry.at)
    .sort((first, second) => first - second);
  const starts = [extent.start, ...resumes];
  const deltaByRound: Record<string, RoundDelta> = Object.create(null);
  for (const delta of deltas) {
    deltaByRound[delta.roundId] = delta;
  }
  return starts.map((start, index) => {
    const last = index === starts.length - 1;
    const end = last ? extent.end : starts[index + 1];
    // The last turn runs to the trace end inclusive; every other ends
    // where the next begins.
    const inTurn = (at: number): boolean => at >= start && (last ? at <= end : at < end);
    const own = rounds.filter((round) => inTurn(round.start));
    const work = events.filter((entry) => inTurn(entry.at) && !RUN_END_EVENTS.includes(entry.type));
    // A run that never resumed is one turn, and the moments between its
    // last call and its agentEnd are shutdown, not a person being waited
    // for; only a session that resumed at least once waits at its end.
    const workEnd =
      starts.length === 1
        ? end
        : work.length === 0
          ? start
          : Math.max(...work.map((entry) => entry.at));
    return { index, start, end, workEnd, userText: firstUserText(own, deltaByRound), rounds: own };
  });
}

/** The turn's first call that added a user message, and that message. */
function firstUserText(
  rounds: Round[],
  deltaByRound: Record<string, RoundDelta>,
): string | undefined {
  for (const round of [...rounds].sort((first, second) => first.start - second.start)) {
    const users = (deltaByRound[round.id]?.added ?? []).filter(
      (message) => message.role === "user",
    );
    if (users.length > 0) {
      return contentText(users[users.length - 1].content);
    }
  }
  return undefined;
}

/** How long the turn worked, and how long it then waited for the person
 *  (or, on the last turn, until the run ended). */
export function turnTimes(turn: Turn): { workingMs: number; waitingMs: number } {
  return { workingMs: turn.workEnd - turn.start, waitingMs: turn.end - turn.workEnd };
}

export type TraceTimes = { elapsedMs: number; workingMs: number; waitingMs: number };

/** The run's wall time split into the turns' work and the waits between
 *  them. Screens print the working time as the run's duration, since a
 *  session that sat for 900 minutes between two messages did not take
 *  900 minutes. */
export function traceTimes(trace: TreeNode, rounds: Round[]): TraceTimes {
  const turns = traceTurns(trace, rounds);
  const workingMs = turns.reduce((sum, turn) => sum + turnTimes(turn).workingMs, 0);
  const elapsedMs = turns.length === 0 ? 0 : turns[turns.length - 1].end - turns[0].start;
  return { elapsedMs, workingMs, waitingMs: elapsedMs - workingMs };
}
