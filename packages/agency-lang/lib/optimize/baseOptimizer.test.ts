import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseGrader } from "./grading/baseGrader.js";
import type { Grade, GraderInput, GraderOptions, Input } from "./grading/types.js";
import type { Scorecard } from "./grading/scorecard.js";
import { BaseOptimizer, gradedOutput, type MutationOutcome, type RunInput } from "./baseOptimizer.js";
import type { OptimizeTarget } from "./optimizer.js";
import type { OptimizeMutationDiagnostic, OptimizeMutationOperation, OptimizeMutationPreview } from "./sourceMutator.js";
import type { OptimizeTargetSet } from "./targets.js";
import type { MutationProposal, OptimizeResult } from "./types.js";

class FixedGrader extends BaseGrader {
  protected readonly defaultName = "fixed";
  constructor(private readonly grade: Grade, options: GraderOptions = {}) { super(options); }
  protected _run(_input: GraderInput): Promise<Grade> { return Promise.resolve(this.grade); }
}

/** Concrete subclass exposing `evaluate` for testing. */
class Probe extends BaseOptimizer {
  readonly name = "probe";
  protected async optimizeTargets(): Promise<OptimizeResult> { return {} as OptimizeResult; }
  evaluateAt(ws: ReturnType<Probe["fork"]>, entry: string, inputs: Input[]): Promise<Scorecard> {
    return this.evaluate(ws, entry, inputs);
  }
  forkAt(dir: string) { return this.fork(dir); }
  requireBaselineGatesPassAt(sc: Scorecard): void { this.requireBaselineGatesPass(sc); }
  proposeValidMutationAt(
    propose: (d: OptimizeMutationDiagnostic[]) => Promise<MutationProposal>,
    preview: (ops: OptimizeMutationOperation[]) => OptimizeMutationPreview,
    max?: number,
  ): Promise<MutationOutcome> { return this.proposeValidMutation(propose, preview, max); }
  buildResultAt(args: Parameters<Probe["buildPointwiseResult"]>[0]): OptimizeResult { return this.buildPointwiseResult(args); }
}

describe("BaseOptimizer.evaluate", () => {
  let root: string;
  let src: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bo-"));
    src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "agent.agency"), "node main() {}\n");
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function probe(graders: BaseGrader[], runInput: RunInput): Probe {
    return new Probe(
      { graders, iterations: 1, config: {}, runsDir: root, runId: "r" },
      { workspaceRoot: path.join(root, "ws"), runInput },
    );
  }

  const inputs: Input[] = [{ id: "a", args: {} }, { id: "b", args: {} }];
  const fixedRun: RunInput = async () => ({ output: "out", recordPath: "" });

  it("runs the agent once per input (cached) and builds a gate-aware Scorecard", async () => {
    const runInput = vi.fn(fixedRun);
    const p = probe([new FixedGrader({ score: { kind: "scalar", value: 0.5 } })], runInput);
    const sc = await p.evaluateAt(p.forkAt(src), "agent.agency", inputs);
    expect(runInput).toHaveBeenCalledTimes(2);
    expect(sc.objective()).toBeCloseTo(0.5, 10);
    expect(sc.gatesPassed()).toBe(true);
  });

  it("short-circuits advisory graders when a gate fails for an input", async () => {
    const gate = new FixedGrader({ score: { kind: "binary", pass: false } }, { mustPass: true });
    const advisory = new FixedGrader({ score: { kind: "scalar", value: 1 } });
    const advisorySpy = vi.spyOn(advisory as unknown as { _run: () => Promise<Grade> }, "_run");
    const p = probe([gate, advisory], fixedRun);
    const sc = await p.evaluateAt(p.forkAt(src), "agent.agency", [{ id: "a", args: {} }]);
    expect(sc.gatesPassed()).toBe(false);
    expect(advisorySpy).not.toHaveBeenCalled();
  });

  it("only runs graders whose inputScope matches the input", async () => {
    const scoped = new FixedGrader({ score: { kind: "scalar", value: 1 } }, { inputScope: { ids: ["a"] } });
    const p = probe([scoped], fixedRun);
    const sc = await p.evaluateAt(p.forkAt(src), "agent.agency", inputs);
    // input "a" scores 1; input "b" has no contributing grader → 0; mean = 0.5
    expect(sc.objective()).toBeCloseTo(0.5, 10);
  });

  it("gives id-less inputs distinct cache keys so they do not collide", async () => {
    const runInput = vi.fn(fixedRun);
    const p = probe([new FixedGrader({ score: { kind: "scalar", value: 1 } })], runInput);
    await p.evaluateAt(p.forkAt(src), "agent.agency", [{ args: {} }, { args: {} }]); // both omit id
    expect(runInput).toHaveBeenCalledTimes(2);
  });

  it("requireBaselineGatesPass throws naming the failing must-pass grader", async () => {
    const gate = new FixedGrader({ score: { kind: "binary", pass: false } }, { mustPass: true, name: "must-be-json" });
    const p = probe([gate], fixedRun);
    const sc = await p.evaluateAt(p.forkAt(src), "agent.agency", [{ id: "a", args: {} }]);
    expect(() => p.requireBaselineGatesPassAt(sc)).toThrow(/must-be-json/);
  });

  it("requireBaselineGatesPass does not throw when gates pass", async () => {
    const gate = new FixedGrader({ score: { kind: "binary", pass: true } }, { mustPass: true });
    const p = probe([gate], fixedRun);
    const sc = await p.evaluateAt(p.forkAt(src), "agent.agency", [{ id: "a", args: {} }]);
    expect(() => p.requireBaselineGatesPassAt(sc)).not.toThrow();
  });

  describe("proposeValidMutation", () => {
    const probeFor = () => probe([new FixedGrader({ score: { kind: "scalar", value: 1 } })], fixedRun);
    const op: OptimizeMutationOperation = { target: "t", kind: "variable", op: "replaceInitializer", value: '"x"' };
    const proposal = (rationale: string): MutationProposal => ({ rationale, operations: [op] });
    const cleanPreview = (): OptimizeMutationPreview => ({ files: {}, changes: [], diff: "", diagnostics: [], targetSet: {} as OptimizeTargetSet });
    const badPreview = (): OptimizeMutationPreview => ({ files: {}, changes: [], diff: "", diagnostics: [{ target: "t", code: "interpolation-mismatch", message: "dropped ${x}" }], targetSet: {} as OptimizeTargetSet });

    it("returns the preview on the first clean proposal", async () => {
      const propose = vi.fn(async () => proposal("r"));
      const out = await probeFor().proposeValidMutationAt(propose, () => cleanPreview());
      expect(out.ok).toBe(true);
      expect(propose).toHaveBeenCalledTimes(1);
    });

    it("retries with the diagnostics fed back, then succeeds", async () => {
      const propose = vi.fn(async (d: OptimizeMutationDiagnostic[]) => proposal(d.length ? "fixed" : "first"));
      let calls = 0;
      const out = await probeFor().proposeValidMutationAt(propose, () => (calls++ === 0 ? badPreview() : cleanPreview()));
      expect(out.ok).toBe(true);
      expect(propose).toHaveBeenCalledTimes(2);
      expect(propose.mock.calls[1][0]).toHaveLength(1); // 2nd call received the prior diagnostics
    });

    it("does not throw when the proposer keeps failing; returns ok:false after maxAttempts", async () => {
      const propose = vi.fn(async () => { throw new Error("bad json"); });
      const out = await probeFor().proposeValidMutationAt(propose, () => cleanPreview(), 3);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.rationale).toMatch(/malformed/);
      expect(propose).toHaveBeenCalledTimes(3);
    });
  });

  it("gradedOutput returns the last value, or throws a clear error when the agent produced none", () => {
    expect(gradedOutput([{ value: "a" }, { value: "b" }], "q1")).toBe("b");
    expect(() => gradedOutput([], "q1")).toThrow(/no output to grade for input "q1".*evalOutput\(\)/s);
  });

  it("buildPointwiseResult builds a baseline-led result with correct decision counts", () => {
    const p = probe([new FixedGrader({ score: { kind: "scalar", value: 1 } })], fixedRun);
    const result = p.buildResultAt({
      championIter: 2,
      championFiles: { "agent.agency": "node main() {}\n" },
      attempts: [
        { iter: 1, decision: "rejected" },
        { iter: 2, decision: "accepted" },
        { iter: 3, decision: "validation-failed", detail: "[interpolation-mismatch] you removed ${x}" },
      ],
    });
    expect(result.iterations[0].decision).toBe("baseline");
    expect(result.iterations).toHaveLength(4);
    expect(result.acceptedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.validationFailedCount).toBe(1);
    expect(result.championIter).toBe(2);
    // detail (validation reason / rationale) is persisted into the iteration record.
    expect(result.iterations[3].detail).toBe("[interpolation-mismatch] you removed ${x}");
    expect(result.iterations[1].detail).toBeUndefined();
  });
});
