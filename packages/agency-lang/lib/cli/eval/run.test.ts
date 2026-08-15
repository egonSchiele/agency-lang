import * as fs from "fs";
import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { grader } from "@/eval/grading/functionGrader.js";
import { ExactMatchGrader as ExactMatch } from "@/eval/grading/graders/builtinGraders.js";
import type { EvalRecordExtractor } from "@/eval/run/extract.js";
import type { EvalInputRunner } from "@/eval/run/subprocess.js";

import { validateGraders } from "@/eval/grading/gradeRun.js";
import { recordGrading } from "@/eval/grading/recordGrading.js";
import { runSuite } from "@/eval/run/runSuite.js";
import { evalRun, totalRunCostUsd, validateInputSelection } from "./run.js";

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
    fs.writeFileSync(
      outPath,
      JSON.stringify({
        traceId: "t",
        recordVersion: 2,
        formatVersion: 1,
        durationMs: 1,
        source: "s",
        evalValues: [],
        evalOutputs: [{ value: output, threadId: "0", tMs: 1 }],
        threads: [],
        events: [],
        interrupts: [],
        errors: [],
        incomplete: [],
        metrics: {
          llmCalls: 0,
          toolStarts: 0,
          toolEnds: 0,
          models: [],
          tokensInTotal: 0,
          tokensOutTotal: 0,
          costUsdTotal: 0,
          toolCounts: {},
        },
        warnings: [],
      }),
    );
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

  it("requires exactly one of inputs or goal", () => {
    expect(() => validateInputSelection({})).toThrow(/--inputs or --goal/);
    expect(() => validateInputSelection({ inputs: "inputs.json", goal: "goal" })).toThrow(
      /one of/i,
    );
    expect(validateInputSelection({ goal: "goal" })).toBe("goal");
  });

  it("compiles, runs each task through the injected runner, and writes artifacts", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main(task: string) {}\n");
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
    expect(
      fs.existsSync(
        path.join(runsDir, "r1", "inputs", result.inputs[0].inputId, "agent", "eval-record.json"),
      ),
    ).toBe(true);
  });

  it("rejects an empty suite instead of succeeding with zero inputs", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main(task: string) {}\n");
    const inputsFile = path.join(tmpDir, "empty.json");
    fs.writeFileSync(inputsFile, JSON.stringify({ inputs: [] }));
    const runsDir = path.join(tmpDir, "runs");

    await expect(
      evalRun({
        agent: agentFile,
        inputs: inputsFile,
        runsDir,
        runId: "empty",
        grade: false,
      }),
    ).rejects.toThrow(/no inputs loaded from/);

    expect(fs.existsSync(path.join(runsDir, "empty"))).toBe(false);
  });

  it("throws setup failures before creating a run directory", async () => {
    const runsDir = path.join(tmpDir, "runs");

    await expect(
      evalRun({
        agent: path.join(tmpDir, "missing.agency"),
        goal: "do it",
        runsDir,
        runId: "setup-failed",
        continueOnError: true,
      }),
    ).rejects.toThrow();

    expect(fs.existsSync(path.join(runsDir, "setup-failed"))).toBe(false);
  });

  it("extracts from workdir statelog.log when runtime overrides do not redirect the log file", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main(task: string) {}\n");
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
    fs.writeFileSync(agentFile, "node main(task: string) {}\n");
    const runsDir = path.join(tmpDir, "runs");
    const inputsFile = path.join(tmpDir, "inputs.json");
    fs.writeFileSync(
      inputsFile,
      JSON.stringify({
        inputs: [
          { id: "first", goal: "g1", task: "t" },
          { id: "second", goal: "g2", task: "t" },
        ],
      }),
    );

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
    expect(
      fs.readFileSync(path.join(runsDir, "stop", "inputs", "first", "agent", "error.txt"), "utf-8"),
    ).toMatch(/^nope\n/);
    expect(
      JSON.parse(fs.readFileSync(path.join(runsDir, "stop", "summary.json"), "utf-8")),
    ).toMatchObject({
      okCount: 0,
      errorCount: 1,
      inputs: [
        {
          inputId: "first",
          status: "error",
          errorMessage: expect.stringMatching(/^nope\n\nWorkdir was seeded with/),
        },
      ],
    });
  });

  it("accepts a git source for --inputs and records provenance in config.json", async () => {
    // A local repo of test directories; local path + ?ref= exercises the same
    // resolver path as a remote URL, with no network.
    const suiteRepo = path.join(tmpDir, "suite-repo");
    fs.mkdirSync(path.join(suiteRepo, "capital", "files"), { recursive: true });
    fs.writeFileSync(
      path.join(suiteRepo, "capital", "test.json"),
      JSON.stringify({ goal: "g", task: "t" }),
    );
    fs.writeFileSync(path.join(suiteRepo, "capital", "files", "hint.txt"), "Paris");
    const gitInSuite = (...gitArgs: string[]) =>
      execFileSync("git", gitArgs, { cwd: suiteRepo, encoding: "utf8" }).trim();
    gitInSuite("init", "-q", "-b", "main");
    gitInSuite("add", "-A");
    gitInSuite("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "suite");
    const suiteSha = gitInSuite("rev-parse", "HEAD");

    const agentDir = path.join(tmpDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const agent = path.join(agentDir, "agent.agency");
    fs.writeFileSync(agent, "node main(task: string) {}\n");

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
        extractor: recordExtractor("ok"),
      },
    );

    expect(result.inputs[0].status).toBe("success");
    const runConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "runs", "gitsuite", "config.json"), "utf8"),
    );
    expect(runConfig.provenance.inputsSource).toEqual({
      source: `${suiteRepo}?ref=${suiteSha}`,
      sha: suiteSha,
    });
    expect(runConfig.provenance.agent.closure.length).toBeGreaterThan(0);
    expect(runConfig.provenance.agent.closure[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("grading", () => {
    /** An agent file plus the shared run options every grading case uses. The runs
     *  directory is a sibling of the agent's directory, never inside it: the seed
     *  copy would otherwise recurse into its own destination. */
    function setup(runId: string, inputs: { id: string; goal: string; task: string }[]) {
      const agentDir = path.join(tmpDir, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const agent = path.join(agentDir, "agent.agency");
      fs.writeFileSync(agent, "node main(task: string) {}\n");
      const runsDir = path.join(tmpDir, "runs");
      return { agent, inputs, runsDir, runId };
    }

    it("recordGrading writes the grading block into summary.json and reports a failed gate", async () => {
      const opts = setup("graded", [{ id: "a", goal: "g", task: "t" }]);
      const summary = await runSuite(
        { ...opts, perRun: { extractor: recordExtractor("hello") } },
        { runner: okRunner },
      );
      expect(summary.grading).toBeUndefined(); // the runner never grades

      const grading = await recordGrading(
        summary.runDir,
        { mode: "override", graders: [grader(() => false, { name: "gate", mustPass: true })] },
        {},
      );

      expect(grading.gatesPassed).toBe(false);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "runs", "graded", "summary.json"), "utf8"),
      );
      expect(onDisk.grading.graders).toEqual(["gate"]);
      expect(fs.existsSync(path.join(tmpDir, "runs", "graded", "verifier", "grading.json"))).toBe(
        true,
      );
    });

    it("counts a gate-failed input as a zero rather than zeroing the whole run", async () => {
      const opts = setup("mixed", [
        { id: "a", goal: "g", task: "t" },
        { id: "b", goal: "g", task: "t" },
      ]);
      const summary = await runSuite(
        { ...opts, perRun: { extractor: recordExtractor("hello") } },
        { runner: okRunner },
      );
      // Passes on input "a", fails the gate on input "b".
      const grading = await recordGrading(
        summary.runDir,
        {
          mode: "override",
          graders: [grader(({ input }) => input.id === "a", { name: "gate", mustPass: true })],
        },
        {},
      );

      // One of two inputs scored 1, the other 0 — the mean is 0.5, not 0.
      expect(grading.objective).toBeCloseTo(0.5);
      expect(grading.gatesPassed).toBe(false);
    });

    it("a misconfigured grader is rejected by validation (evalRun calls this before any agent runs)", () => {
      // ExactMatch's matchOn defaults to `expected`, which this input lacks.
      // The fail-fast ordering itself lives in evalRun: resolve → validate →
      // run → grade; the runner no longer knows graders exist.
      expect(() =>
        validateGraders([new ExactMatch({})], { id: "a", goal: "g", task: "t" }),
      ).toThrow(/matchOn/);
    });
  });

  it("totalRunCostUsd sums record costs across inputs and tolerates missing records", () => {
    const a = path.join(tmpDir, "a.json");
    const b = path.join(tmpDir, "b.json");
    fs.writeFileSync(a, JSON.stringify({ metrics: { costUsdTotal: 0.25 } }));
    fs.writeFileSync(b, JSON.stringify({ metrics: { costUsdTotal: 0.5 } }));
    const result = {
      inputs: [
        { evalRecordPath: a },
        { evalRecordPath: b },
        { evalRecordPath: path.join(tmpDir, "missing.json") },
      ],
    } as never;
    expect(totalRunCostUsd(result)).toBeCloseTo(0.75);
    expect(
      totalRunCostUsd({ inputs: [{ evalRecordPath: path.join(tmpDir, "nope.json") }] } as never),
    ).toBeUndefined();
  });

  describe("per-test graders", () => {
    it("each test grades itself; a config module is the fallback; --graders overrides everything", async () => {
      const agentFile = path.join(tmpDir, "agent.agency");
      fs.writeFileSync(agentFile, "node main(task: string) {}\n");
      const runsDir = path.join(tmpDir, "runs");

      // Two test dirs: "self" carries its own grader (scores 1 on "hello"),
      // "plain" has none and falls back to the config module (scores 0).
      const suiteDir = path.join(tmpDir, "suite");
      fs.mkdirSync(path.join(suiteDir, "self"), { recursive: true });
      fs.writeFileSync(path.join(suiteDir, "self", "test.json"), JSON.stringify({ task: "t" }));
      fs.writeFileSync(
        path.join(suiteDir, "self", "graders.ts"),
        `export default ({ output }) => (output === "hello" ? 1 : 0);`,
      );
      fs.mkdirSync(path.join(suiteDir, "plain"), { recursive: true });
      fs.writeFileSync(path.join(suiteDir, "plain", "test.json"), JSON.stringify({ task: "t" }));
      const fallbackModule = path.join(tmpDir, "fallback.ts");
      fs.writeFileSync(fallbackModule, `export default () => 0;`);

      const result = await evalRun(
        {
          agent: agentFile,
          inputs: suiteDir,
          runsDir,
          runId: "per-test",
          config: { eval: { graders: fallbackModule } },
        },
        {
          runner: okRunner,
          extractor: recordExtractor("hello"),
        },
      );

      // "self" scored 1 by its own grader; "plain" scored 0 by the fallback.
      expect(result.grading?.objective).toBeCloseTo(0.5);

      // An explicit --graders replaces BOTH tests' graders.
      const overrideModule = path.join(tmpDir, "override.ts");
      fs.writeFileSync(overrideModule, `export default () => 1;`);
      const overridden = await evalRun(
        {
          agent: agentFile,
          inputs: suiteDir,
          runsDir,
          runId: "override",
          graders: overrideModule,
          config: { eval: { graders: fallbackModule } },
        },
        {
          runner: okRunner,
          extractor: recordExtractor("hello"),
        },
      );
      expect(overridden.grading?.objective).toBeCloseTo(1);
    });
  });

  describe("command targets", () => {
    it("--agent-cmd reaches the runner as a substituted command job", async () => {
      const runsDir = path.join(tmpDir, "runs");
      let job: { kind?: string; argv?: string[] } = {};

      const result = await evalRun(
        {
          agentCmd: "some-agent -p -- {task}",
          goal: "do it",
          runsDir,
          runId: "r-cmd",
          grade: false,
        },
        {
          runner: async (j) => {
            job = j as { kind: string; argv: string[] };
            fs.writeFileSync((j as { statelogPath: string }).statelogPath, "{}\n");
            return { ok: true };
          },
          extractor: async ({ outPath }) => {
            fs.writeFileSync(outPath, "{}");
          },
        },
      );

      expect(result.okCount).toBe(1);
      expect(job.kind).toBe("command");
      // --goal sets task = goal, so the substituted argv carries it
      expect(job.argv).toEqual(["some-agent", "-p", "--", "do it"]);
    });

    it("rejects neither/both agent flags and a command without {task}, before anything runs", async () => {
      await expect(evalRun({ goal: "g", grade: false })).rejects.toThrow(/exactly one of/);
      await expect(
        evalRun({ agent: "a.agency", agentCmd: "x {task}", goal: "g", grade: false }),
      ).rejects.toThrow(/exactly one of/);
      await expect(
        evalRun({ agentCmd: "agent-without-placeholder", goal: "g", grade: false }),
      ).rejects.toThrow(/\{task\}/);
    });
  });
});
