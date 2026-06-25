import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseGrader } from "./grading/baseGrader.js";
import type { Grade, GraderInput, GraderOptions, Input } from "./grading/types.js";
import type { Scorecard } from "./grading/scorecard.js";
import { BaseOptimizer } from "./baseOptimizer.js";
import type { OptimizeTargetSet } from "./targets.js";
import type { OptimizeResult } from "./types.js";

// Capture the call the optimizer makes into evalRunLoadedInputs so we can
// assert the new spec: seed + overlayFiles travel out-of-band, no
// working_dir on the per-input spec, agent path points at source.baseDir.
const { mockEval } = vi.hoisted(() => ({ mockEval: vi.fn() }));
vi.mock("@/cli/eval/run.js", () => ({
  evalRunLoadedInputs: mockEval,
  optimizeEvalRecordExtractor: {},
  resolveEvalRunTarget: vi.fn(),
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
      const recordPath = path.join(root, `${args.runId}-record.json`);
      fs.writeFileSync(recordPath, JSON.stringify({ evalOutputs: [{ value: "out" }] }));
      return { inputs: [{ status: "success", evalRecordPath: recordPath, input }] };
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
    return { baseDir: src, entryFile: "agent.agency", files: {}, targets: [] };
  }

  it("passes seed + overlayFiles to evalRunLoadedInputs; no working_dir on input", async () => {
    const p = probe();
    const ws = p.forkAt();
    const files = { "agent.agency": "node main() { return 1 }\n" };
    await p.evaluateAt(ws, source(), files, [{ id: "a", args: {} }]);

    expect(mockEval).toHaveBeenCalledTimes(1);
    const call = mockEval.mock.calls[0][0];
    expect(call.seed).toEqual({ dir: src, agentRelPath: "agent.agency" });
    expect(call.overlayFiles).toEqual(files);
    expect(call.agent).toBe(path.join(src, "agent.agency"));
    expect((call.inputs[0] as Input).working_dir).toBeUndefined();
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
