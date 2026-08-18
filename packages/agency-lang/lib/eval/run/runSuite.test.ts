import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvalRecordExtractor } from "./extract.js";
import { runSuite } from "./runSuite.js";

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

describe("runSuite", () => {
  let proj: string;
  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "runsuite-"));
    fs.writeFileSync(path.join(proj, "agent.agency"), "node main(input: string) { return 1 }\n");
  });
  afterEach(() => {
    // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
    // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it("module-dir == cwd: compiled entry lives inside each input's workdir", async () => {
    const runsDir = path.join(proj, "runs");
    const seen: { compiledEntryPath: string; cwd: string }[] = [];
    const runner = vi.fn(
      async (args: { kind: string; compiledEntryPath?: string; cwd: string }) => {
        seen.push({ compiledEntryPath: args.compiledEntryPath as string, cwd: args.cwd });
        return { ok: true as const };
      },
    );

    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "input-1", goal: "g", input: "t" }],
        runsDir,
        runId: "r1",
        config: {},
        perRun: { pipeOutput: false },
      },
      { runner },
    );

    const workdir = result.inputs[0].workdirPath;
    expect(seen).toHaveLength(1);
    expect(seen[0].cwd).toBe(workdir);
    expect(seen[0].compiledEntryPath.startsWith(workdir + path.sep)).toBe(true);
    expect(fs.existsSync(seen[0].compiledEntryPath)).toBe(true);
  });

  it("overlayFiles overwrite the seed copy inside each input's workdir", async () => {
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

  it("seeds an input's files directory into the workdir", async () => {
    const filesDir = path.join(proj, "fixtures");
    fs.mkdirSync(path.join(filesDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(filesDir, "data", "report.txt"), "q3");
    // The runs directory must not sit inside the agent's directory: the seed
    // copy would otherwise recurse into its own destination.
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
        perRun: { extractor: recordExtractor("ok") },
      },
      {
        runner: async ({ cwd, statelogPath }) => {
          sawFixture = fs.existsSync(path.join(cwd, "data", "report.txt"));
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: true };
        },
      },
    );

    expect(result.inputs[0].status).toBe("success");
    expect(sawFixture).toBe(true);
  });

  it("delivers each input's task to the runner — string and object alike", async () => {
    const seen: unknown[] = [];
    const runner = vi.fn(async (args: { kind: string; task?: unknown }) => {
      seen.push(args.input);
      return { ok: true as const };
    });

    await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "a", goal: "g", input: "write a haiku" },
          { id: "b", goal: "g", input: { rows: [1, 2], mode: "fast" } },
        ],
        runsDir: path.join(proj, "runs"),
        runId: "r-task",
        config: {},
        perRun: { pipeOutput: false, extractor: recordExtractor("done") },
      },
      { runner },
    );

    expect(seen).toEqual(["write a haiku", { rows: [1, 2], mode: "fast" }]);
  });

  it("runs a resolved command target end-to-end: substituted argv per input, command provenance recorded", async () => {
    const runsDir = path.join(proj, "runs");
    const seen: string[][] = [];
    const runner = vi.fn(async (job: { kind: string; argv?: string[]; statelogPath?: string }) => {
      seen.push(job.argv as string[]);
      fs.writeFileSync(job.statelogPath as string, "{}\n");
      return { ok: true as const };
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
        perRun: { pipeOutput: false, extractor: recordExtractor("done") },
      },
      { runner },
    );

    expect(seen).toEqual([
      ["some-agent", "-p", "first task"],
      ["some-agent", "-p", "second task"],
    ]);
    expect(result.inputs.map((i) => i.status)).toEqual(["success", "success"]);
    const config = JSON.parse(fs.readFileSync(path.join(runsDir, "r-cmd", "config.json"), "utf8"));
    expect(config.provenance.agent.command).toBe("some-agent -p {task}");
    expect(config.provenance.agent.harnessVersion).toBeTruthy();
  });

  it("records the invoked agency CLI's --version in command provenance, best-effort", async () => {
    const fakeAgency = path.join(proj, "agency");
    fs.writeFileSync(fakeAgency, "#!/bin/sh\necho 9.9.9-test\n");
    fs.chmodSync(fakeAgency, 0o755);
    const runner = vi.fn(async (job: { statelogPath?: string }) => {
      fs.writeFileSync(job.statelogPath as string, "{}\n");
      return { ok: true as const };
    });

    await runSuite(
      {
        agent: {
          kind: "command",
          tokens: [fakeAgency, "agent", "-p", "{task}"],
          label: `${fakeAgency} agent -p {task}`,
        },
        inputs: [{ id: "a", goal: "g", input: "t" }],
        runsDir: path.join(proj, "runs"),
        runId: "r-cliv",
        config: {},
        perRun: { pipeOutput: false, extractor: recordExtractor("done") },
      },
      { runner },
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(proj, "runs", "r-cliv", "config.json"), "utf8"),
    );
    expect(config.provenance.agent.cliVersion).toBe("9.9.9-test");
  });

  it("parallel > 1: runs through a bounded pool, keeps input order, never pipes output", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const runner = vi.fn(async (job: { kind: string; task?: unknown; statelogPath?: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.push(String(job.input));
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(job.statelogPath as string, "{}\n");
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
        perRun: { extractor: recordExtractor("done") },
      },
      { runner },
    );

    expect(maxInFlight).toBe(2);
    expect(started.length).toBe(4);
    // results in INPUT order regardless of completion order
    expect(result.inputs.map((i) => i.inputId)).toEqual(["a", "b", "c", "d"]);
    expect(result.okCount).toBe(4);
  });

  it("parallel + continueOnError=false: an error stops scheduling; in-flight inputs still record", async () => {
    let calls = 0;
    const runner = vi.fn(async (job: { task?: unknown; statelogPath?: string }) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      if (String(job.input) === "t-a") {
        return { ok: false as const, errorMessage: "boom" };
      }
      fs.writeFileSync(job.statelogPath as string, "{}\n");
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
        perRun: { extractor: recordExtractor("done") },
      },
      { runner },
    );

    // a errored; b was already in flight; c/d never scheduled
    expect(calls).toBeLessThanOrEqual(2);
    expect(result.inputs.map((i) => i.inputId)).toContain("a");
    expect(result.inputs.length).toBeLessThanOrEqual(2);
  });

  it("an input's timeoutSec is forwarded to runAgent", async () => {
    // Observed indirectly through the seam the real runners use: with a fake
    // runner the limits never surface, so assert at the options level via a
    // one-off agent path check is not possible — instead this pins the wiring
    // by exercising limitsFromConfig's override directly in subprocess.test.
    // Here: the input field survives loading into the suite run (input.json).
    const runner = vi.fn(async (job: { statelogPath?: string }) => {
      fs.writeFileSync(job.statelogPath as string, "{}\n");
      return { ok: true as const };
    });
    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t", timeoutSec: 1200 }],
        runsDir: path.join(proj, "runs"),
        runId: "r-timeout",
        config: {},
        perRun: { pipeOutput: false, extractor: recordExtractor("done") },
      },
      { runner },
    );
    const inputJson = JSON.parse(
      fs.readFileSync(path.join(proj, "runs", "r-timeout", "inputs", "a", "input.json"), "utf8"),
    );
    expect(inputJson.timeoutSec).toBe(1200);
    expect(result.okCount).toBe(1);
  });

  it("a default run id starts with a sortable timestamp, so runs/ lists in creation order", async () => {
    const runner = vi.fn(async (job: { statelogPath?: string }) => {
      fs.writeFileSync(job.statelogPath as string, "{}\n");
      return { ok: true as const };
    });

    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "a", goal: "g", input: "t" }],
        runsDir: path.join(proj, "runs"),
        config: {},
        perRun: { pipeOutput: false, extractor: recordExtractor("done") },
      },
      { runner },
    );

    // e.g. 2026-07-31-143022-Ab3dEf
    expect(result.runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-.{6}$/);
    expect(fs.existsSync(path.join(proj, "runs", result.runId, "summary.json"))).toBe(true);
  });

  it("SIGINT stops the loop after the in-flight input and still writes summary.json", async () => {
    const runsDir = path.join(proj, "runs");
    const before = process.listeners("SIGINT");
    const runner = vi.fn(async () => {
      // Fire runSuite's own listener directly (a real signal would kill the
      // test process): find the one this run installed and invoke it.
      const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
      expect(added).toHaveLength(1);
      added[0]("SIGINT");
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
        perRun: { pipeOutput: false, extractor: recordExtractor("done") },
      },
      { runner },
    );

    // The in-flight input finished and was recorded; the rest never ran.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.inputs.map((i) => i.inputId)).toEqual(["input-1"]);
    const summary = JSON.parse(
      fs.readFileSync(path.join(runsDir, "r-sigint", "summary.json"), "utf8"),
    );
    expect(summary.inputs).toHaveLength(1);
    // The listener does not outlive the suite.
    expect(process.listeners("SIGINT")).toEqual(before);
  });

  it("progress: false prints nothing — the optimizer's --silent depends on it", async () => {
    const errSpy = vi.spyOn(console, "error");
    const runner = vi.fn(async () => ({ ok: true as const }));
    try {
      await runSuite(
        {
          agent: path.join(proj, "agent.agency"),
          inputs: [{ id: "input-1", goal: "g", input: "t" }],
          runsDir: path.join(proj, "runs"),
          runId: "r-quiet",
          config: {},
          progress: false,
          perRun: { pipeOutput: false, extractor: recordExtractor("done") },
        },
        { runner },
      );
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
