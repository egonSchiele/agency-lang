import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseGrader } from "./grading/baseGrader.js";
import type { Grade, GraderInput, GraderOptions, Input } from "./grading/types.js";
import type { Scorecard } from "./grading/scorecard.js";
import { BaseOptimizer } from "./baseOptimizer.js";
import type { OptimizeResult } from "./types.js";

// Capture the spec the default eval-run path hands to the eval runner so we can
// assert it carries a working_dir (without spawning a real agent subprocess).
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

/** Concrete subclass exposing `evaluate` so we can drive the default runInput path. */
class Probe extends BaseOptimizer {
  readonly name = "probe";
  protected async optimizeTargets(): Promise<OptimizeResult> { return {} as OptimizeResult; }
  evaluateAt(ws: ReturnType<Probe["fork"]>, entry: string, inputs: Input[]): Promise<Scorecard> {
    return this.evaluate(ws, entry, inputs);
  }
  forkAt(dir: string) { return this.fork(dir); }
}

describe("BaseOptimizer.runInputViaEval working_dir", () => {
  let root: string;
  let src: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bo-wd-"));
    src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "agent.agency"), "node main() {}\n");
    // A sibling file the agent would reference relative to its cwd (the workdir).
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
      { workspaceRoot: path.join(root, "ws") },
    );
  }

  it("points the per-input working_dir at the forked workspace so its files land in the workdir", async () => {
    const p = probe();
    const ws = p.forkAt(src);
    await p.evaluateAt(ws, "agent.agency", [{ id: "a", args: {} }]);

    expect(mockEval).toHaveBeenCalledTimes(1);
    const spec = mockEval.mock.calls[0][0].inputs[0] as Input;
    // The workspace is a full copy of the source tree; the per-input workdir must
    // be seeded from it, or relative file references resolve against an empty dir.
    expect(spec.working_dir).toBe(ws.dir);
    expect(fs.existsSync(path.join(ws.dir, "data.txt"))).toBe(true);
  });

  it("preserves an input-provided working_dir instead of overriding it", async () => {
    const p = probe();
    const ws = p.forkAt(src);
    const custom = path.join(root, "custom");
    fs.mkdirSync(custom);
    await p.evaluateAt(ws, "agent.agency", [{ id: "a", args: {}, working_dir: custom }]);

    const spec = mockEval.mock.calls[0][0].inputs[0] as Input;
    expect(spec.working_dir).toBe(custom);
  });
});
