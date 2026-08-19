import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";
import { finishedTraceLines } from "@/runDirectory/testFixtures.js";

import { AgencyRunner } from "@/eval/grading/agencyRunner.js";
import { grader } from "@/eval/grading/functionGrader.js";
import { gradeRun } from "@/eval/grading/gradeRun.js";

import { runSuite } from "./runSuite.js";
import type { EvalRunnerJob } from "./subprocess.js";

/** A fake runner that behaves like a real child: writes a finished trace under
 *  the harness-minted trace id, with `output` as the return value, and marks
 *  the workdir so a snapshot can be told apart. */
function traceWritingRunner(output: unknown, observe?: (job: EvalRunnerJob) => void) {
  return vi.fn(async (job: EvalRunnerJob) => {
    observe?.(job);
    fs.writeFileSync(path.join(job.cwd, "touched.txt"), "by the agent");
    fs.writeFileSync(job.statelogPath, traceFor(job, output).join("\n") + "\n");
    return { ok: true as const };
  });
}

/** The trace a real child would write: file jobs record the seeded code's
 *  identity on agentStart, which is what lets the run directory attach it. */
function traceFor(job: EvalRunnerJob, output: unknown): string[] {
  return finishedTraceLines(job.traceId, {
    output,
    ...(job.kind === "file" ? { code: job.code, input: job.input } : {}),
  });
}

const quiet = { reportWarning: () => {} };

describe("runSuite", () => {
  let proj: string;
  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "runsuite-"));
    fs.writeFileSync(path.join(proj, "agent.agency"), "node main(input: string) { return 1 }\n");
  });
  afterEach(() => {
    // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
    // which safeDelete refuses by design.
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it("writes one run directory per test under --out: trace, workdir, code, and a run row each", async () => {
    const runsDir = path.join(proj, "runs");
    const seen: EvalRunnerJob[] = [];
    const runner = traceWritingRunner("done", (job) => seen.push(job));

    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "a", goal: "g", input: "first" },
          { id: "b", goal: "g", input: { rows: [1, 2] } },
        ],
        out: path.join(runsDir, "r1"),
        config: {},
        suite: { source: "inputs.json" },
        perRun: { pipeOutput: false },
      },
      { runner },
    );

    expect(result.runDir).toBe(path.join(runsDir, "r1"));
    expect(result.tests.map((test) => [test.testId, test.status])).toEqual([
      ["a", "success"],
      ["b", "success"],
    ]);
    expect(result.okCount).toBe(2);
    // The child saw the harness-minted trace id and the test's input.
    expect(seen.map((job) => job.traceId)).toEqual(result.tests.map((test) => test.traceId));
    expect(seen.map((job) => (job.kind === "file" ? job.input : null))).toEqual([
      "first",
      { rows: [1, 2] },
    ]);

    expect(result.tests.map((test) => test.runDir)).toEqual([
      path.join(result.runDir, "a"),
      path.join(result.runDir, "b"),
    ]);
    for (const test of result.tests) {
      const snapshot = readRunDirectory(test.runDir, quiet);
      expect(snapshot.traces.map((trace) => trace.traceId)).toEqual([test.traceId]);
      const paths = runDirPaths(test.runDir);
      expect(fs.readFileSync(path.join(paths.workdirDir, "touched.txt"), "utf8")).toBe(
        "by the agent",
      );
      expect(fs.existsSync(paths.workdirSidecar)).toBe(true);
      const run = snapshot.effectiveAnnotations[test.traceId].run;
      expect(run).toMatchObject({ kind: "run", ended: "ok", suite: { source: "inputs.json" } });
      expect((run as unknown as { test: { id: string } }).test.id).toBe(test.testId);
      // The seeded agent code, flat under code/.
      expect(fs.existsSync(path.join(paths.codeDir, "agent.agency"))).toBe(true);
    }
    // The group holds only the run directories; no staging left behind.
    expect(fs.readdirSync(result.runDir).sort()).toEqual(["a", "b"]);
  });

  it("module-dir == cwd: compiled entry lives inside the test's staging workdir", async () => {
    const seen: { compiledEntryPath: string; cwd: string }[] = [];
    const runner = vi.fn(async (job: EvalRunnerJob) => {
      if (job.kind === "file")
        seen.push({ compiledEntryPath: job.compiledEntryPath, cwd: job.cwd });
      expect(fs.existsSync((job as { compiledEntryPath: string }).compiledEntryPath)).toBe(true);
      return { ok: true as const };
    });

    await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "input-1", goal: "g", input: "t" }],
        out: path.join(path.join(proj, "runs"), "r1"),
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].compiledEntryPath.startsWith(seen[0].cwd + path.sep)).toBe(true);
  });

  it("overlayFiles overwrite the seed copy inside each test's workdir", async () => {
    fs.writeFileSync(path.join(proj, "config.txt"), "original\n");
    const observedCwd: string[] = [];
    const runner = vi.fn(async (args: { cwd: string }) => {
      observedCwd.push(fs.readFileSync(path.join(args.cwd, "config.txt"), "utf8"));
      return { ok: true as const };
    });

    await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "input-1", goal: "g", input: "t" }],
        out: path.join(path.join(proj, "runs"), "r-overlay"),
        config: {},
        perRun: {
          pipeOutput: false,
          seed: {
            baseDir: proj,
            agentRelPath: "agent.agency",
            closureFiles: [path.join(proj, "agent.agency")],
          },
          overlayFiles: { "config.txt": "patched\n" },
        },
      },
      { runner },
    );

    // The overlay wins inside the workdir; the source tree is untouched.
    expect(observedCwd).toEqual(["patched\n"]);
    expect(fs.readFileSync(path.join(proj, "config.txt"), "utf8")).toBe("original\n");
  });

  it("seeds a test's files directory into the workdir", async () => {
    const filesDir = path.join(proj, "fixtures");
    fs.mkdirSync(path.join(filesDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(filesDir, "data", "report.txt"), "q3");
    const agentDir = path.join(proj, "agent-proj");
    fs.mkdirSync(agentDir, { recursive: true });
    const agent = path.join(agentDir, "agent.agency");
    fs.writeFileSync(agent, "node main(input: string) {}\n");

    let sawFixture = false;
    const result = await runSuite(
      {
        agent,
        inputs: [{ id: "a", goal: "g", input: "t", files: filesDir }],
        out: path.join(path.join(proj, "runs"), "files-e2e"),
      },
      {
        runner: traceWritingRunner("ok", (job) => {
          sawFixture = fs.existsSync(path.join(job.cwd, "data", "report.txt"));
        }),
      },
    );

    expect(result.tests[0].status).toBe("success");
    expect(sawFixture).toBe(true);
  });

  it("a failed test still gets a run row saying how it ended, and no workdir", async () => {
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t" }],
        out: path.join(path.join(proj, "runs"), "r-fail"),
        config: {},
        perRun: { pipeOutput: false },
      },
      {
        runner: vi.fn(async () => ({
          ok: false as const,
          errorMessage: "wall clock limit exceeded (60000ms)",
        })),
      },
    );

    expect(result.tests[0].status).toBe("error");
    const runDir = result.tests[0].runDir;
    // Still a run directory (empty statelog), so the walk rule finds it.
    expect(fs.readFileSync(runDirPaths(runDir).statelog, "utf8")).toBe("");
    const snapshot = readRunDirectory(runDir, quiet);
    expect(snapshot.traces).toEqual([]);
    const run = snapshot.effectiveAnnotations[result.tests[0].traceId].run;
    expect(run).toMatchObject({ kind: "run", ended: "timeout" });
    expect((run as { error: string }).error).toMatch(/wall clock/);
    expect(fs.existsSync(runDirPaths(runDir).workdirDir)).toBe(false);
  });

  it("runs a resolved command target end-to-end: substituted argv per test, no code stored", async () => {
    const runsDir = path.join(proj, "runs");
    const seen: string[][] = [];
    const runner = traceWritingRunner("done", (job) => {
      if (job.kind === "command") seen.push(job.argv);
    });

    const result = await runSuite(
      {
        agent: {
          kind: "command",
          tokens: ["some-agent", "-p", "{input}"],
          label: "some-agent -p {input}",
        },
        inputs: [
          { id: "a", goal: "g", input: "first task" },
          { id: "b", goal: "g", input: "second task" },
        ],
        out: path.join(runsDir, "r-cmd"),
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner },
    );

    expect(seen).toEqual([
      ["some-agent", "-p", "first task"],
      ["some-agent", "-p", "second task"],
    ]);
    expect(result.tests.map((test) => test.status)).toEqual(["success", "success"]);
    expect(fs.existsSync(runDirPaths(result.runDir).codeDir)).toBe(false);
  });

  it("parallel > 1: runs through a bounded pool, keeps test order, never pipes output", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const runner = vi.fn(async (job: EvalRunnerJob) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (job.kind === "file") started.push(String(job.input));
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(job.statelogPath, traceFor(job, "done").join("\n") + "\n");
      inFlight -= 1;
      return { ok: true as const };
    });

    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "a", goal: "g", input: "t-a" },
          { id: "b", goal: "g", input: "t-b" },
          { id: "c", goal: "g", input: "t-c" },
          { id: "d", goal: "g", input: "t-d" },
        ],
        out: path.join(path.join(proj, "runs"), "r-par"),
        config: {},
        parallel: 2,
      },
      { runner },
    );

    expect(maxInFlight).toBe(2);
    expect(started.length).toBe(4);
    // results in TEST order regardless of completion order
    expect(result.tests.map((test) => test.testId)).toEqual(["a", "b", "c", "d"]);
    expect(result.okCount).toBe(4);
    expect(fs.readdirSync(result.runDir).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("parallel: an errored test never stops the others; every test records", async () => {
    const runner = vi.fn(async (job: EvalRunnerJob) => {
      await new Promise((r) => setTimeout(r, 20));
      if (job.kind === "file" && String(job.input) === "t-a") {
        return { ok: false as const, errorMessage: "boom" };
      }
      fs.writeFileSync(job.statelogPath, traceFor(job, "done").join("\n") + "\n");
      return { ok: true as const };
    });

    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "a", goal: "g", input: "t-a" },
          { id: "b", goal: "g", input: "t-b" },
          { id: "c", goal: "g", input: "t-c" },
          { id: "d", goal: "g", input: "t-d" },
        ],
        out: path.join(path.join(proj, "runs"), "r-par-error"),
        config: {},
        parallel: 2,
      },
      { runner },
    );

    expect(runner).toHaveBeenCalledTimes(4);
    expect(result.tests.map((test) => test.testId)).toEqual(["a", "b", "c", "d"]);
    expect(result.tests[0].status).toBe("error");
    expect(result.okCount).toBe(3);
  });

  it("a test's spec, timeoutSec included, is recorded on its run row", async () => {
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t", timeoutSec: 1200 }],
        out: path.join(path.join(proj, "runs"), "r-timeout"),
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );
    const run = readRunDirectory(result.tests[0].runDir, quiet).effectiveAnnotations[
      result.tests[0].traceId
    ].run;
    expect((run as unknown as { test: { timeoutSec: number } }).test.timeoutSec).toBe(1200);
    expect(result.okCount).toBe(1);
  });

  it("stores each test's grading module in its run directory, and grading uses that copy even after the source changes", async () => {
    const modulePath = path.join(proj, "graders.ts");
    const moduleReturning = (value: number) => `export default [() => ${value}];`;
    fs.writeFileSync(modulePath, moduleReturning(1));
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t", graders: modulePath }],
        out: path.join(proj, "runs", "r-graders"),
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );
    const { runDir, traceId } = result.tests[0];
    const run = readRunDirectory(runDir, quiet).effectiveAnnotations[traceId].run;
    const recorded = (run as unknown as { graders: { source: string; bundleFile: string } })
      .graders;
    expect(recorded.source).toBe(modulePath);
    expect(fs.existsSync(path.join(runDirPaths(runDir).gradersDir, recorded.bundleFile))).toBe(
      true,
    );

    // The source changes underfoot; the run still grades by the module it ran with.
    fs.writeFileSync(modulePath, moduleReturning(0));
    const scorecard = await gradeRun(runDir, {
      suiteGraders: { mode: "fallback", graders: [] },
      runAgency: new AgencyRunner({}),
      config: {},
    });
    expect(scorecard.objective()).toBe(1);
  });

  it("a config-origin snapshot grades the run, but --goal sets it aside like the config module it came from", async () => {
    const modulePath = path.join(proj, "graders.ts");
    fs.writeFileSync(modulePath, "export default [() => 1];");
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t" }],
        out: path.join(proj, "runs", "r-config-graders"),
        config: { eval: { graders: modulePath } },
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );
    const { runDir, traceId } = result.tests[0];
    const run = readRunDirectory(runDir, quiet).effectiveAnnotations[traceId].run;
    expect((run as unknown as { graders: { origin: string } }).graders.origin).toBe("config");

    // Without --goal: the stored copy grades, even with the source deleted.
    fs.rmSync(modulePath);
    const fallback = grader(() => 0, { name: "stand-in-goal-judge" });
    const plain = await gradeRun(runDir, {
      suiteGraders: { mode: "fallback", graders: [fallback] },
      runAgency: new AgencyRunner({}),
      config: {},
    });
    expect(plain.objective()).toBe(1);

    // With --goal (defaultGoal): configured modules are set aside, the
    // run-time copy included — the suite fallback (the goal judge) grades.
    const withGoal = await gradeRun(runDir, {
      suiteGraders: { mode: "fallback", graders: [fallback] },
      runAgency: new AgencyRunner({}),
      config: {},
      defaultGoal: "g",
    });
    expect(withGoal.objective()).toBe(0);
  });

  it("a test-owned snapshot still grades under --goal: a goal never overrides a test's own graders", async () => {
    const modulePath = path.join(proj, "graders.ts");
    fs.writeFileSync(modulePath, "export default [() => 1];");
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t", graders: modulePath }],
        out: path.join(proj, "runs", "r-test-graders-goal"),
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );
    fs.rmSync(modulePath);
    const withGoal = await gradeRun(result.tests[0].runDir, {
      suiteGraders: { mode: "fallback", graders: [grader(() => 0, { name: "goalish" })] },
      runAgency: new AgencyRunner({}),
      config: {},
      defaultGoal: "g",
    });
    expect(withGoal.objective()).toBe(1);
  });

  it("a broken grading module fails before any agent runs", async () => {
    const modulePath = path.join(proj, "graders.ts");
    fs.writeFileSync(modulePath, "export const notDefault = 1;");
    const runner = vi.fn();
    await expect(
      runSuite(
        {
          agent: path.join(proj, "agent.agency"),
          inputs: [{ id: "a", goal: "g", input: "t", graders: modulePath }],
          out: path.join(proj, "runs", "r-broken"),
          config: {},
        },
        { runner },
      ),
    ).rejects.toThrow(/must default-export/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("without --out, the run lands under eval.runsDir with a sortable timestamp name", async () => {
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t" }],
        config: { eval: { runsDir: path.join(proj, "runs") } },
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );

    // e.g. 2026-07-31-143022-Ab3dEf
    expect(path.basename(result.runDir)).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-.{6}$/);
    expect(path.dirname(result.runDir)).toBe(path.join(proj, "runs"));
    expect(fs.existsSync(path.join(result.runDir, "a", "statelog.jsonl"))).toBe(true);
  });

  it("a test whose run directory already exists is an error; the others still run; nothing is overwritten", async () => {
    const out = path.join(proj, "runs", "taken");
    fs.mkdirSync(path.join(out, "a"), { recursive: true });
    fs.writeFileSync(path.join(out, "a", "statelog.jsonl"), "");
    const runner = traceWritingRunner("done");
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "a", goal: "g", input: "t" },
          { id: "b", goal: "g", input: "t" },
        ],
        out,
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner },
    );
    expect(result.tests.map((test) => [test.testId, test.status])).toEqual([
      ["a", "error"],
      ["b", "success"],
    ]);
    expect(result.tests[0].errorMessage).toMatch(/already exists/);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(out, "a", "statelog.jsonl"), "utf8")).toBe("");
    expect(readRunDirectory(path.join(out, "b"), quiet).traces).toHaveLength(1);
  });

  it("a test id that is empty, escapes the group, or is .staging is an error result; the others run", async () => {
    const out = path.join(proj, "runs", "ids");
    const runner = traceWritingRunner("done");
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "", goal: "g", input: "t" },
          { id: "../escape", goal: "g", input: "t" },
          { id: "a/b", goal: "g", input: "t" },
          { id: ".staging", goal: "g", input: "t" },
          { id: "fine", goal: "g", input: "t" },
        ],
        out,
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner },
    );
    expect(result.tests.map((test) => test.status)).toEqual([
      "error",
      "error",
      "error",
      "error",
      "success",
    ]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(out)).toEqual(["fine"]);
    expect(fs.existsSync(path.join(proj, "runs", "escape"))).toBe(false);
  });

  it("SIGINT stops the loop after the in-flight test, which is still folded in", async () => {
    const runsDir = path.join(proj, "runs");
    const before = process.listeners("SIGINT");
    const runner = vi.fn(async (job: EvalRunnerJob) => {
      // Fire runSuite's own listener directly (a real signal would kill the
      // test process): find the one this run installed and invoke it.
      const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
      expect(added).toHaveLength(1);
      added[0]("SIGINT");
      fs.writeFileSync(job.statelogPath, traceFor(job, "done").join("\n") + "\n");
      return { ok: true as const };
    });

    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "input-1", goal: "g", input: "t" },
          { id: "input-2", goal: "g", input: "t" },
          { id: "input-3", goal: "g", input: "t" },
        ],
        out: path.join(runsDir, "r-sigint"),
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner },
    );

    // The in-flight test finished and was recorded; the rest never ran.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.tests.map((test) => test.testId)).toEqual(["input-1"]);
    expect(readRunDirectory(result.tests[0].runDir, quiet).traces).toHaveLength(1);
    // The listener is gone afterwards.
    expect(process.listeners("SIGINT")).toEqual(before);
  });

  it("progress: false prints nothing — the optimizer's --silent depends on it", async () => {
    const errSpy = vi.spyOn(console, "error");
    try {
      await runSuite(
        {
          agent: path.join(proj, "agent.agency"),
          inputs: [{ id: "input-1", goal: "g", input: "t" }],
          out: path.join(path.join(proj, "runs"), "r-quiet"),
          config: {},
          progress: false,
          perRun: { pipeOutput: false },
        },
        { runner: traceWritingRunner("done") },
      );
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
