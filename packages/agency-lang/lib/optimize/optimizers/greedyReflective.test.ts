import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseGrader } from "../grading/baseGrader.js";
import { Scorecard } from "../grading/scorecard.js";
import type { Grade, GraderInput, GraderOptions } from "../grading/types.js";
import { GreedyReflective, type GreedyDeps } from "./greedyReflective.js";
import type { OptimizeMutationPreview } from "../sourceMutator.js";
import type { OptimizeTargetSet } from "../targets.js";

class ValueGrader extends BaseGrader {
  protected readonly defaultName = "value";
  constructor(private readonly next: () => number, options: GraderOptions = {}) { super(options); }
  protected _run(_i: GraderInput): Promise<Grade> { return Promise.resolve({ score: { kind: "scalar", value: this.next() } }); }
}

describe("GreedyReflective (pointwise)", () => {
  let root: string;
  let src: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "greedy-"));
    src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "agent.agency"), 'optimize const prompt = "hi"\n\nnode main() {}\n');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const fakeSource = (): OptimizeTargetSet => ({
    baseDir: src,
    entryFile: "agent.agency",
    typeAliases: {},
    files: { "agent.agency": { file: "agent.agency", absoluteFile: path.join(src, "agent.agency"), source: "x", sha256: "x" } },
    targets: [{ id: "agent.agency:global:prompt", kind: "variable", file: "agent.agency", absoluteFile: path.join(src, "agent.agency"), scope: "global", name: "prompt", valueKind: "string", value: "hi" }],
  });

  const deps = (): GreedyDeps => ({
    runInput: async () => ({ output: "out", recordPath: "" }),
    discover: () => fakeSource(),
    propose: async () => ({ rationale: "tighten", operations: [] }),
    preview: (targetSet): OptimizeMutationPreview => ({ files: {}, changes: [], diff: "", diagnostics: [], targetSet }),
  });

  it("accepts a candidate only when gates pass and the objective improves", async () => {
    let n = 0;
    const grader = new ValueGrader(() => 0.1 * ++n); // baseline 0.1, then 0.2, 0.3 ... each candidate beats champion
    const opt = new GreedyReflective(
      { graders: [grader], iterations: 2, config: {}, runsDir: root, runId: "r", writeback: false },
      deps(),
    );
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });
    expect(result.acceptedCount).toBe(2);
    expect(result.rejectedCount).toBe(0);
  });

  it("rejects a candidate whose objective does not improve", async () => {
    const grader = new ValueGrader(() => 0.5); // constant — no candidate beats the champion
    const opt = new GreedyReflective(
      { graders: [grader], iterations: 2, config: {}, runsDir: root, runId: "r2", writeback: false },
      deps(),
    );
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });
    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(2);
    expect(result.championIter).toBe("baseline");
  });

  it("counts a candidate that fails a gate as rejected even if its objective is higher", async () => {
    let n = 0;
    const gate = new (class extends BaseGrader {
      protected readonly defaultName = "gate";
      protected _run(): Promise<Grade> { return Promise.resolve({ score: { kind: "binary", pass: ++n === 1 } }); }
    })({ mustPass: true });
    // 0.5 keeps the baseline below the max objective (so the run doesn't early-exit);
    // the candidate then fails the gate and is rejected regardless of its scalar.
    const scalar = new ValueGrader(() => 0.5);
    const opt = new GreedyReflective(
      { graders: [gate, scalar], iterations: 1, config: {}, runsDir: root, runId: "r3", writeback: false },
      deps(),
    );
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });
    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
  });

  it("does not crash when the proposer throws; records the iteration as invalid after retries", async () => {
    const propose = vi.fn(async () => { throw new Error("malformed mutator response"); });
    const opt = new GreedyReflective(
      { graders: [new ValueGrader(() => 0.5)], iterations: 1, config: {}, runsDir: root, runId: "throw", writeback: false },
      { ...deps(), propose },
    );
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });
    expect(result.validationFailedCount).toBe(1);
    expect(result.championIter).toBe("baseline");
    expect(propose).toHaveBeenCalledTimes(3); // retried up to maxAttempts before giving up
  });

  it("exits early without iterating when the baseline already scores the maximum objective", async () => {
    const propose = vi.fn(async () => ({ rationale: "x", operations: [] }));
    const opt = new GreedyReflective(
      { graders: [new ValueGrader(() => 1)], iterations: 3, config: {}, runsDir: root, runId: "perfect", writeback: false },
      { ...deps(), propose },
    );
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });
    expect(result.championIter).toBe("baseline");
    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(result.iterations).toHaveLength(1); // baseline only
    expect(propose).not.toHaveBeenCalled();
  });

  it("stops early once a candidate reaches the maximum objective", async () => {
    let calls = 0;
    const scalar = new ValueGrader(() => (calls++ === 0 ? 0.5 : 1)); // baseline 0.5, first candidate 1.0
    const propose = vi.fn(async () => ({ rationale: "x", operations: [] }));
    const opt = new GreedyReflective(
      { graders: [scalar], iterations: 5, config: {}, runsDir: root, runId: "stop", writeback: false },
      { ...deps(), propose },
    );
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });
    expect(result.acceptedCount).toBe(1);
    expect(result.iterations).toHaveLength(2); // baseline + 1 accepted, then stop (not all 5)
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it("feeds the champion's per-input expected answers and grader feedback to the mutator", async () => {
    let captured: { feedback?: string } | undefined;
    const grader = new (class extends BaseGrader {
      protected readonly defaultName = "g";
      protected _run({ input }: GraderInput): Promise<Grade> {
        return Promise.resolve({ score: { kind: "scalar", value: 0 }, feedback: `wanted ${input.expected}` });
      }
    })();
    const propose = vi.fn(async (a: { feedback?: string }) => { captured = a; return { rationale: "x", operations: [] }; });
    const opt = new GreedyReflective(
      { graders: [grader], iterations: 1, config: {}, runsDir: root, runId: "fb", writeback: false },
      { ...deps(), propose },
    );
    await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "india", args: {}, expected: "New Delhi" }] });
    expect(captured?.feedback).toContain("New Delhi");        // the expected answer surfaced
    expect(captured?.feedback).toContain("wanted New Delhi"); // the grader's feedback surfaced
  });

  it("writes back the candidate with the best validation objective, not the best train objective", async () => {
    const trainCurve = [0.2, 0.4, 0.6];   // baseline, c1, c2 — climbing → both accepted; train champion = c2
    const valCurve   = [0.3, 0.9, 0.5];   // baseline, c1, c2 — peaks at c1
    let ti = 0;
    let vi = 0;
    const keyed = new (class extends BaseGrader {
      protected readonly defaultName = "keyed";
      protected _run({ input }: GraderInput): Promise<Grade> {
        const value = input.id === "v"
          ? valCurve[Math.min(vi++, valCurve.length - 1)]
          : trainCurve[Math.min(ti++, trainCurve.length - 1)];
        return Promise.resolve({ score: { kind: "scalar", value } });
      }
    })();
    const opt = new GreedyReflective(
      { graders: [keyed], iterations: 2, config: {}, runsDir: root, runId: "valpick", writeback: false },
      deps(),   // deps().propose returns valid empty-op proposals → every iteration is accepted
    );
    const result = await opt.optimize({
      agent: path.join(src, "agent.agency"),
      inputs: [{ id: "a", args: {} }],
      validationInputs: [{ id: "v", args: {} }],
    });
    expect(result.championIter).toBe(1);                  // val winner, though iter 2 had the higher train objective
    expect(result.validationObjective).toBeCloseTo(0.9, 5);
  });

  it("records the gate-aware baseline objective on the result", async () => {
    const grader = new ValueGrader(() => 0.5); // every grade 0.5 → baseline obj 0.5, no gates
    const opt = new GreedyReflective(
      { graders: [grader], iterations: 2, config: {}, runsDir: root, runId: "baseobj", writeback: false },
      deps(),
    );
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });
    expect(result.championIter).toBe("baseline"); // constant grade → nothing beats baseline
    expect(result.baselineObjective).toBeCloseTo(0.5, 10);
    expect(result.trainObjective).toBeCloseTo(0.5, 10);
  });

  // The baselineObjective-via-gate-fail scenario is unreachable end-to-end
  // because requireBaselineGatesPass throws before finishPointwise runs, so we
  // pin the gate-aware rule at the Scorecard layer where the field's value is
  // actually computed.
  it("Scorecard.gatedObjective() zeroes out a gate-failed score even when the raw objective is high", () => {
    const passed = new Scorecard([{
      input: { id: "a", args: {} },
      run: { output: "out", recordPath: "" },
      grades: [{ grader: new ValueGrader(() => 0.9), grade: { score: { kind: "scalar", value: 0.9 } } }],
      gatesPassed: true,
    }]);
    expect(passed.gatedObjective()).toBeCloseTo(0.9, 10);

    const failed = new Scorecard([{
      input: { id: "a", args: {} },
      run: { output: "out", recordPath: "" },
      grades: [{ grader: new ValueGrader(() => 0.9), grade: { score: { kind: "scalar", value: 0.9 } } }],
      gatesPassed: false,
    }]);
    expect(failed.gatedObjective()).toBe(0);
  });
});
