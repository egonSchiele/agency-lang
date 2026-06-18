import { describe, expect, it } from "vitest";

import { AgencyRunner } from "./agencyRunner.js";
import { HumanGrader, type HumanRead } from "./humanGrader.js";
import type { GraderInput, Input, JSON } from "./types.js";

const graderInput = (output: JSON): GraderInput => {
  const input: Input = { id: "i1", args: {} };
  return { input, run: { output, recordPath: "" }, runAgency: new AgencyRunner({}, async () => ({ data: null })) };
};

describe("HumanGrader", () => {
  it("normalizes a scalar rating against the scale (min maps to 0, max to 1)", async () => {
    const read: HumanRead = async () => ({ rating: 8, note: "clean" });
    const grade = await new HumanGrader({ scale: { min: 1, max: 10 }, read }).run(graderInput("some code"));
    if (grade.score.kind !== "scalar") throw new Error("expected scalar");
    expect(grade.score.value).toBeCloseTo((8 - 1) / (10 - 1), 10); // 0.777…
    expect(grade.feedback).toBe("clean");
  });

  it("supports a binary verdict when no scale is given", async () => {
    const read: HumanRead = async () => ({ pass: true });
    const grade = await new HumanGrader({ read }).run(graderInput("x"));
    expect(grade.score).toEqual({ kind: "binary", pass: true });
  });

  it("asks the human exactly once even if samples is set higher", async () => {
    let calls = 0;
    const read: HumanRead = async () => { calls += 1; return { rating: 1 }; };
    await new HumanGrader({ scale: { min: 0, max: 1 }, samples: 5, read }).run(graderInput("x"));
    expect(calls).toBe(1);
  });

  it("passes the prompt, scale, and stringified artifact to the reader", async () => {
    let seen: { prompt: string; artifact: string; scale?: { min: number; max: number } } | undefined;
    const read: HumanRead = async (req) => { seen = req; return { rating: 1 }; };
    await new HumanGrader({ name: "quality", prompt: "Rate it", scale: { min: 0, max: 2 }, read }).run(graderInput({ a: 1 }));
    expect(seen?.prompt).toBe("Rate it");
    expect(seen?.scale).toEqual({ min: 0, max: 2 });
    expect(seen?.artifact).toBe("{\"a\":1}");   // structured output stringified
  });
});
