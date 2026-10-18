import { describe, expect, it } from "vitest";
import { roundDeltas } from "../messageDelta.js";
import { leaf, sessionTrace, span, trace } from "./fixture.js";
import { roundsOf } from "./rounds.js";
import { timelineSpans } from "./spans.js";
import { traceTurns, turnTimes } from "./turns.js";

describe("traceTurns", () => {
  it("splits a session at every threadResumed, naming each turn by the message that began it", () => {
    const root = sessionTrace();
    const rounds = roundsOf(root);
    const turns = traceTurns(root, rounds, roundDeltas(rounds));
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

  it("is one turn for a trace that never resumed", () => {
    const root = trace([
      span(
        "llmCall",
        [leaf("promptCompletion", 5_000, { timeTaken: 4_000, completion: { output: "ok" } })],
        { id: "L" },
      ),
    ]);
    const rounds = roundsOf(root);
    expect(traceTurns(root, rounds, roundDeltas(rounds))).toHaveLength(1);
  });
});

describe("timelineSpans with a window", () => {
  it("keeps the spans inside the window, cut to it, with self time counted inside it", () => {
    const spans = timelineSpans(sessionTrace(), {
      hideKinds: [],
      window: { start: 600_000, end: 609_000 },
    });
    expect(spans.map((span) => span.id)).toEqual(["run", "L2", "tool2"]);
    expect(spans[0].extent).toEqual({ start: 600_000, end: 609_000 });
    // The run's self time inside the turn: the window minus the call under
    // it, which runs from 1s before its completion to its tool's end.
    expect(spans[1].extent).toEqual({ start: 601_000, end: 608_000 });
    expect(spans[0].selfMs).toBe(1_000 + 1_000);
    expect(spans[2].extent).toEqual({ start: 606_000, end: 608_000 });
  });
});
