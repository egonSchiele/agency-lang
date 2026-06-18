import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Gepa, type GepaConfig, type GepaDeps } from "./gepa.js";
import { BaseGrader } from "../grading/baseGrader.js";
import type { Grade, GraderInput } from "../grading/types.js";
import type { RunInput } from "../baseOptimizer.js";
import type { OptimizeMutationPreview } from "../sourceMutator.js";
import type { OptimizeTargetSet } from "../targets.js";

/** Scores an input by reading the numeric value the fake runner put in `run.output`. */
class OutputScoreGrader extends BaseGrader {
  protected readonly defaultName = "output-score";
  protected _run({ run }: GraderInput): Promise<Grade> {
    return Promise.resolve({ score: { kind: "scalar", value: Number(run.output) }, feedback: "fb" });
  }
}

describe("Gepa (reflective Pareto optimizer)", () => {
  let root: string;
  let src: string;
  let recordFile: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gepa-"));
    src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "agent.agency"), 'optimize const prompt = "hi"\n\nnode main() {}\n');
    recordFile = path.join(root, "rec.json");
    fs.writeFileSync(recordFile, JSON.stringify({ errors: [], events: [] }));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const target = (id: string): OptimizeTargetSet["targets"][number] => ({
    id, kind: "variable", file: "agent.agency", absoluteFile: path.join(src, "agent.agency"),
    scope: "global", name: id, valueKind: "string", value: `"${id}"`,
  });

  const fakeSource = (): OptimizeTargetSet => ({
    baseDir: src,
    entryFile: "agent.agency",
    files: { "agent.agency": { file: "agent.agency", absoluteFile: path.join(src, "agent.agency"), source: "x", sha256: "x" } },
    targets: [target("t-alpha"), target("t-beta")],
  });

  /** Assign each distinct workspace dir a score, in first-seen order. */
  function scoredRunner(scores: number[]): RunInput {
    const seen = new Map<string, number>();
    return async (ws) => {
      if (!seen.has(ws.dir)) seen.set(ws.dir, scores[seen.size] ?? 0);
      return { output: String(seen.get(ws.dir)), recordPath: recordFile };
    };
  }

  function deps(runInput: RunInput, propose?: GepaDeps["propose"]): GepaDeps {
    return {
      workspaceRoot: path.join(root, "ws"),
      runInput,
      discover: () => fakeSource(),
      propose: propose ?? (async () => ({ rationale: "r", operations: [{ target: "t-alpha", kind: "variable", op: "replaceInitializer", value: '"x"', rationale: "c" }] })),
      preview: (targetSet): OptimizeMutationPreview => ({ files: { "agent.agency": "x" }, changes: [], diff: "", diagnostics: [], targetSet }),
    };
  }

  const config = (over: Partial<GepaConfig>): GepaConfig => ({
    graders: [new OutputScoreGrader()], iterations: 3, minibatch: 2, seed: 1,
    config: {}, runsDir: root, runId: "r", writeback: false, ...over,
  });

  const threeInputs = [{ id: "a", args: {} }, { id: "b", args: {} }, { id: "c", args: {} }];

  it("exits early without iterating when the baseline is already optimal", async () => {
    const runInput = vi.fn(scoredRunner([1.0])); // baseline scores the max objective
    const opt = new Gepa(config({ runId: "perfect" }), deps(runInput));
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: threeInputs });
    expect(result.championIter).toBe("baseline");
    expect(result.acceptedCount).toBe(0);
    expect(result.iterations).toHaveLength(1); // baseline only
  });

  it("stops early once a candidate reaches the maximum objective", async () => {
    const runInput = vi.fn(scoredRunner([0.0, 1.0, 1.0, 1.0])); // baseline 0, first child 1.0
    const opt = new Gepa(config({ runId: "stop", iterations: 5 }), deps(runInput));
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: threeInputs });
    expect(result.acceptedCount).toBe(1);
    expect(result.iterations).toHaveLength(2); // baseline + 1 accepted, then stop (not all 5)
  });

  it("rejects a non-positive or non-integer minibatch at construction", () => {
    expect(() => new Gepa(config({ minibatch: 0 }))).toThrow(/positive integer minibatch/);
    expect(() => new Gepa(config({ minibatch: -3 }))).toThrow(/minibatch/);
    expect(() => new Gepa(config({ minibatch: 2.5 }))).toThrow(/minibatch/);
    expect(() => new Gepa(config({ minibatch: NaN }))).toThrow(/minibatch/);
  });

  it("admits the baseline and grows the pool when children improve on the minibatch", async () => {
    const runInput = vi.fn(scoredRunner([0.1, 0.2, 0.3, 0.4])); // baseline 0.1, each child strictly better
    const proposeSpy = vi.fn<NonNullable<GepaDeps["propose"]>>(async () => ({ rationale: "r", operations: [{ target: "t-alpha", kind: "variable", op: "replaceInitializer", value: '"x"', rationale: "c" }] }));
    const opt = new Gepa(config({ runId: "accept" }), deps(runInput, proposeSpy));

    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: threeInputs });

    expect(result.acceptedCount).toBe(3);
    expect(result.rejectedCount).toBe(0);
    expect(result.iterations).toHaveLength(4); // baseline + 3 attempts
    expect(result.championIter).not.toBe("baseline");

    // (f) SelectModule round-robins one target per iteration: alpha, beta, alpha
    const targetSections = proposeSpy.mock.calls.map((c) => c[1].targets);
    expect(targetSections[0]).toContain("t-alpha");
    expect(targetSections[0]).not.toContain("t-beta");
    expect(targetSections[1]).toContain("t-beta");
    expect(targetSections[1]).not.toContain("t-alpha");
    expect(targetSections[2]).toContain("t-alpha");
  });

  it("reports run start, baseline, and a decision per iteration through the injected reporter", async () => {
    const runInput = vi.fn(scoredRunner([0.1, 0.2, 0.3, 0.4]));
    const events: string[] = [];
    const reporter = {
      gradingSetup: () => {},
      runStarted: (a: { optimizer: string; iterations: number }) => events.push(`start ${a.optimizer} x${a.iterations}`),
      baselineScored: (a: { objective: number }) => events.push(`baseline ${a.objective.toFixed(1)}`),
      iterationDecided: (a: { iter: number; decision: string; durationMs?: number }) =>
        events.push(`iter ${a.iter} ${a.decision} timed=${typeof a.durationMs === "number"}`),
      note: () => events.push("note"),
      runFinished: () => events.push("finished"),
    };
    const opt = new Gepa(config({ runId: "report" }), { ...deps(runInput), reporter });

    await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: threeInputs });

    expect(events[0]).toBe("start gepa x3");
    expect(events[1]).toBe("baseline 0.1");
    expect(events).toContain("note"); // GEPA notes the sampled Pareto parent each iteration
    expect(events.filter((e) => e.startsWith("iter"))).toEqual([
      "iter 1 accepted timed=true", "iter 2 accepted timed=true", "iter 3 accepted timed=true",
    ]);
    expect(events.at(-1)).toBe("finished");
  });

  it("rejects non-improving children, skips the full eval, and re-grades the parent from cache", async () => {
    const runInput = vi.fn(scoredRunner([0.9, 0.1, 0.1, 0.1])); // baseline 0.9, children 0.1 → always rejected
    const opt = new Gepa(config({ runId: "reject" }), deps(runInput));

    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: threeInputs });

    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(3);
    expect(result.championIter).toBe("baseline");

    // baseline: 3 runs (all pareto inputs). Each iteration: child on minibatch (2 fresh runs),
    // parent re-grade on minibatch (cache hits → 0 runs), and NO full eval (rejected).
    // A full eval would add the 3rd input per child (+1 each) → 12. Rejection path = 3 + 3*2 = 9.
    expect(runInput).toHaveBeenCalledTimes(9);
  });
});
