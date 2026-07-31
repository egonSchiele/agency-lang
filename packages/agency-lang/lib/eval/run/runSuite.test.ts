import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvalRecordExtractor } from "./extract.js";
import { runSuite } from "./runSuite.js";

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

describe("runSuite", () => {
  let proj: string;
  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "runsuite-"));
    fs.writeFileSync(path.join(proj, "agent.agency"), "node main(task: string) { return 1 }\n");
  });
  afterEach(() => {
    // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
    // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it("module-dir == cwd: compiled entry lives inside each input's workdir", async () => {
    const runsDir = path.join(proj, "runs");
    const seen: { compiledEntryPath: string; cwd: string }[] = [];
    const runner = vi.fn(async (args: { compiledEntryPath: string; cwd: string }) => {
      seen.push({ compiledEntryPath: args.compiledEntryPath, cwd: args.cwd });
      return { ok: true as const };
    });

    const result = await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [{ id: "input-1", goal: "g", task: "t" }],
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
        inputs: [{ id: "input-1", goal: "g", task: "t" }],
        runsDir: path.join(proj, "runs"),
        runId: "r-overlay",
        config: {},
        perRun: {
          pipeOutput: false,
          seed: { baseDir: proj, agentRelPath: "agent.agency", closureFiles: [path.join(proj, "agent.agency")] },
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
    fs.writeFileSync(agent, "node main(task: string) {}\n");

    let sawFixture = false;
    const result = await runSuite(
      {
        agent,
        inputs: [{ id: "a", goal: "g", task: "t", files: filesDir }],
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
    const runner = vi.fn(async (args: { task: unknown }) => {
      seen.push(args.task);
      return { ok: true as const };
    });

    await runSuite(
      {
        agent: path.join(proj, "agent.agency"),
        inputs: [
          { id: "a", goal: "g", task: "write a haiku" },
          { id: "b", goal: "g", task: { rows: [1, 2], mode: "fast" } },
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
          { id: "input-1", goal: "g", task: "t" },
          { id: "input-2", goal: "g", task: "t" },
          { id: "input-3", goal: "g", task: "t" },
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
    const summary = JSON.parse(fs.readFileSync(path.join(runsDir, "r-sigint", "summary.json"), "utf8"));
    expect(summary.inputs).toHaveLength(1);
    // The listener does not outlive the suite.
    expect(process.listeners("SIGINT")).toEqual(before);
  });
});
