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
import { loadInputs } from "@/eval/loadInputs.js";
import type { HarnessRecord } from "@/runDirectory/annotations.js";
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

  it("a statelog holding two traces fails the fold and keeps the staging directory", async () => {
    const runsDir = path.join(proj, "runs");
    const runner = vi.fn(async (job: EvalRunnerJob) => {
      const lines = [
        ...traceFor(job, "done"),
        ...finishedTraceLines("other-trace", { output: "x" }),
      ];
      fs.writeFileSync(job.statelogPath, lines.join("\n") + "\n");
      return { ok: true as const };
    });

    await expect(
      runSuite(
        {
          agent: path.join(proj, "agent.agency"),
          inputs: [{ id: "a", goal: "g", input: "first" }],
          out: path.join(runsDir, "r-two-traces"),
          config: {},
          suite: { source: "inputs.json" },
          perRun: { pipeOutput: false },
        },
        { runner },
      ),
    ).rejects.toThrow(/two traces|2 traces.*kept at/s);

    const staging = path.join(runsDir, "r-two-traces", ".staging", "a");
    expect(fs.existsSync(path.join(staging, "agent", "statelog.jsonl"))).toBe(true);
  });

  it("--trials k: each test runs k times under <out>/<test>/<trial>, sharing the batch id, each its own trace", async () => {
    const out = path.join(proj, "runs", "r-trials");
    const runner = traceWritingRunner("done");
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "fib", goal: "g", input: "first" },
          { id: "sum", goal: "g", input: "second" },
        ],
        out,
        config: {},
        trials: 2,
        perRun: { pipeOutput: false },
      },
      { runner },
    );

    // Trial-major: every test's first trial before any second trial.
    expect(result.tests.map((test) => [test.testId, test.trial, test.status])).toEqual([
      ["fib", 1, "success"],
      ["sum", 1, "success"],
      ["fib", 2, "success"],
      ["sum", 2, "success"],
    ]);
    expect(result.tests.map((test) => path.relative(out, test.runDir))).toEqual([
      path.join("fib", "1"),
      path.join("sum", "1"),
      path.join("fib", "2"),
      path.join("sum", "2"),
    ]);
    const traceIds = result.tests.map((test) => test.traceId);
    expect(traceIds[0]).not.toBe(traceIds[2]);
    // One batch id for the invocation: the group name plus a unique suffix.
    const batches = result.tests.map((test) => {
      const snapshot = readRunDirectory(test.runDir, quiet);
      const run = snapshot.effectiveAnnotations[test.traceId].run;
      expect(run).toMatchObject({ trial: test.trial, flags: { trials: 2 } });
      return run !== null && run.kind === "run" ? run.batch : null;
    });
    expect(batches[0]).toMatch(/^r-trials-[A-Za-z0-9_-]{8}$/);
    expect(batches.every((batch) => batch === batches[0])).toBe(true);
    expect(fs.readdirSync(out).sort()).toEqual(["fib", "sum"]);
    expect(fs.readdirSync(path.join(out, "fib")).sort()).toEqual(["1", "2"]);
  });

  it("one trial keeps the flat layout and records trial 1", async () => {
    const out = path.join(proj, "runs", "r-flat");
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "fib", goal: "g", input: "first" }],
        out,
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );
    expect(result.tests.map((test) => [test.trial, test.runDir])).toEqual([
      [1, path.join(out, "fib")],
    ]);
    const snapshot = readRunDirectory(result.tests[0].runDir, quiet);
    expect(snapshot.effectiveAnnotations[result.tests[0].traceId].run).toMatchObject({
      batch: expect.stringMatching(/^r-flat-[A-Za-z0-9_-]{8}$/),
      trial: 1,
      flags: { trials: 1 },
    });
  });

  it("two invocations of the same --out name never share a batch id", async () => {
    const batchOf = async (out: string) => {
      const result = await runSuite(
        {
          agent: path.join(proj, "agent.agency"),
          inputs: [{ id: "fib", goal: "g", input: "first" }],
          out,
          config: {},
          perRun: { pipeOutput: false },
        },
        { runner: traceWritingRunner("done") },
      );
      const run = readRunDirectory(result.tests[0].runDir, quiet).effectiveAnnotations[
        result.tests[0].traceId
      ].run;
      return run !== null && run.kind === "run" ? run.batch : null;
    };
    const first = await batchOf(path.join(proj, "team-a", "nightly"));
    const second = await batchOf(path.join(proj, "team-b", "nightly"));
    expect(first).not.toBe(second);
  });

  it("--trials over a group that already holds a flat run for the test is an error, not hidden trials", async () => {
    const out = path.join(proj, "runs", "r-mixed");
    const suite = (trials: number) =>
      runSuite(
        {
          agent: path.join(proj, "agent.agency"),
          inputs: [{ id: "fib", goal: "g", input: "first" }],
          out,
          config: {},
          trials,
          perRun: { pipeOutput: false },
        },
        { runner: traceWritingRunner("done") },
      );
    await suite(1);
    const result = await suite(2);
    expect(result.tests.map((test) => test.status)).toEqual(["error", "error"]);
    expect(result.tests[0].errorMessage).toMatch(/already a run directory.*another --out/);
    // The flat run is untouched and nothing was written beneath it.
    expect(fs.readdirSync(path.join(out, "fib")).sort()).not.toContain("1");
  });

  it("rejects a trial count that is not a positive integer before creating anything", async () => {
    const out = path.join(proj, "runs", "r-bad");
    for (const trials of [0, -1, 1.5, Number.NaN]) {
      await expect(
        runSuite(
          {
            agent: path.join(proj, "agent.agency"),
            inputs: [{ id: "fib", goal: "g", input: "first" }],
            out,
            config: {},
            trials,
            perRun: { pipeOutput: false },
          },
          { runner: traceWritingRunner("done") },
        ),
      ).rejects.toThrow(/trials must be a positive integer/);
    }
    expect(fs.existsSync(out)).toBe(false);
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

  it("stores each test's harness pairs in its run directory as hash-named files with a harness record", async () => {
    const testDir = path.join(proj, "suite", "fib");
    fs.mkdirSync(path.join(testDir, "files"), { recursive: true });
    fs.mkdirSync(path.join(testDir, "holdout"));
    fs.writeFileSync(path.join(testDir, "test.json"), JSON.stringify({ input: "t" }));
    const json = JSON.stringify({
      tests: [{ nodeName: "t", expectedOutput: "1", evaluationCriteria: [{ type: "exact" }] }],
    });
    fs.writeFileSync(
      path.join(testDir, "files", "vis.agency"),
      "export node t(): number {\n  return 1\n}\n",
    );
    fs.writeFileSync(path.join(testDir, "files", "vis.test.json"), json);
    fs.writeFileSync(
      path.join(testDir, "holdout", "hid.agency"),
      "export node t(): number {\n  return 2\n}\n",
    );
    fs.writeFileSync(path.join(testDir, "holdout", "hid.test.json"), json);
    const [test] = loadInputs(testDir);
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [test],
        out: path.join(proj, "runs", "r-harness"),
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );
    const { runDir, traceId } = result.tests[0];
    const run = readRunDirectory(runDir, quiet).effectiveAnnotations[traceId].run;
    const harness = (run as unknown as { harness: HarnessRecord[] }).harness;
    expect(harness.map((h) => [h.name, h.visibility])).toEqual([
      ["vis", "visible"],
      ["hid", "holdout"],
    ]);
    for (const record of harness) {
      expect(record.agency).toMatch(/^[0-9a-f]{64}\.agency$/);
      expect(fs.existsSync(path.join(runDirPaths(runDir).gradersDir, record.agency))).toBe(true);
      expect(fs.existsSync(path.join(runDirPaths(runDir).gradersDir, record.json))).toBe(true);
    }
    // No grading module: the row carries harness records only.
    expect((run as unknown as { graders?: unknown }).graders).toBeUndefined();
  });

  it("stores a test's graderFiles/ tree in its run directory and names it on the run row", async () => {
    const testDir = path.join(proj, "suite", "essay");
    fs.mkdirSync(path.join(testDir, "graderFiles", "sub"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "test.json"), JSON.stringify({ input: "t", goal: "g" }));
    fs.writeFileSync(path.join(testDir, "graderFiles", "notes.md"), "lead with the why");
    fs.writeFileSync(path.join(testDir, "graderFiles", "sub", "cleaned.md"), "short");
    const [test] = loadInputs(testDir);
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [test],
        out: path.join(proj, "runs", "r-grader-files"),
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );
    const { runDir, traceId } = result.tests[0];
    const run = readRunDirectory(runDir, quiet).effectiveAnnotations[traceId].run;
    const stored = (run as unknown as { graderFiles: string }).graderFiles;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    const storedDir = path.join(runDirPaths(runDir).gradersDir, stored);
    expect(fs.readFileSync(path.join(storedDir, "notes.md"), "utf8")).toBe("lead with the why");
    expect(fs.readFileSync(path.join(storedDir, "sub", "cleaned.md"), "utf8")).toBe("short");
    // The agent never saw them.
    expect(fs.existsSync(path.join(runDirPaths(runDir).workdirDir, "notes.md"))).toBe(false);
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
      graders: { kind: "snapshot" },
      runAgency: new AgencyRunner({}),
      config: {},
    });
    expect(scorecard.objective()).toBe(1);
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
    // If the goal judge ran here it would need a model; the stored module grades 1.
    const withGoal = await gradeRun(result.tests[0].runDir, {
      graders: { kind: "snapshot" },
      runAgency: new AgencyRunner({}),
      config: {},
      defaultGoal: "g",
    });
    expect(withGoal.objective()).toBe(1);
  });

  it("sequential: once the batch cost cap is crossed, no further test starts", async () => {
    const runner = vi.fn(async (job: EvalRunnerJob) => {
      fs.writeFileSync(
        job.statelogPath,
        finishedTraceLines(job.traceId, { output: "done", costUsd: 3 }).join("\n") + "\n",
      );
      return { ok: true as const };
    });
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "a", goal: "g", input: "t" },
          { id: "b", goal: "g", input: "t" },
          { id: "c", goal: "g", input: "t" },
        ],
        out: path.join(proj, "runs", "r-budget"),
        config: { eval: { limits: { maxBatchCostUsd: 5 } } },
        perRun: { pipeOutput: false },
        progress: false,
      },
      { runner },
    );
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.tests.map((test) => test.testId)).toEqual(["a", "b"]);
    expect(result.costUsd).toBe(6);
    expect(result.batchCostCapExceeded).toBe(true);
    expect(fs.readdirSync(result.runDir).sort()).toEqual(["a", "b"]);
  });

  it("parallel: an exhausted batch budget stops scheduling; in-flight runs still record", async () => {
    const runner = vi.fn(async (job: EvalRunnerJob) => {
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(
        job.statelogPath,
        finishedTraceLines(job.traceId, { output: "done", costUsd: 4 }).join("\n") + "\n",
      );
      return { ok: true as const };
    });
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "a", goal: "g", input: "t" },
          { id: "b", goal: "g", input: "t" },
          { id: "c", goal: "g", input: "t" },
          { id: "d", goal: "g", input: "t" },
        ],
        out: path.join(proj, "runs", "r-par-budget"),
        config: { eval: { limits: { maxBatchCostUsd: 3 } } },
        parallel: 2,
        progress: false,
      },
      { runner },
    );
    // a and b start together; the first to finish crosses the cap ($4 > $3),
    // the other is already in flight and records; c and d never start.
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.tests.map((test) => test.testId)).toEqual(["a", "b"]);
    expect(result.batchCostCapExceeded).toBe(true);
  });

  it("without a batch cap, spend is reported and never stops the suite", async () => {
    const runner = vi.fn(async (job: EvalRunnerJob) => {
      fs.writeFileSync(
        job.statelogPath,
        finishedTraceLines(job.traceId, { output: "done", costUsd: 100 }).join("\n") + "\n",
      );
      return { ok: true as const };
    });
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "a", goal: "g", input: "t" },
          { id: "b", goal: "g", input: "t" },
        ],
        out: path.join(proj, "runs", "r-no-budget"),
        config: {},
        perRun: { pipeOutput: false },
        progress: false,
      },
      { runner },
    );
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.costUsd).toBe(200);
    expect(result.batchCostCapExceeded).toBe(false);
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
