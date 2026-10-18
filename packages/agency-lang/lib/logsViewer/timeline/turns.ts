// Turns of a session: the stretches of work between the messages a person
// sent. A chat session's trace is mostly waiting for the next message, so
// the timeline draws each turn on its own axis.
import { walkNodes } from "../forest.js";
import type { TreeNode } from "../types.js";
import type { Interval } from "./intervals.js";
import type { Round } from "./rounds.js";
import { spanExtent } from "./spans.js";

export type Turn = {
  /** 0-based; screens print `index + 1`. */
  index: number;
  /** When the turn began: the `turnStart` that brought the person's
   *  message, or the trace start for work done before any message. */
  start: number;
  /** When the next turn began, or the trace end. */
  end: number;
  /** The last event of the turn's work; the wait for the person runs
   *  from here to `end`. */
  workEnd: number;
  /** The message that started the turn, when a `turnStart` carried one. */
  userText: string | undefined;
  /** The calls that started in the turn. */
  rounds: Round[];
};

/** Events that end the run rather than do work in it. */
const RUN_END_EVENTS = ["exitNode", "agentEnd"];

/** A turn as the tally keeps it: where it began, how far its work reached,
 *  how many LLM calls completed in it, and whether a `turnStart` opened it. */
type TalliedTurn = {
  start: number;
  workEnd: number;
  calls: number;
  message: string | undefined;
  fromMessage: boolean;
};

/** A trace's turns, built one event at a time in time order. The runs
 *  explorer feeds it while scanning a log; the viewer feeds it from the
 *  forest. Both get the same split. */
export type TurnTally = { turns: TalliedTurn[] };

export function emptyTally(): TurnTally {
  return { turns: [] };
}

/** Feed one event. A `turnStart` opens a turn. Any other event extends the
 *  current turn's work, unless it ends the run. Events before the first
 *  `turnStart` are a turn of their own only when an LLM call completed
 *  among them (a seeded prompt, a script that works and then chats);
 *  otherwise they are startup, and the first turn begins at the first
 *  message. */
export function tallyEvent(tally: TurnTally, type: string, at: number, message?: unknown): void {
  if (!Number.isFinite(at)) {
    return;
  }
  if (type === "turnStart") {
    const [first] = tally.turns;
    if (tally.turns.length === 1 && !first.fromMessage && first.calls === 0) {
      tally.turns.pop();
    }
    tally.turns.push({
      start: at,
      workEnd: at,
      calls: 0,
      message: typeof message === "string" ? message : undefined,
      fromMessage: true,
    });
    return;
  }
  if (tally.turns.length === 0) {
    tally.turns.push({ start: at, workEnd: at, calls: 0, message: undefined, fromMessage: false });
  }
  const current = tally.turns[tally.turns.length - 1];
  if (type === "promptCompletion") {
    current.calls += 1;
  }
  if (!RUN_END_EVENTS.includes(type)) {
    current.workEnd = Math.max(current.workEnd, at);
  }
}

/** The run's wall time split into work and waits for the person. A trace
 *  with fewer than two turns works to its end: the moments before its
 *  `agentEnd` are shutdown, not a person being waited for. */
export function tallyTimes(
  tally: TurnTally,
  extent: Interval,
): { elapsedMs: number; workingMs: number; waitingMs: number } {
  const elapsedMs = extent.end - extent.start;
  if (tally.turns.length < 2) {
    return { elapsedMs, workingMs: elapsedMs, waitingMs: 0 };
  }
  const workingMs = tally.turns.reduce((sum, turn) => sum + (turn.workEnd - turn.start), 0);
  return { elapsedMs, workingMs, waitingMs: elapsedMs - workingMs };
}

function tallyTrace(trace: TreeNode): TurnTally {
  const tally = emptyTally();
  const events = walkNodes(trace)
    .filter((node) => node.event !== undefined)
    .map((node) => ({
      type: String(node.event!.data.type),
      at: Date.parse(node.event!.data.timestamp),
      message: node.event!.data.message as unknown,
    }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((first, second) => first.at - second.at);
  for (const entry of events) {
    tallyEvent(tally, entry.type, entry.at, entry.message);
  }
  return tally;
}

/** The session's turns, split at every `turnStart` event. A trace with no
 *  `turnStart` is one turn. */
export function traceTurns(trace: TreeNode, rounds: Round[]): Turn[] {
  const extent = spanExtent(trace);
  if (extent === undefined) {
    return [];
  }
  const tallied = tallyTrace(trace).turns;
  if (tallied.length < 2) {
    return [
      {
        index: 0,
        start: extent.start,
        end: extent.end,
        workEnd: extent.end,
        userText: tallied[0]?.message,
        rounds,
      },
    ];
  }
  return tallied.map((turn, index) => {
    const last = index === tallied.length - 1;
    const end = last ? extent.end : tallied[index + 1].start;
    // The last turn runs to the trace end inclusive; every other ends
    // where the next begins.
    const inTurn = (at: number): boolean => at >= turn.start && (last ? at <= end : at < end);
    return {
      index,
      start: turn.start,
      end,
      workEnd: turn.workEnd,
      userText: turn.message,
      rounds: rounds.filter((round) => inTurn(round.start)),
    };
  });
}

/** How long the turn worked, and how long it then waited for the person
 *  (or, on the last turn, until the run ended). */
export function turnTimes(turn: Turn): { workingMs: number; waitingMs: number } {
  return { workingMs: turn.workEnd - turn.start, waitingMs: turn.end - turn.workEnd };
}

/** The run's wall time split into work and waits, for the screens that
 *  print a duration: the overview header, the trace picker, the explorer. */
export function traceTimes(trace: TreeNode): {
  elapsedMs: number;
  workingMs: number;
  waitingMs: number;
} {
  const extent = spanExtent(trace);
  if (extent === undefined) {
    return { elapsedMs: 0, workingMs: 0, waitingMs: 0 };
  }
  return tallyTimes(tallyTrace(trace), extent);
}
