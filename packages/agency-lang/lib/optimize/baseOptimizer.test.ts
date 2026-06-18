import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseGrader } from "./grading/baseGrader.js";
import type { Grade, GraderInput, GraderOptions, Input } from "./grading/types.js";
import type { Scorecard } from "./grading/scorecard.js";
import { BaseOptimizer, type RunInput } from "./baseOptimizer.js";
import type { OptimizeTarget } from "./optimizer.js";
import type { OptimizeResult } from "./types.js";

class FixedGrader extends BaseGrader {
  protected readonly defaultName = "fixed";
  constructor(private readonly grade: Grade, options: GraderOptions = {}) { super(options); }
  protected _run(_input: GraderInput): Promise<Grade> { return Promise.resolve(this.grade); }
}

/** Concrete subclass exposing `evaluate` for testing. */
class Probe extends BaseOptimizer {
  readonly name = "probe";
  async optimize(_t: OptimizeTarget): Promise<OptimizeResult> { return {} as OptimizeResult; }
  evaluateAt(ws: ReturnType<Probe["fork"]>, entry: string, inputs: Input[]): Promise<Scorecard> {
    return this.evaluate(ws, entry, inputs);
  }
  forkAt(dir: string) { return this.fork(dir); }
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
});
