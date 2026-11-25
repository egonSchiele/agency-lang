import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { expect, it } from "vitest";

import { argsProblem, planJobs, uploadExclusions, type CliArgs } from "./jobs.js";

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-daytona-jobs-"));
  fs.mkdirSync(path.join(dir, "agency-plans", "unit-literals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agency-plans", "noop.agency"), "node main() {}\n");
  fs.writeFileSync(path.join(dir, "suite.json"), "{}");
  return dir;
}
const cli = (over: Partial<CliArgs> = {}): CliArgs => ({
  agentCmd: "agency agent -p -- {input}",
  suite: "agency-plans",
  test: [],
  tags: [],
  parallel: 1,
  trials: 1,
  env: [],
  keep: false,
  ...over,
});
const plan = (over: Partial<Parameters<typeof planJobs>[0]> = {}) =>
  planJobs({
    cli: cli(),
    tests: [{ id: "unit-literals", timeoutSec: 7200 }],
    projectDir: "/p",
    groupDir: "/group",
    batch: "nightly-ab12cd34",
    graceSec: 7200,
    ...over,
  });

it("builds the inner command for a command agent", () => {
  expect(plan()[0].innerArgv).toEqual([
    "agency", "eval", "run", "--agent-cmd", "agency agent -p -- {input}",
    "--suite", "agency-plans", "--test", "unit-literals",
    "--batch", "nightly-ab12cd34", "--trial-number", "1",
    "--grade", "--no-workdir-snapshot", "--out", "/eval/out",
  ]);
});
it("builds it for a file agent, with the path as given", () => {
  const [job] = plan({ cli: cli({ agentCmd: undefined, agent: "agency-plans/noop.agency" }) });
  expect(job.innerArgv.slice(0, 4)).toEqual(["agency", "eval", "run", "agency-plans/noop.agency"]);
});
it("makes one job per test and trial, in trial-major order", () => {
  const jobs = plan({ cli: cli({ trials: 2 }), tests: [{ id: "a" }, { id: "b" }] });
  expect(jobs.map((job) => job.label)).toEqual(["a-1", "b-1", "a-2", "b-2"]);
  expect(jobs[2]).toMatchObject({ testId: "a", trial: 2, hostRunDir: "/group/a/2", logFile: "/group/.logs/a-2.log" });
  expect(jobs[2].innerArgv).toContain("2");
});
it("writes a single trial flat", () => {
  expect(plan({ tests: [{ id: "a" }] })[0]).toMatchObject({
    label: "a",
    hostRunDir: "/group/a",
    logFile: "/group/.logs/a.log",
  });
});
it("allows each job its test's time limit, the setup limit, and the grace", () => {
  expect(plan()[0].maxSeconds).toBe(7200 + 1800 + 7200);
  expect(plan({ tests: [{ id: "a" }] })[0].maxSeconds).toBe(3600 + 1800 + 7200);
});
it("refuses a test id the inner --test would read as a pattern", () => {
  for (const id of ["a*", "a?", "[ab]", "{a,b}"]) {
    expect(() => plan({ tests: [{ id }] })).toThrow(`test id "${id}"`);
  }
});

it("leaves out node_modules, .git, the runs directory, and a group directory elsewhere in the project", () => {
  expect(uploadExclusions({ projectDir: "/p", groupDir: "/p/out/x", runsDir: "runs" })).toEqual([
    "node_modules", ".git", "runs", "out/x",
  ]);
  expect(uploadExclusions({ projectDir: "/p", groupDir: "/p/runs/x", runsDir: "runs" })).toEqual([
    "node_modules", ".git", "runs",
  ]);
  expect(uploadExclusions({ projectDir: "/p", groupDir: "/elsewhere/x", runsDir: "runs" })).toEqual([
    "node_modules", ".git", "runs",
  ]);
});

it("accepts a suite directory and an agent inside the project", () => {
  const dir = project();
  expect(argsProblem(cli(), dir)).toBeUndefined();
  expect(argsProblem(cli({ agentCmd: undefined, agent: "agency-plans/noop.agency" }), dir)).toBeUndefined();
});
it("says why arguments cannot be wrapped", () => {
  const dir = project();
  expect(argsProblem(cli({ agentCmd: undefined }), dir)).toMatch(/exactly one of an agent file or --agent-cmd/);
  expect(argsProblem(cli({ agent: "agency-plans/noop.agency" }), dir)).toMatch(/exactly one/);
  expect(argsProblem(cli({ agentCmd: "agency agent -p" }), dir)).toMatch(/\{input\}/);
  expect(argsProblem(cli({ suite: "suite.json" }), dir)).toMatch(/--suite must be a directory/);
  expect(argsProblem(cli({ suite: "missing" }), dir)).toMatch(/--suite must be a directory/);
  expect(argsProblem(cli({ suite: ".." }), dir)).toMatch(/inside the project/);
  expect(argsProblem(cli({ agentCmd: undefined, agent: "/abs/noop.agency" }), dir)).toMatch(/inside the project/);
  expect(argsProblem(cli({ agentCmd: undefined, agent: "../noop.agency" }), dir)).toMatch(/inside the project/);
  expect(argsProblem(cli({ parallel: 0 }), dir)).toMatch(/-n/);
  expect(argsProblem(cli({ trials: 1.5 }), dir)).toMatch(/--trials/);
});
