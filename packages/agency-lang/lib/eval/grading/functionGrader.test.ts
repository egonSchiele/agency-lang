import { describe, expect, it, vi } from "vitest";

import type { AgencyRunner } from "./agencyRunner.js";
import { FunctionGrader, grader, toGrader } from "./functionGrader.js";
import { BaseGrader } from "./baseGrader.js";
import type { GraderInput } from "./types.js";

const runInput = (output: unknown): GraderInput => ({
  input: { id: "a", args: {}, metadata: { expected: "Paris" } },
  run: { output: output as any, recordPath: "" },
  runAgency: {} as AgencyRunner,
});

describe("FunctionGrader", () => {
  it("coerces a number return to a scalar grade", async () => {
    const g = new FunctionGrader(({ input, output }) => (output === input.metadata?.expected ? 1 : 0));
    expect(await g.run(runInput("Paris"))).toEqual({ score: { kind: "scalar", value: 1 } });
    expect(await g.run(runInput("Lyon"))).toEqual({ score: { kind: "scalar", value: 0 } });
  });

  it("coerces a boolean return to a binary grade", async () => {
    const g = new FunctionGrader(({ output }) => output === "Paris");
    expect(await g.run(runInput("Paris"))).toEqual({ score: { kind: "binary", pass: true } });
  });

  it("passes through a full Grade object", async () => {
    const g = new FunctionGrader(() => ({ score: { kind: "scalar", value: 0.7 }, feedback: "close" }));
    expect(await g.run(runInput("x"))).toEqual({ score: { kind: "scalar", value: 0.7 }, feedback: "close" });
  });

  it("exposes the input's metadata to the function via ctx.input", async () => {
    const seen: unknown[] = [];
    const g = new FunctionGrader(({ input }) => { seen.push(input.metadata?.expected); return 1; });
    await g.run(runInput("Paris"));
    expect(seen).toEqual(["Paris"]);
  });

  it("provides ctx.judge that runs the bundled goal judge and returns its score", async () => {
    const runStructured = vi.fn(async () => ({ score: 0.9, reasoning: "good" }));
    const ctxInput: GraderInput = { ...runInput("Paris"), runAgency: { runStructured } as unknown as AgencyRunner };
    const g = new FunctionGrader(async ({ judge, output }) => (await judge({ goal: "capital", output })).score);
    expect(await g.run(ctxInput)).toEqual({ score: { kind: "scalar", value: 0.9 } });
    expect(runStructured).toHaveBeenCalledTimes(1);
  });

  it("ctx.judge forwards input.expected as the third judge arg by default", async () => {
    const runStructured = vi.fn(async () => ({ score: 1, reasoning: "" }));
    const input: GraderInput = {
      input: { id: "a", args: {}, expected: "New Delhi" },
      run: { output: "New Delhi", recordPath: "" },
      runAgency: { runStructured } as unknown as AgencyRunner,
    };
    const g = new FunctionGrader(async ({ judge }) => (await judge({ goal: "capital" })).score);
    await g.run(input);
    expect((runStructured.mock.calls[0] as unknown[])[2]).toEqual(["capital", "New Delhi", "New Delhi"]);
  });

  it("ctx.judge lets the caller override expected explicitly", async () => {
    const runStructured = vi.fn(async () => ({ score: 1, reasoning: "" }));
    const input: GraderInput = {
      input: { id: "a", args: {}, expected: "New Delhi" },
      run: { output: "Mumbai", recordPath: "" },
      runAgency: { runStructured } as unknown as AgencyRunner,
    };
    const g = new FunctionGrader(async ({ judge }) => (await judge({ goal: "capital", expected: "Delhi" })).score);
    await g.run(input);
    expect((runStructured.mock.calls[0] as unknown[])[2]).toEqual(["capital", "Mumbai", "Delhi"]);
  });

  it("grader() attaches policy options (mustPass/name) to the wrapped function", () => {
    const g = grader(() => 1, { mustPass: true, name: "exact" });
    expect(g.mustPass()).toBe(true);
    expect(g.name()).toBe("exact");
  });

  it("toGrader passes a BaseGrader through and wraps a function", () => {
    const instance = grader(() => 1);
    expect(toGrader(instance)).toBe(instance);
    expect(toGrader(() => 1)).toBeInstanceOf(BaseGrader);
  });

  it("toGrader rejects a non-grader value with a clear error", () => {
    expect(() => toGrader(42 as any)).toThrow(/expected a grader function or grader instance/);
  });
});
