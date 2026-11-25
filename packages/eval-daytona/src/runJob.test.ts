import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { beforeEach, expect, it } from "vitest";

import { FakeSandbox, type FakeReply } from "./fakeSandbox.js";
import type { Job } from "./jobs.js";
import { EXIT_FILE } from "./longCommand.js";
import { readOptions } from "./options.js";
import { REQUIRED_FLAGS, runJob } from "./runJob.js";

const HELP = `Usage: agency eval run\n  ${REQUIRED_FLAGS.join("\n  ")}\n`;

let dir: string;
let job: Job;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-daytona-runjob-"));
  fs.mkdirSync(path.join(dir, "project", "suite"), { recursive: true });
  fs.mkdirSync(path.join(dir, "project", "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "project", "suite", "test.json"), "{}");
  fs.writeFileSync(path.join(dir, "project", "node_modules", "x", "index.js"), "");
  fs.writeFileSync(path.join(dir, "agency.tgz"), "tarball");
  job = {
    testId: "a",
    trial: 1,
    label: "a",
    hostRunDir: path.join(dir, "group", "a"),
    logFile: path.join(dir, "group", ".logs", "a.log"),
    innerArgv: ["agency", "eval", "run", "--test", "a", "--out", "/eval/out"],
    maxSeconds: 16200,
  };
});

/** A gzipped tar of a run directory, as the container would pack it. */
function runArchive(): Buffer {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "eval-daytona-run-"));
  fs.writeFileSync(path.join(run, "statelog.jsonl"), "{}\n");
  fs.writeFileSync(path.join(run, "annotations.jsonl"), "{}\n");
  return execFileSync("tar", ["-czf", "-", "-C", run, "."]);
}

type Shape = {
  help?: string;
  exit?: string;
  /** Whether /eval/out/<id> exists after the command. */
  wroteRun?: boolean;
  /** Pieces of console output, one per poll. */
  output?: string[];
  /** The exit file never appears. */
  hangs?: boolean;
};

function sandboxFor(shape: Shape = {}): FakeSandbox {
  let tails = 0;
  const sandbox = new FakeSandbox((command): FakeReply | undefined => {
    if (command.includes("agency eval run --help")) {
      return { output: shape.help ?? HELP };
    }
    if (command.startsWith(`test -f ${EXIT_FILE}`)) {
      return { exitCode: shape.hangs === true ? 1 : 0 };
    }
    if (command.startsWith(`cat ${EXIT_FILE}`)) {
      return { output: shape.exit ?? "0" };
    }
    if (command.startsWith("tail -c")) {
      tails += 1;
      return { output: shape.output?.[tails - 1] ?? "" };
    }
    if (command.startsWith("test -d /eval/out/a")) {
      return { exitCode: shape.wroteRun === false ? 1 : 0 };
    }
    return undefined;
  });
  sandbox.files["/tmp/run.tgz"] = runArchive();
  return sandbox;
}

const run = (sandbox: FakeSandbox, over: Partial<Parameters<typeof runJob>[1]> = {}) =>
  runJob(job, {
    options: readOptions(dir),
    projectDir: path.join(dir, "project"),
    exclude: ["node_modules"],
    env: { OPENROUTER_API_KEY: "sk-secret" },
    agencyTarball: path.join(dir, "agency.tgz"),
    keep: false,
    signal: new AbortController().signal,
    createSandbox: async () => sandbox,
    poll: { pollSeconds: 1, sleep: async () => {} },
    ...over,
  });

it("installs agency, uploads the project, and runs the inner command from it", async () => {
  const sandbox = sandboxFor();
  expect(await run(sandbox)).toEqual({ cameBack: true });
  expect(sandbox.commands[0]).toContain("npm install -g /tmp/agency-lang.tgz");
  expect(sandbox.files["/tmp/agency-lang.tgz"].toString()).toBe("tarball");
  expect(sandbox.background[0]).toContain("cd /eval/project && setsid --wait");
  expect(sandbox.background[0]).toContain("agency eval run --test a --out /eval/out");
});

it("names the container after the job", async () => {
  const labels: string[] = [];
  await run(sandboxFor(), {
    createSandbox: async (label) => {
      labels.push(label);
      return sandboxFor();
    },
  });
  expect(labels).toEqual(["a"]);
});

it("makes only the project copy root-only, and leaves /eval and /eval/out open", async () => {
  const sandbox = sandboxFor();
  await run(sandbox);
  const all = sandbox.commands.join("\n");
  expect(all).toContain("chmod 700 /eval/project");
  expect(all).toContain("chmod 755 /eval /eval/out");
  expect(all).not.toMatch(/chmod 700 \/eval(\s|$)/m);
});

it("leaves the excluded folders out of the upload", async () => {
  const sandbox = sandboxFor();
  await run(sandbox);
  const listing = execFileSync("tar", ["-tf", "-"], { input: sandbox.files["/tmp/project.tar"] }).toString();
  expect(listing).toContain("suite/test.json");
  expect(listing).not.toContain("node_modules");
});

it("stops with a clear message when the agency in the container lacks a flag the wrapper needs", async () => {
  const sandbox = sandboxFor({ help: HELP.replace("--grade", "") });
  expect(await run(sandbox)).toEqual({
    cameBack: false,
    problem: "the agency installed in the container is too old for agency-eval-daytona: eval run has no --grade",
  });
  expect(sandbox.background).toEqual([]);
  expect(sandbox.deleted).toBe(true);
});

it("passes the environment through a file, never on a command line", async () => {
  const sandbox = sandboxFor();
  await run(sandbox);
  expect(sandbox.commands.join("\n")).not.toContain("sk-secret");
  expect(Object.values(sandbox.files).some((file) => file.toString().includes("sk-secret"))).toBe(true);
});

it("brings the run directory back and unpacks it at the job's place", async () => {
  const sandbox = sandboxFor();
  await run(sandbox);
  expect(fs.readdirSync(job.hostRunDir).sort()).toEqual(["annotations.jsonl", "statelog.jsonl"]);
  expect(sandbox.commands.some((command) => command.includes("tar -czf /tmp/run.tgz -C /eval/out/a"))).toBe(true);
});

it("appends the inner command's output to the job's log file as it arrives", async () => {
  await run(sandboxFor({ output: ["first\n", "second\n"], hangs: false }));
  expect(fs.readFileSync(job.logFile, "utf8")).toContain("first\n");
});

it("treats exit code 2 with a run directory as a finished job: the inner run reports a failed test that way", async () => {
  expect(await run(sandboxFor({ exit: "2" }))).toEqual({ cameBack: true });
});

it("brings the run directory back when the inner command failed some other way", async () => {
  expect(await run(sandboxFor({ exit: "1" }))).toEqual({
    cameBack: true,
    problem: "the inner eval run exited with code 1",
  });
  expect(fs.existsSync(path.join(job.hostRunDir, "statelog.jsonl"))).toBe(true);
});

it("brings the run directory back when the wrapper's time limit was hit", async () => {
  expect(await run(sandboxFor({ exit: "124" }))).toEqual({
    cameBack: true,
    problem: "stopped at the wrapper's time limit (16200s); not graded",
  });
});

it("brings the run directory back after an interrupt", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await run(sandboxFor({ exit: "130" }), { signal: controller.signal })).toEqual({
    cameBack: true,
    problem: "interrupted, not graded",
  });
});

it("reports the end of the log when no run directory was written", async () => {
  const result = await run(sandboxFor({ exit: "137", wroteRun: false, output: ["boom\n"] }));
  expect(result).toEqual({ cameBack: false, problem: "no run directory came back (exit 137):\nboom" });
  expect(fs.existsSync(job.hostRunDir)).toBe(false);
});

it("reports a container that could not be set up, and still deletes it", async () => {
  const sandbox = new FakeSandbox((command) =>
    command.includes("npm install -g") ? { exitCode: 1, output: "npm ERR! network" } : undefined,
  );
  const result = await run(sandbox);
  expect(result.cameBack).toBe(false);
  expect(result.problem).toContain("npm ERR! network");
  expect(sandbox.deleted).toBe(true);
});

it("reports a container that could not be created", async () => {
  const result = await run(sandboxFor(), {
    createSandbox: async () => {
      throw new Error("quota exceeded");
    },
  });
  expect(result).toEqual({ cameBack: false, problem: "quota exceeded" });
});

it("deletes the sandbox on success, and keeps it when keep is set", async () => {
  const deleted = sandboxFor();
  await run(deleted);
  expect(deleted.deleted).toBe(true);
  const kept = sandboxFor();
  await run(kept, { keep: true });
  expect(kept.deleted).toBe(false);
});

it("refuses to write over a run directory that is already there", async () => {
  fs.mkdirSync(job.hostRunDir, { recursive: true });
  const result = await run(sandboxFor());
  expect(result.cameBack).toBe(false);
  expect(result.problem).toContain("already exists");
});
