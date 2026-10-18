import { describe, expect, it } from "vitest";
import { leaf, sessionTrace, span, trace } from "./fixture.js";
import { roundsOf } from "./rounds.js";
import { timelineSpans } from "./spans.js";
import { emptyTally, tallyEvent, tallyTimes, traceTimes, traceTurns, turnTimes } from "./turns.js";

describe("traceTurns", () => {
  it("splits a session at every turnStart, naming each turn by the message it carried", () => {
    const root = sessionTrace();
    const rounds = roundsOf(root);
    const turns = traceTurns(root, rounds);
    expect(turns.map((turn) => [turn.start, turn.workEnd, turn.end])).toEqual([
      [0, 6_000, 600_000],
      [600_000, 609_000, 900_000],
    ]);
    expect(turns.map((turn) => turn.userText)).toEqual([
      "first question",
      "second question\nwith a second line",
    ]);
    expect(turns.map((turn) => turn.rounds.map((round) => round.index))).toEqual([[0], [1]]);
    expect(turnTimes(turns[0])).toEqual({ workingMs: 6_000, waitingMs: 594_000 });
    expect(turnTimes(turns[1])).toEqual({ workingMs: 9_000, waitingMs: 291_000 });
  });

  it("splits the run's wall time into working and waiting", () => {
    const root = sessionTrace();
    expect(traceTimes(root)).toEqual({
      elapsedMs: 900_000,
      workingMs: 15_000,
      waitingMs: 885_000,
    });
  });

  it("is one turn for a trace that never resumed", () => {
    const root = trace([
      span(
        "llmCall",
        [leaf("promptCompletion", 5_000, { timeTaken: 4_000, completion: { output: "ok" } })],
        { id: "L" },
      ),
    ]);
    const rounds = roundsOf(root);
    expect(traceTurns(root, rounds)).toHaveLength(1);
  });

  it("does not split at a threadResumed, which a re-entered session thread logs with no person involved", () => {
    const call = (at: number) =>
      leaf("promptCompletion", at, { timeTaken: 1_000, completion: { output: "ok" } });
    const root = trace([
      span("llmCall", [call(5_000)], { id: "L1" }),
      leaf("threadResumed", 10_000),
      span("llmCall", [call(15_000)], { id: "L2" }),
    ]);
    expect(traceTurns(root, roundsOf(root))).toHaveLength(1);
    expect(traceTimes(root).waitingMs).toBe(0);
  });
});

describe("tallyEvent", () => {
  const feed = (events: [string, number][]) => {
    const tally = emptyTally();
    for (const [type, at] of events) {
      tallyEvent(tally, type, at, type === "turnStart" ? "hi" : undefined);
    }
    return tally;
  };

  it("folds startup before the first message into that message's turn", () => {
    const tally = feed([
      ["agentStart", 0],
      ["enterNode", 100],
      ["turnStart", 5_000],
      ["promptCompletion", 6_000],
      ["turnStart", 20_000],
      ["promptCompletion", 21_000],
      ["agentEnd", 60_000],
    ]);
    expect(tally.turns.map((turn) => [turn.start, turn.workEnd, turn.calls])).toEqual([
      [5_000, 6_000, 1],
      [20_000, 21_000, 1],
    ]);
    // Elapsed from the first event; the startup and the quiet end are waits.
    expect(tallyTimes(tally, { start: 0, end: 60_000 })).toEqual({
      elapsedMs: 60_000,
      workingMs: 2_000,
      waitingMs: 58_000,
    });
  });

  it("keeps work done before the first message as a turn of its own", () => {
    const tally = feed([
      ["agentStart", 0],
      ["promptCompletion", 1_000],
      ["turnStart", 5_000],
      ["promptCompletion", 6_000],
    ]);
    expect(tally.turns.map((turn) => [turn.start, turn.workEnd, turn.fromMessage])).toEqual([
      [0, 1_000, false],
      [5_000, 6_000, true],
    ]);
  });

  it("a run with one turn or none works to its end", () => {
    const one = feed([
      ["turnStart", 0],
      ["promptCompletion", 1_000],
      ["agentEnd", 9_000],
    ]);
    expect(tallyTimes(one, { start: 0, end: 9_000 }).workingMs).toBe(9_000);
    expect(tallyTimes(emptyTally(), { start: 0, end: 9_000 }).workingMs).toBe(9_000);
  });
});

describe("timelineSpans with a window", () => {
  it("keeps the spans inside the window, cut to it, with self time counted inside it", () => {
    const spans = timelineSpans(sessionTrace(), {
      hideKinds: [],
      window: { start: 600_000, end: 609_000 },
    });
    expect(spans.map((span) => span.id)).toEqual(["run", "node", "L2", "tool2"]);
    expect(spans[0].extent).toEqual({ start: 600_000, end: 609_000 });
    expect(spans[0].selfMs).toBe(0);
    // The node's self time inside the turn: the window minus the call under
    // it, which runs from 1s before its completion to its tool's end.
    expect(spans[2].extent).toEqual({ start: 601_000, end: 608_000 });
    expect(spans[1].selfMs).toBe(1_000 + 1_000);
    expect(spans[3].extent).toEqual({ start: 606_000, end: 608_000 });
  });
});
