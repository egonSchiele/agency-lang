import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseGrader } from "@/eval/grading/baseGrader.js";
import type { Grade, GraderInput, GraderOptions, Input } from "@/eval/grading/types.js";
import type { Scorecard } from "@/eval/grading/scorecard.js";
import { BaseOptimizer } from "./baseOptimizer.js";
import { cleanupFakeRuns, fakeRun } from "./testUtils.js";
import type { OptimizeTargetSet } from "./targets.js";
import type { OptimizeResult } from "./types.js";

// Capture the call the optimizer makes into runSuite so we can assert the
// threading: seed + overlayFiles travel under perRun.
const { mockEval } = vi.hoisted(() => ({ mockEval: vi.fn() }));
vi.mock("@/eval/run/runSuite.js", () => ({
  runSuite: mockEval,
}));

class FixedGrader extends BaseGrader {
  protected readonly defaultName = "fixed";
  constructor(private readonly grade: Grade, options: GraderOptions = {}) { super(options); }
  protected _run(_input: GraderInput): Promise<Grade> { return Promise.resolve(this.grade); }
}

/** Concrete subclass exposing `evaluate`/`fork` so we can drive the default runInput path. */
class Probe extends BaseOptimizer {
  readonly name = "probe";
  protected async optimizeTargets(): Promise<OptimizeResult> { return {} as OptimizeResult; }
  evaluateAt(
    ws: ReturnType<Probe["fork"]>,
    source: OptimizeTargetSet,
    files: Record<string, string>,
    inputs: Input[],
  ): Promise<Scorecard> {
    return this.evaluate(ws, source, files, inputs);
  }
  forkAt() { return this.fork(); }
}

afterEach(cleanupFakeRuns);

describe("BaseOptimizer.runInputViaEval threads seed + overlayFiles", () => {
  let root: string;
  let src: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bo-wd-"));
    src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "agent.agency"), "node main() {}\n");
    fs.writeFileSync(path.join(src, "data.txt"), "hello\n");

    mockEval.mockImplementation(async (args: { runsDir: string; runId: string; inputs: Input[] }) => {
      const input = args.inputs[0];
      // A real one-input run directory: the optimizer grades it via gradeRun.
      const runDir = fakeRun(input.id ?? "a", "out", input);
      return { runDir, inputs: [{ inputId: input.id ?? "a", status: "success" }] };
    });
  });
  afterEach(() => {
    mockEval.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function probe(): Probe {
    return new Probe(
      { graders: [new FixedGrader({ score: { kind: "scalar", value: 1 } })], iterations: 1, config: {}, runsDir: root, runId: "r" },
    );
  }

  function source(): OptimizeTargetSet {
    return { baseDir: src, entryFile: "agent.agency", files: {}, targets: [], typeAliases: {} };
  }

  it("passes seed + overlayFiles to runSuite under perRun", async () => {
    const p = probe();
    const ws = p.forkAt();
    const files = { "agent.agency": "node main() { return 1 }\n" };
    await p.evaluateAt(ws, source(), files, [{ id: "a", args: {} }]);

    expect(mockEval).toHaveBeenCalledTimes(1);
    const call = mockEval.mock.calls[0][0];
    // closureFiles mirrors source.files (empty in this fixture) — the threading
    // is what's under test, not the discovery.
    expect(call.perRun.seed).toEqual({ baseDir: src, agentRelPath: "agent.agency", closureFiles: [] });
    expect(call.perRun.overlayFiles).toEqual(files);
    expect(call.agent).toBe(path.join(src, "agent.agency"));
  });

  it("partitions agent-runs by ws.key so caching is per-candidate", async () => {
    const p = probe();
    const ws1 = p.forkAt();
    const ws2 = p.forkAt();
    await p.evaluateAt(ws1, source(), {}, [{ id: "a", args: {} }]);
    await p.evaluateAt(ws2, source(), {}, [{ id: "a", args: {} }]);

    expect(ws1.key).not.toBe(ws2.key);
    expect(mockEval.mock.calls[0][0].runsDir).toContain(ws1.key);
    expect(mockEval.mock.calls[1][0].runsDir).toContain(ws2.key);
  });
});
