import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { tempDir } from "@/runDirectory/testFixtures.js";

import { readHarborInputs, readHarborTrial } from "./readTrials.js";
import { writeHarborJobFiles, writeHarborTrial, type FakeHarborTrial } from "./testFixtures.js";

function trial(overrides: Partial<FakeHarborTrial> & { name: string }): FakeHarborTrial {
  return {
    taskName: "swe-bench/astropy__astropy-12907",
    source: "swe-bench-verified",
    startedAt: "2026-11-13T10:00:00Z",
    rewards: { reward: 1 },
    statelogLines: ["{}"],
    ...overrides,
  };
}

function writeLines(file: string, lines: string[]): string {
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("readHarborInputs", () => {
  it("a job folder gives its trials ordered by start time, ignoring job-level files", () => {
    const jobDir = path.join(tempDir("harbor-"), "k1-agency-minimal");
    writeHarborJobFiles(jobDir);
    writeHarborTrial(jobDir, trial({ name: "a__late", startedAt: "2026-11-13T12:00:00Z" }));
    writeHarborTrial(jobDir, trial({ name: "b__early", startedAt: "2026-11-13T09:00:00Z" }));
    writeHarborTrial(jobDir, trial({ name: "c__tie", startedAt: "2026-11-13T12:00:00Z" }));
    const { trials, problems } = readHarborInputs({ jobDirs: [jobDir] });
    expect(problems).toEqual([]);
    expect(trials.map((each) => each.trialName)).toEqual(["b__early", "a__late", "c__tie"]);
    expect(trials[0].jobName).toBe("k1-agency-minimal");
  });

  it("a job's subfolder without result.json is a problem, and the rest still read", () => {
    const jobDir = path.join(tempDir("harbor-"), "job");
    writeHarborTrial(jobDir, trial({ name: "good" }));
    fs.mkdirSync(path.join(jobDir, "crashed", "agent"), { recursive: true });
    const { trials, problems } = readHarborInputs({ jobDirs: [jobDir] });
    expect(trials.map((each) => each.trialName)).toEqual(["good"]);
    expect(problems).toEqual([
      { path: path.join(jobDir, "crashed"), reason: expect.stringContaining("result.json") },
    ]);
  });

  it("a job folder that doesn't exist is a problem, and the other jobs still read", () => {
    const root = tempDir("harbor-");
    writeHarborTrial(path.join(root, "job"), trial({ name: "x" }));
    const missing = path.join(root, "no-such-job");
    const { trials, problems } = readHarborInputs({ jobDirs: [missing, path.join(root, "job")] });
    expect(trials.map((each) => each.trialName)).toEqual(["x"]);
    expect(problems).toEqual([{ path: missing, reason: "not a folder" }]);
  });

  it("a trials file gives its trials in line order, skipping blanks and comments", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "job");
    writeHarborTrial(jobDir, trial({ name: "x", startedAt: "2026-11-13T12:00:00Z" }));
    writeHarborTrial(jobDir, trial({ name: "y", startedAt: "2026-11-13T09:00:00Z" }));
    const file = writeLines(path.join(root, "trials.txt"), [
      "# picked by hand",
      "job/x",
      "",
      "job/y",
    ]);
    const { trials, problems } = readHarborInputs({ jobDirs: [], trialsFile: file });
    expect(problems).toEqual([]);
    expect(trials.map((each) => each.trialName)).toEqual(["x", "y"]);
  });

  it("job folders come before the trials file, in argument order", () => {
    const root = tempDir("harbor-");
    writeHarborTrial(path.join(root, "job2"), trial({ name: "j2" }));
    writeHarborTrial(path.join(root, "job1"), trial({ name: "j1" }));
    writeHarborTrial(path.join(root, "extra"), trial({ name: "e" }));
    const file = writeLines(path.join(root, "trials.txt"), ["extra/e"]);
    const { trials } = readHarborInputs({
      jobDirs: [path.join(root, "job2"), path.join(root, "job1")],
      trialsFile: file,
    });
    expect(trials.map((each) => `${each.jobName}/${each.trialName}`)).toEqual([
      "job2/j2",
      "job1/j1",
      "extra/e",
    ]);
  });

  it("a trials file that doesn't exist is a problem, and the job folders still read", () => {
    const root = tempDir("harbor-");
    writeHarborTrial(path.join(root, "job"), trial({ name: "x" }));
    const missing = path.join(root, "no-such-list.txt");
    const { trials, problems } = readHarborInputs({
      jobDirs: [path.join(root, "job")],
      trialsFile: missing,
    });
    expect(trials.map((each) => each.trialName)).toEqual(["x"]);
    expect(problems).toEqual([{ path: missing, reason: "no such file" }]);
  });

  it("the same trial twice within one trials file is a problem", () => {
    const root = tempDir("harbor-");
    writeHarborTrial(path.join(root, "job"), trial({ name: "x" }));
    const file = writeLines(path.join(root, "trials.txt"), ["job/x", "./job/x"]);
    const { trials, problems } = readHarborInputs({ jobDirs: [], trialsFile: file });
    expect(trials).toHaveLength(1);
    expect(problems).toEqual([
      { path: `${file}:2`, reason: expect.stringContaining("listed twice") },
    ]);
  });

  it("a trial listed twice is a problem and is read once", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "job");
    writeHarborTrial(jobDir, trial({ name: "x" }));
    const file = writeLines(path.join(root, "trials.txt"), ["./job/x"]);
    const { trials, problems } = readHarborInputs({ jobDirs: [jobDir], trialsFile: file });
    expect(trials).toHaveLength(1);
    expect(problems).toEqual([
      { path: `${file}:1`, reason: expect.stringContaining("listed twice") },
    ]);
  });

  it("a trials line that isn't a trial folder is a problem naming the line", () => {
    const root = tempDir("harbor-");
    const jobDir = path.join(root, "job");
    writeHarborTrial(jobDir, trial({ name: "x" }));
    fs.mkdirSync(path.join(jobDir, "empty"));
    const file = writeLines(path.join(root, "trials.txt"), ["job/missing", "job/empty", "job/x"]);
    const { trials, problems } = readHarborInputs({ jobDirs: [], trialsFile: file });
    expect(trials.map((each) => each.trialName)).toEqual(["x"]);
    expect(problems.map((problem) => problem.path)).toEqual([`${file}:1`, `${file}:2`]);
  });
});

describe("readHarborTrial", () => {
  it("strips the source prefix from the task name", () => {
    const dir = writeHarborTrial(tempDir("harbor-"), trial({ name: "t" }));
    const result = readHarborTrial(dir);
    expect(result).toMatchObject({ ok: true, trial: { testId: "astropy__astropy-12907" } });
  });

  it("reads rewards, the exception and the source", () => {
    const dir = writeHarborTrial(
      tempDir("harbor-"),
      trial({
        name: "t",
        rewards: null,
        exception: { type: "AgentTimeoutError", message: "took too long" },
      }),
    );
    const result = readHarborTrial(dir);
    expect(result).toMatchObject({
      ok: true,
      trial: {
        benchmark: "swe-bench-verified",
        rewards: null,
        exception: { type: "AgentTimeoutError", message: "took too long" },
        statelogPath: path.join(dir, "agent", "statelog.jsonl"),
      },
    });
  });

  it("refuses a task name that leaves an empty or dot test id", () => {
    const root = tempDir("harbor-");
    for (const taskName of ["swe-bench/", "swe-bench/."]) {
      const dir = writeHarborTrial(root, trial({ name: `t-${taskName.length}`, taskName }));
      expect(readHarborTrial(dir)).toMatchObject({ ok: false, problem: { path: dir } });
    }
  });

  it("refuses a task name containing / or ..", () => {
    const root = tempDir("harbor-");
    for (const taskName of ["swe-bench/a/b", "swe-bench/..", "swe-bench/a..b"]) {
      const dir = writeHarborTrial(root, trial({ name: `t-${taskName.length}`, taskName }));
      const result = readHarborTrial(dir);
      expect(result).toMatchObject({ ok: false, problem: { path: dir } });
    }
  });

  it("reports a result.json missing a field, naming it", () => {
    const dir = writeHarborTrial(tempDir("harbor-"), trial({ name: "t" }));
    const file = path.join(dir, "result.json");
    const { task_name: _dropped, ...rest } = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(file, JSON.stringify(rest));
    const result = readHarborTrial(dir);
    expect(result).toMatchObject({
      ok: false,
      problem: { path: dir, reason: expect.stringContaining("task_name") },
    });
  });

  it("reports a result.json that isn't valid JSON", () => {
    const dir = writeHarborTrial(tempDir("harbor-"), trial({ name: "t" }));
    fs.writeFileSync(path.join(dir, "result.json"), "{ cut off");
    expect(readHarborTrial(dir)).toMatchObject({
      ok: false,
      problem: { path: dir, reason: expect.stringContaining("not valid JSON") },
    });
  });

  it("an empty statelog counts as no trace", () => {
    const dir = writeHarborTrial(
      tempDir("harbor-"),
      trial({ name: "t", statelogLines: undefined }),
    );
    fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agent", "statelog.jsonl"), "");
    expect(readHarborTrial(dir)).toMatchObject({ ok: true, trial: { statelogPath: null } });
  });

  it("statelogPath is null when the agent never started", () => {
    const dir = writeHarborTrial(
      tempDir("harbor-"),
      trial({ name: "t", statelogLines: undefined }),
    );
    expect(readHarborTrial(dir)).toMatchObject({ ok: true, trial: { statelogPath: null } });
  });
});

describe("readHarborTrial: the agent and its reported usage", () => {
  const PI = {
    agentInfo: { name: "pi", model: "z-ai/glm-5.3-flash" },
    agentResult: { input: 57240, cache: 50944, output: 1404, cost: 0.00317472 },
  };

  function read(overrides: Partial<FakeHarborTrial>) {
    const dir = writeHarborTrial(tempDir("harbor-"), trial({ name: "t", ...overrides }));
    const result = readHarborTrial(dir);
    if (!result.ok) throw new Error(result.problem.reason);
    return result.trial;
  }

  it("reads a Pi trial's agent and reported usage", () => {
    const pi = read({
      ...PI,
      statelogLines: undefined,
      agentExecution: {
        startedAt: "2026-11-13T23:34:26.015034Z",
        finishedAt: "2026-11-13T23:35:34.868438Z",
      },
    });
    expect(pi.agentName).toBe("pi");
    expect(pi.reported).toEqual({
      models: [
        {
          name: "z-ai/glm-5.3-flash",
          reasoning: null,
          calls: 0,
          inputTokens: 6296,
          cachedInputTokens: 50944,
          cacheCreationInputTokens: 0,
          outputTokens: 1404,
          costUsd: 0.00317472,
        },
      ],
      startedAtMs: Date.parse("2026-11-13T23:34:26.015Z"),
      durationMs: 68_853,
      lastEventAt: "2026-11-13T23:35:34.868Z",
    });
  });

  it("reports nothing for an Agency trial with null token counts", () => {
    const agency = read({
      agentInfo: { name: "agency-agent", model: "z-ai/glm-5.3-flash" },
      agentResult: { input: null, cache: null, output: null, cost: null },
    });
    expect(agency.agentName).toBe("agency-agent");
    expect(agency.reported).toBeNull();
  });

  it("falls back to the trial's own times without agent_execution", () => {
    const pi = read({
      ...PI,
      startedAt: "2026-11-13T23:33:54.260502Z",
      finishedAt: "2026-11-13T23:36:35.714892Z",
    });
    expect(pi.reported?.startedAtMs).toBe(Date.parse("2026-11-13T23:33:54.260Z"));
    expect(pi.reported?.lastEventAt).toBe("2026-11-13T23:36:35.714Z");
  });

  it("counts a missing cost as zero when tokens are present", () => {
    const pi = read({ ...PI, agentResult: { ...PI.agentResult, cost: null } });
    expect(pi.reported?.models[0].costUsd).toBe(0);
  });

  it("reads an old result.json with none of these fields", () => {
    const old = read({});
    expect(old.agentName).toBeNull();
    expect(old.reported).toBeNull();
  });
});
