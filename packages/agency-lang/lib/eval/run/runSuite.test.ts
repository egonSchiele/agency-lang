import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";
import { finishedTraceLines } from "@/runDirectory/testFixtures.js";

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

  it("writes one run directory: traces, workdirs, code, and a run row per test", async () => {
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
        runsDir,
        runId: "r1",
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

    const snapshot = readRunDirectory(result.runDir, quiet);
    expect(snapshot.traces.map((trace) => trace.traceId)).toEqual(
      result.tests.map((test) => test.traceId),
    );
    const paths = runDirPaths(result.runDir);
    for (const test of result.tests) {
      expect(
        fs.readFileSync(path.join(paths.workdirDir, test.traceId, "touched.txt"), "utf8"),
      ).toBe("by the agent");
      const run = snapshot.effectiveAnnotations[test.traceId].run;
      expect(run).toMatchObject({ kind: "run", ended: "ok", suite: { source: "inputs.json" } });
      expect((run as { test: { id: string } }).test.id).toBe(test.testId);
    }
    // The seeded agent code is stored once, by its closure hash.
    const codeVersions = fs.readdirSync(paths.codeDir);
    expect(codeVersions).toHaveLength(1);
    expect(fs.existsSync(path.join(paths.codeDir, codeVersions[0], "agent.agency"))).toBe(true);
    // No old-format artifacts, and no staging left behind.
    for (const stale of ["config.json", "summary.json", "inputs", "verifier"]) {
      expect(fs.existsSync(path.join(result.runDir, stale))).toBe(false);
    }
    expect(fs.existsSync(path.join(runsDir, ".staging"))).toBe(false);
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
        runsDir: path.join(proj, "runs"),
        runId: "r1",
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
        runsDir: path.join(proj, "runs"),
        runId: "r-overlay",
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
        runsDir: path.join(proj, "runs"),
        runId: "files-e2e",
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
        runsDir: path.join(proj, "runs"),
        runId: "r-fail",
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
    const snapshot = readRunDirectory(result.runDir, quiet);
    expect(snapshot.traces).toEqual([]);
    const run = snapshot.effectiveAnnotations[result.tests[0].traceId].run;
    expect(run).toMatchObject({ kind: "run", ended: "timeout" });
    expect((run as { error: string }).error).toMatch(/wall clock/);
    expect(fs.existsSync(runDirPaths(result.runDir).workdirDir)).toBe(false);
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
          tokens: ["some-agent", "-p", "{task}"],
          label: "some-agent -p {task}",
        },
        inputs: [
          { id: "a", goal: "g", input: "first task" },
          { id: "b", goal: "g", input: "second task" },
        ],
        runsDir,
        runId: "r-cmd",
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
        runsDir: path.join(proj, "runs"),
        runId: "r-par",
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
    expect(readRunDirectory(result.runDir, quiet).traces).toHaveLength(4);
  });

  it("parallel + continueOnError=false: an error stops scheduling; in-flight tests still record", async () => {
    let calls = 0;
    const runner = vi.fn(async (job: EvalRunnerJob) => {
      calls += 1;
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
        runsDir: path.join(proj, "runs"),
        runId: "r-par-stop",
        config: {},
        parallel: 2,
        continueOnError: false,
      },
      { runner },
    );

    // a errored; b was already in flight; c/d never scheduled
    expect(calls).toBeLessThanOrEqual(2);
    expect(result.tests.map((test) => test.testId)).toContain("a");
    expect(result.tests.length).toBeLessThanOrEqual(2);
  });

  it("a test's spec, timeoutSec included, is recorded on its run row", async () => {
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t", timeoutSec: 1200 }],
        runsDir: path.join(proj, "runs"),
        runId: "r-timeout",
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );
    const run = readRunDirectory(result.runDir, quiet).effectiveAnnotations[result.tests[0].traceId]
      .run;
    expect((run as { test: { timeoutSec: number } }).test.timeoutSec).toBe(1200);
    expect(result.okCount).toBe(1);
  });

  it("a default run id starts with a sortable timestamp, so runs/ lists in creation order", async () => {
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t" }],
        runsDir: path.join(proj, "runs"),
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner: traceWritingRunner("done") },
    );

    // e.g. 2026-07-31-143022-Ab3dEf
    expect(result.runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-.{6}$/);
    expect(fs.existsSync(path.join(proj, "runs", result.runId, "statelog.jsonl"))).toBe(true);
  });

  it("refuses to reuse an existing run directory", async () => {
    fs.mkdirSync(path.join(proj, "runs", "taken"), { recursive: true });
    await expect(
      runSuite(
        {
          agent: path.join(proj, "agent.agency"),
          inputs: [{ id: "a", goal: "g", input: "t" }],
          runsDir: path.join(proj, "runs"),
          runId: "taken",
          config: {},
        },
        { runner: traceWritingRunner("done") },
      ),
    ).rejects.toThrow(/already exists/);
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
        runsDir,
        runId: "r-sigint",
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner },
    );

    // The in-flight test finished and was recorded; the rest never ran.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.tests.map((test) => test.testId)).toEqual(["input-1"]);
    expect(readRunDirectory(result.runDir, quiet).traces).toHaveLength(1);
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
          runsDir: path.join(proj, "runs"),
          runId: "r-quiet",
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
