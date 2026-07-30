import * as fs from "fs";
import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { grader } from "@/eval/grading/functionGrader.js";
import { ExactMatchGrader as ExactMatch } from "@/eval/grading/graders/builtinGraders.js";
import type { EvalInputRunner, EvalRecordExtractor } from "@/eval/runEvalInput.js";

import { mergeChainOutcomes } from "@/runtime/interrupts.js";

import { evalInterruptDecision, evalRun, evalRunLoadedInputs, resolveEvalRunTarget, validateInputSelection } from "./run.js";

/** Pretends the agent ran. Must write a non-empty statelog: `shouldExtractStatelog`
 *  skips the extractor when the log is absent or empty, and then grading sees no
 *  eval record and scores every input 0. */
const okRunner: EvalInputRunner = async ({ statelogPath }) => {
  fs.writeFileSync(statelogPath, "{}\n");
  return { ok: true };
};

/** Writes the eval record grading reads, with one output value. */
function recordExtractor(output: unknown): EvalRecordExtractor {
  return async ({ outPath }) => {
    fs.writeFileSync(outPath, JSON.stringify({
      traceId: "t", recordVersion: 2, formatVersion: 1, durationMs: 1, source: "s",
      evalValues: [], evalOutputs: [{ value: output, threadId: "0", tMs: 1 }],
      threads: [], events: [], interrupts: [], errors: [], incomplete: [],
      metrics: {
        llmCalls: 0, toolStarts: 0, toolEnds: 0, models: [],
        tokensInTotal: 0, tokensOutTotal: 0, costUsdTotal: 0, toolCounts: {},
      },
      warnings: [],
    }));
  };
}

describe("eval run CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-run-cli-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves file and directory agent targets", () => {
    const file = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(file, "node main() {}\n");
    const dir = path.join(tmpDir, "agent-dir");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "main.agency"), "node main() {}\n");

    expect(resolveEvalRunTarget(`${file}:evalMain`)).toEqual({ agentFile: file, node: "evalMain", label: `${file}:evalMain` });
    expect(resolveEvalRunTarget(file)).toEqual({ agentFile: file, node: "main", label: `${file}:main` });
    expect(resolveEvalRunTarget(dir)).toEqual({ agentFile: path.join(dir, "main.agency"), node: "main", label: `${path.join(dir, "main.agency")}:main` });
  });

  it("requires exactly one of inputs or goal", () => {
    expect(() => validateInputSelection({})).toThrow(/one of/i);
    expect(() => validateInputSelection({ inputs: "inputs.json", goal: "goal" })).toThrow(/one of/i);
    expect(validateInputSelection({ goal: "goal" })).toBe("goal");
  });

  it("compiles, runs each task through the injected runner, and writes artifacts", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main() {}\n");
    const runsDir = path.join(tmpDir, "runs");

    const result = await evalRun(
      {
        agent: agentFile,
        goal: "do it",
        runsDir,
        runId: "r1",
        grade: false,
        continueOnError: true,
      },
      {
        runner: async ({ statelogPath }) => {
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: true };
        },
        extractor: async ({ outPath }) => {
          fs.writeFileSync(outPath, "{}");
        },
      },
    );

    expect(result).toMatchObject({ runId: "r1", okCount: 1, errorCount: 0 });
    expect(result.inputs[0]).toMatchObject({ status: "success" });
    expect(fs.existsSync(path.join(runsDir, "r1", "inputs", result.inputs[0].inputId, "agent", "eval-record.json"))).toBe(true);
  });

  it("throws setup failures before creating a run directory", async () => {
    const runsDir = path.join(tmpDir, "runs");

    await expect(evalRun({
      agent: path.join(tmpDir, "missing.agency"),
      goal: "do it",
      runsDir,
      runId: "setup-failed",
      continueOnError: true,
    })).rejects.toThrow();

    expect(fs.existsSync(path.join(runsDir, "setup-failed"))).toBe(false);
  });

  it("extracts from workdir statelog.log when runtime overrides do not redirect the log file", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main() {}\n");
    const runsDir = path.join(tmpDir, "runs");
    let extractorStatelogPath = "";

    const result = await evalRun(
      {
        agent: agentFile,
        goal: "do it",
        runsDir,
        runId: "fallback",
        grade: false,
        continueOnError: true,
      },
      {
        runner: async ({ cwd }) => {
          fs.writeFileSync(path.join(cwd, "statelog.log"), "{}\n");
          return { ok: true };
        },
        extractor: async ({ statelogPath, outPath }) => {
          extractorStatelogPath = statelogPath;
          fs.writeFileSync(outPath, JSON.stringify({ source: statelogPath }));
        },
      },
    );

    const inputResult = result.inputs[0];
    expect(inputResult).toMatchObject({ status: "success" });
    expect(extractorStatelogPath).toBe(inputResult.statelogPath);
    expect(fs.readFileSync(inputResult.statelogPath, "utf-8")).toBe("{}\n");
    expect(fs.existsSync(inputResult.evalRecordPath)).toBe(true);
  });

  it("stops after the first task error when continueOnError is false", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main() {}\n");
    const runsDir = path.join(tmpDir, "runs");
    const inputsFile = path.join(tmpDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({
      inputs: [
        { id: "first", goal: "g1", args: {} },
        { id: "second", goal: "g2", args: {} },
      ],
    }));

    let runs = 0;
    const result = await evalRun(
      {
        agent: agentFile,
        inputs: inputsFile,
        runsDir,
        runId: "stop",
        grade: false,
        continueOnError: false,
      },
      {
        runner: async () => {
          runs += 1;
          return { ok: false, errorMessage: "nope" };
        },
        extractor: async () => {},
      },
    );

    expect(runs).toBe(1);
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toMatchObject({
      inputId: "first",
      status: "error",
      // The message now carries the seeded-file listing for diagnosability.
      errorMessage: expect.stringMatching(/^nope\n\nWorkdir was seeded with/),
    });
    expect(fs.readFileSync(path.join(runsDir, "stop", "inputs", "first", "agent", "error.txt"), "utf-8")).toMatch(/^nope\n/);
    expect(JSON.parse(fs.readFileSync(path.join(runsDir, "stop", "summary.json"), "utf-8"))).toMatchObject({
      okCount: 0,
      errorCount: 1,
      inputs: [{ inputId: "first", status: "error", errorMessage: expect.stringMatching(/^nope\n\nWorkdir was seeded with/) }],
    });
  });

  it("accepts a git source for --inputs and records provenance in config.json", async () => {
    // A local repo of test directories; local path + ?ref= exercises the same
    // resolver path as a remote URL, with no network.
    const suiteRepo = path.join(tmpDir, "suite-repo");
    fs.mkdirSync(path.join(suiteRepo, "capital", "files"), { recursive: true });
    fs.writeFileSync(path.join(suiteRepo, "capital", "test.json"), JSON.stringify({ goal: "g", args: {} }));
    fs.writeFileSync(path.join(suiteRepo, "capital", "files", "hint.txt"), "Paris");
    const gitInSuite = (...gitArgs: string[]) => execFileSync("git", gitArgs, { cwd: suiteRepo, encoding: "utf8" }).trim();
    gitInSuite("init", "-q", "-b", "main");
    gitInSuite("add", "-A");
    gitInSuite("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "suite");
    const suiteSha = gitInSuite("rev-parse", "HEAD");

    const agentDir = path.join(tmpDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const agent = path.join(agentDir, "agent.agency");
    fs.writeFileSync(agent, "node main() {}\n");

    const result = await evalRun(
      {
        agent,
        inputs: `${suiteRepo}?ref=${suiteSha}`,
        runsDir: path.join(tmpDir, "runs"),
        runId: "gitsuite",
        grade: false,
        config: { eval: { sourceCacheRoot: path.join(tmpDir, "cache") } },
      },
      {
        runner: async ({ cwd, statelogPath }) => {
          fs.writeFileSync(statelogPath, "{}\n");
          return fs.existsSync(path.join(cwd, "hint.txt"))
            ? { ok: true }
            : { ok: false, errorMessage: "fixture missing" };
        },
        extractor: async () => {},
      },
    );

    expect(result.inputs[0].status).toBe("success");
    const runConfig = JSON.parse(fs.readFileSync(path.join(tmpDir, "runs", "gitsuite", "config.json"), "utf8"));
    expect(runConfig.provenance.inputsSource).toEqual({ source: `${suiteRepo}?ref=${suiteSha}`, sha: suiteSha });
    expect(runConfig.provenance.agent.closure.length).toBeGreaterThan(0);
    expect(runConfig.provenance.agent.closure[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("seeds an input's files directory into the workdir", async () => {
    const filesDir = path.join(tmpDir, "fixtures");
    fs.mkdirSync(path.join(filesDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(filesDir, "data", "report.txt"), "q3");
    const agentDir = path.join(tmpDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const agent = path.join(agentDir, "agent.agency");
    fs.writeFileSync(agent, "node main() {}\n");

    let sawFixture = false;
    const result = await evalRunLoadedInputs(
      {
        agent,
        inputs: [{ id: "a", goal: "g", args: {}, files: filesDir }],
        inputsSource: "test",
        runsDir: path.join(tmpDir, "runs"),
        runId: "files-e2e",
      },
      {
        runner: async ({ cwd, statelogPath }) => {
          sawFixture = fs.existsSync(path.join(cwd, "data", "report.txt"));
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: true };
        },
        extractor: async () => {},
      },
    );

    expect(result.inputs[0].status).toBe("success");
    expect(sawFixture).toBe(true);
  });

  describe("grading", () => {
/** An agent file plus the shared run options every grading case uses. The runs
     *  directory is a sibling of the agent's directory, never inside it: the seed
     *  copy would otherwise recurse into its own destination. */
    function setup(runId: string, inputs: { id: string; goal: string; args: Record<string, unknown> }[]) {
      const agentDir = path.join(tmpDir, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const agent = path.join(agentDir, "agent.agency");
      fs.writeFileSync(agent, "node main() {}\n");
      const runsDir = path.join(tmpDir, "runs");
      return { agent, inputs, inputsSource: "test", runsDir, runId };
    }

    it("writes a grading block into summary.json and reports a failed gate", async () => {
      const opts = setup("graded", [{ id: "a", goal: "g", args: {} }]);
      const result = await evalRunLoadedInputs(
        { ...opts, graders: [grader(() => false, { name: "gate", mustPass: true })] },
        { runner: okRunner, extractor: recordExtractor("hello") },
      );

      expect(result.grading).toBeDefined();
      expect(result.grading!.gatesPassed).toBe(false);
      const summary = JSON.parse(fs.readFileSync(path.join(tmpDir, "runs", "graded", "summary.json"), "utf8"));
      expect(summary.grading.graders).toEqual(["gate"]);
      expect(fs.existsSync(path.join(tmpDir, "runs", "graded", "verifier", "grading.json"))).toBe(true);
    });

    it("counts a gate-failed input as a zero rather than zeroing the whole run", async () => {
      const opts = setup("mixed", [
        { id: "a", goal: "g", args: {} },
        { id: "b", goal: "g", args: {} },
      ]);
      const result = await evalRunLoadedInputs(
        // Passes on input "a", fails the gate on input "b".
        { ...opts, graders: [grader(({ input }) => input.id === "a", { name: "gate", mustPass: true })] },
        { runner: okRunner, extractor: recordExtractor("hello") },
      );

      // One of two inputs scored 1, the other 0 — the mean is 0.5, not 0.
      expect(result.grading!.objective).toBeCloseTo(0.5);
      expect(result.grading!.gatesPassed).toBe(false);
    });

    it("rejects a misconfigured grader before running any agent", async () => {
      const opts = setup("badgrader", [{ id: "a", goal: "g", args: {} }]);
      let ran = false;
      const countingRunner: EvalInputRunner = async ({ statelogPath }) => {
        ran = true;
        fs.writeFileSync(statelogPath, "{}\n");
        return { ok: true };
      };

      // ExactMatch's matchOn defaults to `expected`, which this input lacks.
      await expect(evalRunLoadedInputs(
        { ...opts, graders: [new ExactMatch({})] },
        { runner: countingRunner, extractor: recordExtractor("hello") },
      )).rejects.toThrow(/matchOn/);

      expect(ran).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "runs", "badgrader"))).toBe(false);
    });

    it("skips grading when no graders are supplied, so the optimizer path is unaffected", async () => {
      const opts = setup("ungraded", [{ id: "a", goal: "g", args: {} }]);
      const result = await evalRunLoadedInputs(opts, {
        runner: okRunner,
        extractor: recordExtractor("hello"),
      });

      expect(result.grading).toBeUndefined();
      const summary = JSON.parse(fs.readFileSync(path.join(tmpDir, "runs", "ungraded", "summary.json"), "utf8"));
      expect(summary).not.toHaveProperty("grading");
    });
  });

  it("answers subprocess interrupts in the shape sendInterruptToParent consumes", () => {
    const decision = evalInterruptDecision("int-1");

    // The exact regression: the parent once sent { approved: true } with no
    // outcome, and the child crashed reading `outcome.kind`. Pin the contract
    // by pushing the reply through the runtime's own merge.
    expect(decision).toMatchObject({ type: "decision", interruptId: "int-1" });
    const merged = mergeChainOutcomes("std::write", { kind: "approved", value: undefined }, decision.outcome);
    expect(merged.kind).toBe("approved");
  });
});
