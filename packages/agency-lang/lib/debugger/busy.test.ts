import { describe, it, expect } from "vitest";
import { busyText, formatElapsed, withSince, type BusyShown } from "./busy.js";
import type { BusyEntry } from "../runtime/waits.js";

function entry(over: Partial<BusyEntry> = {}): BusyEntry {
  return {
    token: 1,
    kind: "model",
    location: {
      moduleId: "tests/debugger/story.agency",
      scopeName: "main",
      stepPath: "4/initialLlmCall",
      branchPath: [],
      depth: 0,
    },
    label: "round 1",
    debugRun: "run-a",
    elapsedMs: 0,
    ...over,
  };
}

describe("withSince", () => {
  it("keeps the time of a wait already held, by its token", () => {
    const held: BusyShown[] = [{ entry: entry({ token: 7 }), since: 1000 }];
    const next = withSince(held, [entry({ token: 7, elapsedMs: 5000 })], 9000);
    expect(next).toEqual([{ entry: entry({ token: 7, elapsedMs: 5000 }), since: 1000 }]);
  });

  it("backdates a new wait by the time it had been open at the send", () => {
    const next = withSince([], [entry({ token: 2, elapsedMs: 42_000 })], 100_000);
    expect(next[0].since).toBe(58_000);
  });

  it("drops a wait that is gone, and keeps the order sent", () => {
    const held = withSince([], [entry({ token: 1 }), entry({ token: 2 })], 0);
    const next = withSince(held, [entry({ token: 2 }), entry({ token: 3 })], 10);
    expect(next.map((shown) => shown.entry.token)).toEqual([2, 3]);
    expect(next[0].since).toBe(0);
    expect(next[1].since).toBe(10);
  });
});

describe("busyText", () => {
  it("names the statement, the elapsed time, and the model request", () => {
    const shown = { entry: entry(), since: 1000 };
    expect(busyText(shown, 11, 5200)).toBe(
      "in llm() at story.agency:11 · 4s · round 1, waiting on model",
    );
  });

  it("names the tool call with its round, from the step key", () => {
    const shown = {
      entry: entry({
        kind: "tool",
        label: 'search(query: "cats")',
        location: {
          moduleId: "story.agency",
          scopeName: "main",
          stepPath: "4/round.1.tool.c1.invoke",
          branchPath: ["tool_c1"],
          depth: 1,
        },
      }),
      since: 0,
    };
    expect(busyText(shown, 11, 72_000)).toBe(
      'in llm() at story.agency:11 · 1m12s · round 2, in tool search(query: "cats")',
    );
  });

  it("names the file alone when the line is not known yet", () => {
    expect(busyText({ entry: entry(), since: 0 }, undefined, 500)).toBe(
      "in llm() at story.agency · 500ms · round 1, waiting on model",
    );
  });
});

describe("formatElapsed", () => {
  it("shows milliseconds, seconds, minutes, and hours", () => {
    expect(formatElapsed(250)).toBe("250ms");
    expect(formatElapsed(30_000)).toBe("30s");
    expect(formatElapsed(250_000)).toBe("4m10s");
    expect(formatElapsed(3_600_000)).toBe("1h");
  });
});
