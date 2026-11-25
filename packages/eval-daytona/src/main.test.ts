import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { beforeEach, expect, it } from "vitest";

import type { CliArgs, Job } from "./jobs.js";
import { main, type MainDeps } from "./main.js";
import type { JobResult } from "./runJob.js";
import type { ListedRun } from "./summary.js";

let projectDir: string;
let logged: string[];
let started: Job[];
let controller: AbortController;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-daytona-main-"));
  fs.mkdirSync(path.join(projectDir, "suite"));
  logged = [];
  started = [];
  controller = new AbortController();
});

const cli = (over: Partial<CliArgs> = {}): CliArgs => ({
  agentCmd: "agency agent -p -- {input}",
  suite: "suite",
  test: [],
  tags: [],
  out: "runs/x",
  parallel: 1,
  trials: 1,
  env: [],
  keep: false,
  ...over,
});

const listed = (dir: string, costUsd: number, latestScore: number | null = 1): ListedRun =>
  ({ dir, summary: { costUsd, latestScore }, scores: [] }) as unknown as ListedRun;

function deps(
  over: Partial<MainDeps> = {},
  results: Record<string, JobResult> = {},
  costs: Record<string, number> = {},
): MainDeps {
  return {
    projectDir,
    env: { OPENROUTER_API_KEY: "sk", ORACLE: "leaked" },
    listTests: async () => [{ id: "a", timeoutSec: 600 }, { id: "b" }],
    listRuns: (dir) => [listed(dir, costs[path.basename(dir)] ?? 0.5)],
    agencyConfig: () => ({ runsDir: "runs" }),
    agencyTarball: () => "agency.tgz",
    runJob: async (job) => {
      started.push(job);
      return results[job.label] ?? { cameBack: true };
    },
    signal: controller.signal,
    log: (line) => logged.push(line),
    ...over,
  };
}

it("refuses arguments that cannot be wrapped before any container starts", async () => {
  expect(await main(cli({ suite: "missing" }), deps())).toBe(1);
  expect(logged.join("\n")).toMatch(/--suite must be a directory/);
  expect(started).toEqual([]);
});

it("refuses a group directory that already exists", async () => {
  fs.mkdirSync(path.join(projectDir, "runs", "x"), { recursive: true });
  expect(await main(cli(), deps())).toBe(1);
  expect(logged.join("\n")).toMatch(/already exists/);
  expect(started).toEqual([]);
});

it("refuses a selection that matches no test", async () => {
  expect(await main(cli(), deps({ listTests: async () => [] }))).toBe(1);
  expect(logged.join("\n")).toMatch(/no test/);
});

it("returns 0, with one line per job and the upload command, when every job came back clean", async () => {
  expect(await main(cli(), deps())).toBe(0);
  expect(started.map((job) => job.label)).toEqual(["a", "b"]);
  expect(logged).toContain("a  score 1.000  $0.50");
  expect(logged.at(-1)).toBe("upload with: agency eval upload runs/x");
});

it("gives every job the same batch id, named after the group directory", async () => {
  await main(cli(), deps());
  const batches = started.map((job) => job.innerArgv[job.innerArgv.indexOf("--batch") + 1]);
  expect(batches[0]).toMatch(/^x-[A-Za-z0-9_-]{8}$/);
  expect(batches[1]).toBe(batches[0]);
});

it("passes the env names that are set, says once which are not, and adds --env pairs without reading the host", async () => {
  fs.writeFileSync(
    path.join(projectDir, "eval-daytona.json"),
    JSON.stringify({ env: ["OPENROUTER_API_KEY", "STATELOG_API_KEY"] }),
  );
  const envs: Record<string, string>[] = [];
  await main(
    cli({ env: ["ORACLE=1"] }),
    deps({
      runJob: async (_job, args) => {
        envs.push(args.env);
        return { cameBack: true };
      },
    }),
  );
  expect(envs[0]).toEqual({ OPENROUTER_API_KEY: "sk", ORACLE: "1" });
  expect(logged.filter((line) => line.includes("not set"))).toEqual([
    "not set, so not passed to the containers: STATELOG_API_KEY",
  ]);
});

it("leaves earlier runs and dependencies out of the upload", async () => {
  const excludes: string[][] = [];
  await main(
    cli(),
    deps({
      runJob: async (_job, args) => {
        excludes.push(args.exclude);
        return { cameBack: true };
      },
    }),
  );
  expect(excludes[0]).toEqual(["node_modules", ".git", "runs"]);
});

it("returns 1 when a job brought nothing back, still runs the others, and still prints the summary", async () => {
  const problem = "no run directory came back (exit 137):\nlog";
  const code = await main(cli(), deps({}, { a: { cameBack: false, problem } }));
  expect(code).toBe(1);
  expect(started.map((job) => job.label)).toEqual(["a", "b"]);
  expect(logged).toContain("a  failed: no run directory came back (exit 137):");
  expect(logged).toContain("b  score 1.000  $0.50");
});

it("starts no more jobs once the returned runs' cost passes the batch cap", async () => {
  const config = () => ({ runsDir: "runs", maxBatchCostUsd: 5 });
  const code = await main(cli(), deps({ agencyConfig: config }, {}, { a: 6 }));
  expect(started.map((job) => job.label)).toEqual(["a"]);
  expect(logged).toContain("b  not started");
  expect(logged.join("\n")).toMatch(/batch cost cap/);
  expect(code).toBe(1);
});

it("after an abort, starts no more jobs, lets the running one come back, prints the summary and returns 130", async () => {
  const code = await main(
    cli(),
    deps({
      runJob: async (job) => {
        started.push(job);
        controller.abort();
        return { cameBack: true, problem: "interrupted, not graded" };
      },
      listRuns: (dir) => [listed(dir, 1.5, null)],
    }),
  );
  expect(started.map((job) => job.label)).toEqual(["a"]);
  expect(logged).toContain("a  interrupted, not graded  $1.50");
  expect(logged).toContain("b  not started");
  expect(code).toBe(130);
});

it("runs each trial of each test as its own job", async () => {
  await main(cli({ trials: 2 }), deps());
  expect(started.map((job) => job.label)).toEqual(["a-1", "b-1", "a-2", "b-2"]);
});
