// Runs the built command against real Daytona containers. Not part of the
// default test run or of CI: `pnpm run build && pnpm run test:integration`,
// with DAYTONA_API_KEY set. No model is called.
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { beforeAll, expect, it } from "vitest";

import { listDaytonaSandboxes } from "./daytona.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = path.join(PACKAGE_DIR, "tests", "fixture-project");
const CLI = path.join(PACKAGE_DIR, "dist", "src", "cli.js");
const NOOP_AS_ROOT = "agency run /eval/project/noop.agency -- {input}";
const NOOP_AS_BENCH = "runuser -u bench -- agency run /opt/eval-fixture/noop.agency -- {input}";

type Ended = { code: number | null; output: string };

beforeAll(() => {
  // The fixture project uses this repo's agency-lang, built: the wrapper
  // packs it and installs it in each container.
  const link = path.join(PROJECT, "node_modules", "agency-lang");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  if (!fs.existsSync(link)) {
    fs.symlinkSync(path.join(PACKAGE_DIR, "..", "agency-lang"), link);
  }
  if (!fs.existsSync(CLI)) {
    throw new Error("build the package first: pnpm run build");
  }
});

function start(args: string[]): { child: ChildProcess; ended: Promise<Ended> } {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: PROJECT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const ended = new Promise<Ended>((resolve) => child.on("close", (code) => resolve({ code, output })));
  return { child, ended };
}

const out = (name: string): string => path.join("runs", `${name}-${Date.now()}`);

function rows(runDir: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(runDir, "annotations.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** How many of this tool's containers are still up once deletion has had a
 *  minute to finish. Daytona's delete returns before the container is gone,
 *  and for a while it is still listed, as "destroying" or under its old
 *  state. A container that really leaked is still there after the minute. */
async function sandboxesLeft(): Promise<number> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const all = await listDaytonaSandboxes({ tool: "agency-eval-daytona" });
    const up = all.filter((sandbox) => !/destroy/i.test(sandbox.state));
    if (up.length === 0 || Date.now() > deadline) {
      return up.length;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

it("runs each test and trial in its own container and brings every run directory back", async () => {
  const group = out("trials");
  const { ended } = start(["--agent-cmd", NOOP_AS_ROOT, "--suite", "suite", "-n", "2", "--trials", "2", "--out", group]);
  const { code, output } = await ended;
  expect(output).toContain("one-1  score 1.000");
  expect(code).toBe(0);

  const batches: unknown[] = [];
  for (const test of ["one", "two"]) {
    for (const trial of [1, 2]) {
      const runDir = path.join(PROJECT, group, test, String(trial));
      expect(fs.statSync(path.join(runDir, "statelog.jsonl")).size).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(runDir, "workdir"))).toBe(false);
      const [run, ...scores] = rows(runDir);
      expect(run).toMatchObject({ kind: "run", trial });
      batches.push(run.batch);
      expect(scores.map((row) => [row.name, row.score])).toEqual([
        ["setup-ran", { kind: "binary", pass: true }],
        ["seeded", { kind: "binary", pass: true }],
      ]);
      expect(fs.statSync(path.join(PROJECT, group, ".logs", `${test}-${trial}.log`)).size).toBeGreaterThan(0);
    }
  }
  expect(batches.every((batch) => batch === batches[0])).toBe(true);
  expect(await sandboxesLeft()).toBe(0);
});

it("lets an agent that runs as another user reach its workdir and write its statelog", async () => {
  const group = out("bench");
  const { ended } = start(["--agent-cmd", NOOP_AS_BENCH, "--suite", "suite-bench", "--out", group]);
  const { code, output } = await ended;
  expect(output).toContain("as-bench  score 1.000");
  expect(code).toBe(0);
  const runDir = path.join(PROJECT, group, "as-bench");
  expect(fs.statSync(path.join(runDir, "statelog.jsonl")).size).toBeGreaterThan(0);
  expect(await sandboxesLeft()).toBe(0);
});

it("on Ctrl-C, prints the summary, exits 130 and leaves no container", async () => {
  const group = out("interrupted");
  const { child, ended } = start(["--agent-cmd", NOOP_AS_ROOT, "--suite", "suite-slow", "--out", group]);
  // The test's setup sleeps for five minutes. Interrupt once the inner run
  // has had time to start it.
  const logFile = path.join(PROJECT, group, ".logs", "slow.log");
  const deadline = Date.now() + 240_000;
  while (!fs.existsSync(logFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  expect(fs.existsSync(logFile)).toBe(true);
  child.kill("SIGINT");
  const { code, output } = await ended;
  // The inner run got the interrupt once, folded the test into a run
  // directory, and that directory came back. "failed:" would mean it did not.
  expect(output).toMatch(/^slow {2}interrupted, not graded/m);
  expect(rows(path.join(PROJECT, group, "slow"))[0]).toMatchObject({ kind: "run" });
  expect(fs.readFileSync(logFile, "utf8")).toContain("setup failed: interrupted");
  expect(code).toBe(130);
  expect(await sandboxesLeft()).toBe(0);
});

it("on Ctrl-C while the agent is working, brings back the agent's trace", async () => {
  const group = out("agent-interrupted");
  const sleeper = "agency run /eval/project/sleeper.agency -- {input}";
  const { child, ended } = start(["--agent-cmd", sleeper, "--suite", "suite-agent-slow", "--out", group]);
  // The inner run prints where the agent's statelog is just before it
  // starts the agent, which then sleeps for five minutes.
  const logFile = path.join(PROJECT, group, ".logs", "sleepy.log");
  const deadline = Date.now() + 240_000;
  const agentStarted = (): boolean =>
    fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("live statelog");
  while (!agentStarted() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  expect(agentStarted()).toBe(true);
  // Give the agent a moment to write its first events.
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  child.kill("SIGINT");
  const { code, output } = await ended;
  expect(output).toMatch(/^sleepy {2}interrupted, not graded/m);
  const runDir = path.join(PROJECT, group, "sleepy");
  expect(fs.statSync(path.join(runDir, "statelog.jsonl")).size).toBeGreaterThan(0);
  expect(rows(runDir).map((row) => row.kind)).toEqual(["run"]);
  expect(code).toBe(130);
  expect(await sandboxesLeft()).toBe(0);
});
