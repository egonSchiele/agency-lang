#!/usr/bin/env node
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Command } from "commander";

import { createDaytonaSandbox } from "./daytona.js";
import type { CliArgs } from "./jobs.js";
import { main, type MainDeps } from "./main.js";
import type { WrapperOptions } from "./options.js";
import { installedAgencyDir, packInstalledAgency } from "./packAgency.js";
import { runJob } from "./runJob.js";
import { onSignals } from "./signals.js";
import type { ListedRun } from "./summary.js";
import { deleteAllSandboxes } from "./withSandbox.js";

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_RUNS_DIR = "runs";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** How to start the agency installed in the project: the same one that is
 *  packed into each container, so both read a suite the same way. */
function projectAgency(projectDir: string): string[] {
  const packageDir = installedAgencyDir(projectDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
    bin?: { agency?: string };
  };
  return [process.execPath, path.join(packageDir, manifest.bin?.agency ?? "")];
}

/** Runs the project's agency and parses the JSON it prints on its last line. */
function agencyJson(projectDir: string, args: string[]): unknown {
  const [node, script] = projectAgency(projectDir);
  const printed = execFileSync(node, [script, ...args], {
    cwd: projectDir,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
  return JSON.parse(printed.trimEnd().split("\n").pop() ?? "");
}

/** What the wrapper reads from the project's agency.json. Only that file:
 *  a local override file is not consulted. */
function agencyConfig(projectDir: string): { runsDir: string; maxBatchCostUsd?: number } {
  const file = path.join(projectDir, "agency.json");
  if (!fs.existsSync(file)) {
    return { runsDir: DEFAULT_RUNS_DIR };
  }
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as {
    eval?: { runsDir?: string; limits?: { maxBatchCostUsd?: number } };
  };
  return {
    runsDir: config.eval?.runsDir ?? DEFAULT_RUNS_DIR,
    maxBatchCostUsd: config.eval?.limits?.maxBatchCostUsd,
  };
}

function agencyTarball(projectDir: string, options: WrapperOptions): string {
  if (options.agency === "same") {
    return packInstalledAgency(projectDir, fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-daytona-")));
  }
  const tarball = path.resolve(projectDir, options.agency.tarball);
  if (!fs.existsSync(tarball)) {
    throw new Error(`eval-daytona.json names the agency tarball ${tarball}, which does not exist`);
  }
  return tarball;
}

function repeated(value: string, earlier: string[]): string[] {
  return [...earlier, value];
}

function wholeNumber(value: string): number {
  return Number(value);
}

const program = new Command()
  .name("agency-eval-daytona")
  .description(
    "Run an Agency eval suite with each test in its own Daytona container: " +
      "the project is copied in, `agency eval run --grade` runs there, and the run directory comes back.",
  )
  .argument("[agent]", "Agent .agency file inside the project (or use --agent-cmd)")
  .option("--agent-cmd <command>", "The agent as a command; {input} is replaced with each test's input")
  .requiredOption("--suite <directory>", "The suite: a directory of tests, inside the project")
  .option("--test <pattern>", "Run only tests whose id matches this glob (repeatable)", repeated, [])
  .option("--tags <tags>", "Run only tests carrying every one of these comma-separated tags (repeatable)", repeated, [])
  .option("-o, --out <dir>", "Directory to write the runs into; must not exist yet")
  .option("-n, --parallel <count>", "How many containers to run at once", wholeNumber, 1)
  .option("--trials <count>", "Run every test this many times", wholeNumber, 1)
  .option("--env <NAME=VALUE>", "Set a variable in the containers for this invocation only (repeatable)", repeated, [])
  .option("--keep", "Leave each container running afterwards, for looking inside", false)
  .action(async (agent: string | undefined, flags: Omit<CliArgs, "agent">) => {
    const projectDir = process.cwd();
    const controller = new AbortController();
    const removeHandlers = onSignals({
      onFirst: () => {
        log(
          "interrupted: starting no more jobs and bringing back the runs in flight (up to a minute); " +
            "interrupt again to delete every container now",
        );
        controller.abort();
      },
      onSecond: () => deleteAllSandboxes(log),
    });
    const deps: MainDeps = {
      projectDir,
      env: process.env,
      listTests: async (cli) =>
        agencyJson(projectDir, [
          "eval",
          "ls",
          "--json",
          "--suite",
          cli.suite,
          ...cli.test.flatMap((pattern) => ["--test", pattern]),
          ...cli.tags.flatMap((tags) => ["--tags", tags]),
        ]) as { id: string; timeoutSec?: number }[],
      listRuns: (runDir) => agencyJson(projectDir, ["runs", "list", "--json", runDir]) as ListedRun[],
      agencyConfig: () => agencyConfig(projectDir),
      agencyTarball: (options) => agencyTarball(projectDir, options),
      runJob: (job, args) =>
        runJob(job, {
          ...args,
          createSandbox: (label) =>
            createDaytonaSandbox({
              image: args.options.image,
              cpu: args.options.cpu,
              memoryGb: args.options.memory,
              diskGb: args.options.disk,
              labels: { tool: "agency-eval-daytona", job: label },
            }),
        }),
      signal: controller.signal,
      log,
    };
    try {
      process.exitCode = await main({ ...flags, agent }, deps);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      removeHandlers();
    }
  });

await program.parseAsync();
