import * as fs from "fs";
import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { grader } from "@/eval/grading/functionGrader.js";
import { ExactMatchGrader as ExactMatch } from "@/eval/grading/graders/builtinGraders.js";
import { validateGraders } from "@/eval/grading/gradeRun.js";
import { gradeSuite } from "@/eval/grading/gradeSuite.js";
import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import { runSuite } from "@/eval/run/runSuite.js";
import type { EvalInputRunner, EvalRunnerJob } from "@/eval/run/subprocess.js";
import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";
import { finishedTraceLines } from "@/runDirectory/testFixtures.js";

import { evalGrade } from "./grade.js";
import { evalRun, totalRunCostUsd, validateInputSelection } from "./run.js";

/** A runner that behaves like a real child: a finished trace under the
 *  harness-minted trace id, recording the seeded code for file jobs. */
function traceRunner(output: unknown, observe?: (job: EvalRunnerJob) => void): EvalInputRunner {
  return async (job) => {
    observe?.(job);
    fs.writeFileSync(
      job.statelogPath,
      finishedTraceLines(job.traceId, {
        output,
        ...(job.kind === "file" ? { code: job.code, input: job.input } : {}),
      }).join("\n") + "\n",
    );
    return { ok: true };
  };
}

const okRunner = traceRunner("hello");
const quiet = { reportWarning: () => {} };

describe("eval run CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-run-cli-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--suite and --input are exclusive; neither means one input-less test", () => {
    expect(() => validateInputSelection({ suite: "inputs.json", input: "x" })).toThrow(/one of/i);
    expect(validateInputSelection({ input: "x" })).toBe("input");
    expect(validateInputSelection({ suite: "inputs.json" })).toBe("suite");
    expect(validateInputSelection({})).toBe("input");
  });

  it("runs an agent that takes no input when neither --suite nor --input is given", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main() {}\n");
    const runsDir = path.join(tmpDir, "runs");
    let seenInput: unknown = "unset";
    const result = await evalRun(
      { agent: agentFile, out: path.join(runsDir, "no-input") },
      {
        runner: async (job) => {
          seenInput = job.kind === "file" ? job.input : "not-a-file-job";
          return okRunner(job);
        },
      },
    );
    expect(result.okCount).toBe(1);
    expect(seenInput).toBeUndefined();
    const run = readRunDirectory(result.tests[0].runDir, quiet).effectiveAnnotations[
      result.tests[0].traceId
    ].run as unknown as { test: { input?: unknown } };
    expect(run.test.input).toBeUndefined();
  });

  it("refuses --input for a node that takes no parameter, and no input for a node that takes one", async () => {
    const noParam = path.join(tmpDir, "no-param.agency");
    fs.writeFileSync(noParam, "node main() {}\n");
    const oneParam = path.join(tmpDir, "one-param.agency");
    fs.writeFileSync(oneParam, "node main(task: string) {}\n");
    const runsDir = path.join(tmpDir, "runs");
    await expect(
      evalRun({ agent: noParam, input: "x", out: path.join(runsDir, "a") }, { runner: okRunner }),
    ).rejects.toThrow(/takes none/);
    await expect(
      evalRun({ agent: oneParam, out: path.join(runsDir, "b") }, { runner: okRunner }),
    ).rejects.toThrow(/no test provides an input/);
  });

  it("compiles, runs each test through the injected runner, and writes a run directory — never grading", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main(input: string) {}\n");
    const runsDir = path.join(tmpDir, "runs");

    const result = await evalRun(
      { agent: agentFile, input: "do it", out: path.join(runsDir, "r1") },
      { runner: okRunner },
    );

    expect(result).toMatchObject({ okCount: 1, errorCount: 0 });
    expect(result.tests[0]).toMatchObject({ status: "success" });
    const snapshot = readRunDirectory(path.join(runsDir, "r1", "input-1"), quiet);
    expect(snapshot.traces).toHaveLength(1);
    // Nothing graded: the only annotation is the harness's run row.
    expect(snapshot.annotationRows.map((row) => row.kind)).toEqual(["run"]);
    // --input records the input and no goal: grading supplies one later.
    const run = snapshot.effectiveAnnotations[result.tests[0].traceId].run as unknown as {
      test: { input: string; goal?: string };
    };
    expect(run.test).toMatchObject({ input: "do it" });
    expect(run.test.goal).toBeUndefined();
  });

  it("does not need a goal to run", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main(input: string) {}\n");
    const suite = path.join(tmpDir, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ inputs: [{ id: "a", input: "t" }] }));

    const result = await evalRun(
      { agent: agentFile, suite, out: path.join(path.join(tmpDir, "runs"), "no-goal") },
      { runner: okRunner },
    );
    expect(result.okCount).toBe(1);
  });

  it("rejects an empty suite instead of succeeding with zero tests", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main(input: string) {}\n");
    const runsDir = path.join(tmpDir, "runs");
    const inputsFile = path.join(tmpDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({ inputs: [] }));

    await expect(
      evalRun(
        { agent: agentFile, suite: inputsFile, out: path.join(runsDir, "empty") },
        { runner: okRunner },
      ),
    ).rejects.toThrow(/no inputs loaded from/);
    expect(fs.existsSync(path.join(runsDir, "empty"))).toBe(false);
  });

  it("throws setup failures before creating a run directory", async () => {
    const runsDir = path.join(tmpDir, "runs");

    await expect(
      evalRun({
        agent: path.join(tmpDir, "missing.agency"),
        input: "do it",
        out: path.join(runsDir, "setup-failed"),
      }),
    ).rejects.toThrow();

    expect(fs.existsSync(path.join(runsDir, "setup-failed"))).toBe(false);
  });

  it("adopts a statelog written to workdir/statelog.log when overrides do not redirect it", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main(input: string) {}\n");
    const runsDir = path.join(tmpDir, "runs");

    const result = await evalRun(
      { agent: agentFile, input: "do it", out: path.join(runsDir, "fallback") },
      {
        runner: async (job) => {
          fs.writeFileSync(
            path.join(job.cwd, "statelog.log"),
            finishedTraceLines(job.traceId, { output: "x" }).join("\n") + "\n",
          );
          return { ok: true };
        },
      },
    );

    expect(result.tests[0]).toMatchObject({ status: "success" });
    expect(readRunDirectory(result.tests[0].runDir, quiet).traces).toHaveLength(1);
  });

  it("runs every test even after one errors, recording each failure", async () => {
    const agentFile = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(agentFile, "node main(input: string) {}\n");
    const runsDir = path.join(tmpDir, "runs");
    const inputsFile = path.join(tmpDir, "inputs.json");
    fs.writeFileSync(
      inputsFile,
      JSON.stringify({
        inputs: [
          { id: "first", goal: "g1", input: "t" },
          { id: "second", goal: "g2", input: "t" },
        ],
      }),
    );

    let runs = 0;
    const result = await evalRun(
      { agent: agentFile, suite: inputsFile, out: path.join(runsDir, "all") },
      {
        runner: async () => {
          runs += 1;
          return { ok: false, errorMessage: "nope" };
        },
      },
    );

    expect(runs).toBe(2);
    expect(result.tests.map((test) => test.testId)).toEqual(["first", "second"]);
    expect(result.tests[0]).toMatchObject({
      testId: "first",
      status: "error",
      // The message carries the seeded-file listing for diagnosability.
      errorMessage: expect.stringMatching(/^nope\n\nWorkdir was seeded with/),
    });
    const snapshot = readRunDirectory(result.tests[0].runDir, quiet);
    const run = snapshot.effectiveAnnotations[result.tests[0].traceId].run as {
      ended: string;
      error: string;
    };
    expect(run.ended).toBe("error");
    expect(run.error).toMatch(/^nope\n/);
  });

  it("accepts a git source for --suite and records the resolved sha on every run row", async () => {
    // A local repo of test directories; local path + ?ref= exercises the same
    // resolver path as a remote URL, with no network.
    const suiteRepo = path.join(tmpDir, "suite-repo");
    fs.mkdirSync(path.join(suiteRepo, "capital", "files"), { recursive: true });
    fs.writeFileSync(
      path.join(suiteRepo, "capital", "test.json"),
      JSON.stringify({ goal: "g", input: "t" }),
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
    fs.writeFileSync(agent, "node main(input: string) {}\n");

    let sawFixture = false;
    const result = await evalRun(
      {
        agent,
        suite: `${suiteRepo}?ref=${suiteSha}`,
        out: path.join(path.join(tmpDir, "runs"), "gitsuite"),
        config: { eval: { sourceCacheRoot: path.join(tmpDir, "cache") } },
      },
      {
        runner: traceRunner("ok", (job) => {
          sawFixture = fs.existsSync(path.join(job.cwd, "hint.txt"));
        }),
      },
    );

    expect(sawFixture).toBe(true);
    expect(result.tests[0].status).toBe("success");
    const snapshot = readRunDirectory(result.tests[0].runDir, quiet);
    const run = snapshot.effectiveAnnotations[result.tests[0].traceId].run as {
      suite: { source: string; sha: string };
    };
    expect(run.suite).toEqual({ source: `${suiteRepo}?ref=${suiteSha}`, sha: suiteSha });
    expect(
      fs.existsSync(path.join(runDirPaths(result.tests[0].runDir).codeDir, "agent.agency")),
    ).toBe(true);
  });

  describe("grading a run directory", () => {
    function setup(runId: string, inputs: { id: string; goal: string; input: string }[]) {
      const agentDir = path.join(tmpDir, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const agent = path.join(agentDir, "agent.agency");
      fs.writeFileSync(agent, "node main(input: string) {}\n");
      const runsDir = path.join(tmpDir, "runs");
      return { agent, inputs, out: path.join(runsDir, runId) };
    }

    it("gradeSuite records score rows and reports a failed gate", async () => {
      const opts = setup("graded", [{ id: "a", goal: "g", input: "t" }]);
      const summary = await runSuite(opts, { runner: okRunner });

      const { grading } = await gradeSuite(
        summary.tests[0].runDir,
        { mode: "override", graders: [grader(() => false, { name: "gate", mustPass: true })] },
        {},
      );

      expect(grading.gatesPassed).toBe(false);
      expect(grading.graders).toEqual(["gate"]);
      const scores = readRunDirectory(summary.tests[0].runDir, quiet).annotationRows.filter(
        (row) => row.kind === "score",
      );
      expect(scores).toHaveLength(1);
      expect(scores[0]).toMatchObject({
        name: "gate",
        mustPass: true,
        score: { kind: "binary", pass: false },
      });
    });

    it("a failed run scores zero and the mean over the group is 0.5, not 0", async () => {
      const opts = setup("mixed", [
        { id: "a", goal: "g", input: "t" },
        { id: "b", goal: "g", input: "t" },
      ]);
      const summary = await runSuite(opts, { runner: okRunner });
      // Passes on test "a", fails the gate on test "b".
      const graders = path.join(tmpDir, "gate.ts");
      fs.writeFileSync(graders, `export default ({ test }) => (test.id === "a" ? 1 : 0);`);
      const result = await evalGrade(summary.runDir, { graders, config: {} });

      // One of two runs scored 1, the other 0 — the mean is 0.5, not 0.
      expect(result.mean).toBeCloseTo(0.5);
    });

    it("a misconfigured grader is rejected by validation before any agent runs", () => {
      // ExactMatch's matchOn defaults to `expected`, which this test lacks.
      expect(() =>
        validateGraders([new ExactMatch({})], { id: "a", goal: "g", input: "t" }),
      ).toThrow(/matchOn/);
    });
  });

  it("totalRunCostUsd sums trace costs across the run directories of a group", () => {
    const group = fs.mkdtempSync(path.join(tmpDir, "group-"));
    writeRunDirectory(
      [{ test: { id: "a", input: "t" }, output: "x", costUsd: 0.25 }],
      path.join(group, "a"),
    );
    writeRunDirectory(
      [{ test: { id: "b", input: "t" }, output: "y", costUsd: 0.5 }],
      path.join(group, "b"),
    );
    writeRunDirectory(
      [{ test: { id: "c", input: "t" }, wroteStatelog: false, ended: "error" }],
      path.join(group, "c"),
    );
    expect(totalRunCostUsd(group)).toBeCloseTo(0.75);
    expect(totalRunCostUsd(path.join(group, "a"))).toBeCloseTo(0.25);
    // A run that never wrote a trace, and a group with no runs at all.
    expect(totalRunCostUsd(path.join(group, "c"))).toBeUndefined();
    expect(totalRunCostUsd(fs.mkdtempSync(path.join(tmpDir, "empty-")))).toBeUndefined();
  });

  describe("per-test graders", () => {
    it("each test grades itself; a config module is the fallback; --graders overrides everything", async () => {
      const agentFile = path.join(tmpDir, "agent.agency");
      fs.writeFileSync(agentFile, "node main(input: string) {}\n");
      const runsDir = path.join(tmpDir, "runs");

      // Two test dirs: "self" carries its own grader (scores 1 on "hello"),
      // "plain" has none and falls back to the config module (scores 0).
      const suiteDir = path.join(tmpDir, "suite");
      fs.mkdirSync(path.join(suiteDir, "self"), { recursive: true });
      fs.writeFileSync(path.join(suiteDir, "self", "test.json"), JSON.stringify({ input: "t" }));
      fs.writeFileSync(
        path.join(suiteDir, "self", "graders.ts"),
        `export default ({ output }) => (output === "hello" ? 1 : 0);`,
      );
      fs.mkdirSync(path.join(suiteDir, "plain"), { recursive: true });
      fs.writeFileSync(path.join(suiteDir, "plain", "test.json"), JSON.stringify({ input: "t" }));
      const fallbackModule = path.join(tmpDir, "fallback.ts");
      fs.writeFileSync(fallbackModule, `export default () => 0;`);
      const config = { eval: { graders: fallbackModule } };

      const result = await evalRun(
        { agent: agentFile, suite: suiteDir, out: path.join(runsDir, "per-test"), config },
        { runner: okRunner },
      );

      // "self" scored 1 by its own grader; "plain" scored 0 by the fallback.
      const fallback = await evalGrade(result.runDir, { config });
      expect(fallback.mean).toBeCloseTo(0.5);

      // An explicit --graders replaces BOTH tests' graders.
      const overrideModule = path.join(tmpDir, "override.ts");
      fs.writeFileSync(overrideModule, `export default () => 1;`);
      const overridden = await evalGrade(result.runDir, { graders: overrideModule, config });
      expect(overridden.mean).toBeCloseTo(1);
    });
  });

  describe("command targets", () => {
    it("--agent-cmd reaches the runner as a substituted command job", async () => {
      const runsDir = path.join(tmpDir, "runs");
      let job: EvalRunnerJob | undefined;

      const result = await evalRun(
        { agentCmd: "some-agent -p -- {task}", input: "do it", out: path.join(runsDir, "r-cmd") },
        { runner: traceRunner("done", (j) => (job = j)) },
      );

      expect(result.okCount).toBe(1);
      expect(job?.kind).toBe("command");
      // --input is the substituted {task}, so the argv carries it
      expect(job?.kind === "command" && job.argv).toEqual(["some-agent", "-p", "--", "do it"]);
    });
  });
});
