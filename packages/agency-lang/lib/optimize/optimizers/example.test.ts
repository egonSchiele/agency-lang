import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunInput } from "../baseOptimizer.js";
import { BaseGrader } from "../grading/baseGrader.js";
import type { Grade, GraderInput } from "../grading/types.js";
import type { BaseOptimizerConfig } from "../optimizer.js";
import type { OptimizeMutationPreview } from "../sourceMutator.js";
import type { OptimizeTargetSet } from "../targets.js";
import { ExampleOptimizer, type ExampleDeps } from "./example.js";

/** Returns the next scalar from a fixed queue — lets a test set baseline vs candidate scores. */
class QueueGrader extends BaseGrader {
  protected readonly defaultName = "queue";
  private i = 0;
  constructor(private readonly scores: number[]) { super({}); }
  protected _run(_input: GraderInput): Promise<Grade> {
    return Promise.resolve({ score: { kind: "scalar", value: this.scores[this.i++] ?? 0 } });
  }
}

describe("ExampleOptimizer", () => {
  let root: string;
  let src: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "example-opt-"));
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

  const runInput: RunInput = async () => ({ output: "out", recordPath: "" });

  function deps(over: Partial<ExampleDeps> = {}): ExampleDeps {
    return {
      workspaceRoot: path.join(root, "ws"),
      runInput,
      discover: () => fakeSource(),
      propose: async () => ({ rationale: "tighten", operations: [] }),
      preview: (targetSet): OptimizeMutationPreview => ({ files: { "agent.agency": "x" }, changes: [], diff: "", diagnostics: [], targetSet }),
      ...over,
    };
  }

  const config = (graders: BaseGrader[], runId: string): BaseOptimizerConfig =>
    ({ graders, iterations: 1, config: {}, runsDir: root, runId, writeback: false });

  const run = (opt: ExampleOptimizer) =>
    opt.optimize({ agent: path.join(src, "agent.agency"), inputs: [{ id: "a", args: {} }] });

  it("keeps the candidate when it beats the baseline", async () => {
    const opt = new ExampleOptimizer(config([new QueueGrader([0.2, 0.9])], "accept"), deps());
    const result = await run(opt);
    expect(result.championIter).toBe(1);
    expect(result.acceptedCount).toBe(1);
  });

  it("keeps the baseline when the candidate does not beat it", async () => {
    const opt = new ExampleOptimizer(config([new QueueGrader([0.9, 0.2])], "reject"), deps());
    const result = await run(opt);
    expect(result.championIter).toBe("baseline");
    expect(result.rejectedCount).toBe(1);
  });

  it("keeps the baseline when the proposed mutation fails validation", async () => {
    const preview = (targetSet: OptimizeTargetSet): OptimizeMutationPreview =>
      ({ files: {}, changes: [], diff: "", diagnostics: [{ target: "agent.agency:global:prompt", code: "invalid-replacement-syntax", message: "bad" }], targetSet });
    const opt = new ExampleOptimizer(config([new QueueGrader([0.5])], "invalid"), deps({ preview }));
    const result = await run(opt);
    expect(result.championIter).toBe("baseline");
  });
});
