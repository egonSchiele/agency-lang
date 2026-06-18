import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BaseGrader } from "./grading/baseGrader.js";
import type { Grade, GraderInput, GraderOptions } from "./grading/types.js";
import { GreedyReflective, type GreedyDeps } from "./greedyReflective.js";
import type { OptimizeMutationPreview } from "./sourceMutator.js";
import type { OptimizeTargetSet } from "./targets.js";

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
    files: { "agent.agency": { file: "agent.agency", absoluteFile: path.join(src, "agent.agency"), source: "x", sha256: "x" } },
    targets: [{ id: "agent.agency:global:prompt", kind: "variable", file: "agent.agency", absoluteFile: path.join(src, "agent.agency"), scope: "global", name: "prompt", valueKind: "string", value: "hi" }],
  });

  const deps = (): GreedyDeps => ({
    workspaceRoot: path.join(root, "ws"),
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
    const scalar = new ValueGrader(() => 1); // would beat baseline, but the gate fails after baseline
    const opt = new GreedyReflective(
      { graders: [gate, scalar], iterations: 1, config: {}, runsDir: root, runId: "r3", writeback: false },
      deps(),
    );
    const result = await opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });
    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
  });
});
