import { describe, expect, it } from "vitest";

import { AgencyRunner } from "../agencyRunner.js";
import { LlmJudge } from "./llmJudge.js";
import type { GraderInput, Input } from "../types.js";

const graderInput = (
  verdict: { score?: number; pass?: boolean; reasoning: string },
  goal: string = "Return the capital",
): GraderInput => {
  const input: Input = { id: "i1", args: {}, goal };
  return { input, run: { output: "New Delhi", recordPath: "" }, runAgency: new AgencyRunner({}, async () => ({ data: verdict })) };
};

describe("LlmJudge", () => {
  it("maps a scalar verdict to a scalar grade with feedback", async () => {
    const judge = new LlmJudge({ name: "quality", agencyFile: "./quality.agency" });
    const grade = await judge.run(graderInput({ score: 0.9, reasoning: "good" }));
    expect(grade.score).toEqual({ kind: "scalar", value: 0.9 });
    expect(grade.feedback).toBe("good");
  });

  it("maps a binary verdict to a binary grade", async () => {
    const judge = new LlmJudge({ name: "no-any", agencyFile: "./no-any.agency", binary: true });
    const grade = await judge.run(graderInput({ pass: false, reasoning: "uses any" }));
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toBe("uses any");
  });

  it("throws when no goal is present (an LLM judge needs something to judge against)", async () => {
    const judge = new LlmJudge({ name: "quality", agencyFile: "./quality.agency" });
    await expect(judge.run(graderInput({ score: 1, reasoning: "x" }, ""))).rejects.toThrow(/needs a goal/);
  });

  it("uses an inline goal and defaults to the bundled judge file", async () => {
    let captured: { agencyFile: string; argsString: string } | undefined;
    const runAgency = new AgencyRunner({}, async (a) => {
      captured = { agencyFile: a.agencyFile, argsString: a.argsString };
      return { data: { score: 0.8, reasoning: "ok" } };
    });
    const judge = new LlmJudge({ goal: "Return the capital." });   // no agencyFile, no goalPath
    const grade = await judge.run({ input: { id: "a", args: {} }, run: { output: "Paris", recordPath: "" }, runAgency });
    expect(grade.score).toEqual({ kind: "scalar", value: 0.8 });
    expect(captured?.agencyFile.endsWith("eval/goalJudge.agency")).toBe(true);   // default file
    expect(captured?.argsString).toBe('"Return the capital.", "Paris", ""');     // inline goal; no expected → ""
  });

  it("reads the goal from the input via goalPath when no inline goal is given", async () => {
    let captured: string | undefined;
    const runAgency = new AgencyRunner({}, async (a) => {
      captured = a.argsString;
      return { data: { score: 1, reasoning: "" } };
    });
    const judge = new LlmJudge({});   // default goalPath ["goal"]
    await judge.run({ input: { id: "a", args: {}, goal: "from input" }, run: { output: "x", recordPath: "" }, runAgency });
    expect(captured).toBe('"from input", "x", ""');
  });

  it("passes the input's expected answer to the judge as the third arg", async () => {
    let captured: string | undefined;
    const runAgency = new AgencyRunner({}, async (a) => {
      captured = a.argsString;
      return { data: { score: 1, reasoning: "" } };
    });
    const judge = new LlmJudge({ goal: "Return the capital." });   // default expectedPath ["expected"]
    await judge.run({ input: { id: "a", args: {}, expected: "New Delhi" }, run: { output: "New Delhi", recordPath: "" }, runAgency });
    expect(captured).toBe('"Return the capital.", "New Delhi", "New Delhi"');
  });
});
