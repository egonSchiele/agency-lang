import { describe, expect, it, vi } from "vitest";

import { AgencyRunner } from "./agencyRunner.js";
import { BaseGrader } from "./baseGrader.js";
import type { Grade, GraderInput, GraderOptions, Input } from "./types.js";

const stubRunner = new AgencyRunner({}, async () => ({ data: null }));
const input = (over: Partial<Input> = {}): Input => ({ id: "i1", args: {}, ...over });
const gi = (over: Partial<Input> = {}): GraderInput => ({ input: input(over), run: { output: null, recordPath: "" }, runAgency: stubRunner });

/** Test grader whose single-shot grade is supplied per instance. */
class StubGrader extends BaseGrader {
  protected readonly defaultName = "stub";
  constructor(private readonly produce: () => Grade, options: GraderOptions = {}) {
    super(options);
  }
  protected _run(): Promise<Grade> {
    return Promise.resolve(this.produce());
  }
}

describe("BaseGrader", () => {
  it("uses defaultName, overridable via options.name", () => {
    expect(new StubGrader(() => ({ score: { kind: "binary", pass: true } })).name()).toBe("stub");
    expect(new StubGrader(() => ({ score: { kind: "binary", pass: true } }), { name: "custom" }).name()).toBe("custom");
  });

  it("exposes mustPass and weight from options with defaults", () => {
    const g = new StubGrader(() => ({ score: { kind: "scalar", value: 1 } }), { mustPass: true, weight: 3 });
    expect(g.mustPass()).toBe(true);
    expect(g.weight()).toBe(3);
    const d = new StubGrader(() => ({ score: { kind: "scalar", value: 1 } }));
    expect(d.mustPass()).toBe(false);
    expect(d.weight()).toBe(1);
  });

  it("runs _run `samples` times and aggregates", async () => {
    const produce = vi.fn(() => ({ score: { kind: "scalar", value: 0.5 } as const }));
    const g = new StubGrader(produce, { samples: 4 });
    const grade = await g.run(gi());
    expect(produce).toHaveBeenCalledTimes(4);
    expect(grade.score).toEqual({ kind: "scalar", value: 0.5 });
  });

  it("rejects a non-positive or non-integer samples", async () => {
    const zero = new StubGrader(() => ({ score: { kind: "binary", pass: true } }), { samples: 0 });
    await expect(zero.run(gi())).rejects.toThrow(/samples must be a positive integer/);
    const frac = new StubGrader(() => ({ score: { kind: "binary", pass: true } }), { samples: 1.5 });
    await expect(frac.run(gi())).rejects.toThrow(/samples must be a positive integer/);
  });

  it("passes() reads binary pass, and scalar against threshold", () => {
    const g = new StubGrader(() => ({ score: { kind: "scalar", value: 0 } }), { threshold: 0.7 });
    expect(g.passes({ score: { kind: "binary", pass: true } })).toBe(true);
    expect(g.passes({ score: { kind: "binary", pass: false } })).toBe(false);
    expect(g.passes({ score: { kind: "scalar", value: 0.8 } })).toBe(true);
    expect(g.passes({ score: { kind: "scalar", value: 0.6 } })).toBe(false);
  });

  it("gradesInput: default all; tag scope matches metadata.tags; ids scope matches input.id", () => {
    const all = new StubGrader(() => ({ score: { kind: "binary", pass: true } }));
    expect(all.gradesInput(input())).toBe(true);

    const tagged = new StubGrader(() => ({ score: { kind: "binary", pass: true } }), { inputScope: { tag: "review" } });
    expect(tagged.gradesInput(input({ metadata: { tags: ["review"] } }))).toBe(true);
    expect(tagged.gradesInput(input({ metadata: { tags: ["other"] } }))).toBe(false);
    expect(tagged.gradesInput(input())).toBe(false);

    const byId = new StubGrader(() => ({ score: { kind: "binary", pass: true } }), { inputScope: { ids: ["i1"] } });
    expect(byId.gradesInput(input({ id: "i1" }))).toBe(true);
    expect(byId.gradesInput(input({ id: "i2" }))).toBe(false);
  });
});
