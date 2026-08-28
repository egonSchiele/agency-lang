// The grading library for agency-agent tests. Each test's checks are a
// pytest file, graderFiles/test_outputs.py, run over the agent's workdir
// the way terminal-bench runs its verifiers. One pytest function is one
// grader score, named by dropping the `test_` prefix and turning
// underscores into dashes (`test_roundtrip_sample` is `roundtrip-sample`).
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { binary, grader, scalar, type Grader } from "agency-lang/eval";

type AgentInput = string;
export type AgentGrader = Grader<AgentInput>;

/** One check the test declares: the pytest function it maps to and whether
 *  failing it fails the run. */
export type CheckSpec = { name: string; mustPass?: boolean; weight?: number };

type CheckResult = { name: string; passed: boolean; message: string };

/** Where pytest runs. `docker` is the real thing: the eval image with the
 *  workdir and the checks mounted. `local` runs the host's python3 and is
 *  for the unit tests, which grade known solutions. */
export type PytestMode = "docker" | "local";

export function pytestMode(): PytestMode {
  return process.env.AGENCY_EVAL_PYTEST === "local" ? "local" : "docker";
}

const IMAGE = process.env.AGENCY_EVAL_IMAGE ?? "agency-eval";

/** Run a test's checks over a workdir and report each pytest function. The
 *  checks see the workdir as their cwd and `WORKDIR` in the environment. */
export function runPytest(args: {
  workdir: string;
  graderFiles: string;
  mode: PytestMode;
}): CheckResult[] {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-junit-"));
  const reportFile = path.join(reportDir, "report.xml");
  const pytest = [
    "-m",
    "pytest",
    "-q",
    "-p",
    "no:cacheprovider",
    `--junitxml=${reportFile}`,
    "--rootdir",
    args.graderFiles,
    args.graderFiles,
  ];
  const command =
    args.mode === "local"
      ? { file: "python3", argv: pytest }
      : {
          file: "docker",
          argv: [
            "run",
            "--rm",
            "-v",
            `${args.workdir}:${args.workdir}`,
            "-v",
            `${args.graderFiles}:${args.graderFiles}:ro`,
            "-v",
            `${reportDir}:${reportDir}`,
            "-w",
            args.workdir,
            "-e",
            `WORKDIR=${args.workdir}`,
            "--network",
            "none",
            IMAGE,
            "python3",
            ...pytest,
          ],
        };
  try {
    execFileSync(command.file, command.argv, {
      cwd: args.workdir,
      env: { ...process.env, WORKDIR: args.workdir },
      stdio: "pipe",
      timeout: 10 * 60 * 1000,
    });
  } catch (error) {
    // pytest exits non-zero when any check fails; the report still exists.
    if (!fs.existsSync(reportFile)) {
      throw new Error(`pytest did not run: ${error instanceof Error ? error.message : error}`);
    }
  }
  const results = parseJunit(fs.readFileSync(reportFile, "utf8"));
  fs.unlinkSync(reportFile);
  fs.rmdirSync(reportDir);
  return results;
}

/** The testcase elements of a JUnit report. A case with a failure, error,
 *  or skipped child did not pass; its message is the child's text. */
export function parseJunit(xml: string): CheckResult[] {
  const results: CheckResult[] = [];
  const casePattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(casePattern)) {
    const name = /\bname="([^"]*)"/.exec(match[1])?.[1] ?? "";
    const body = match[2] ?? "";
    const problem = /<(failure|error|skipped)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    results.push({
      name,
      passed: problem === null,
      message:
        problem === null
          ? ""
          : decodeXml(problem[2] ?? "")
              .trim()
              .slice(0, 1500),
    });
  }
  return results;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

export function checkName(pytestFunction: string): string {
  return pytestFunction.replace(/^test_/, "").replace(/_/g, "-");
}

/** One grader per declared check, over a single pytest run per workdir.
 *  A check the report does not mention scores 0 with a message saying so,
 *  so a renamed pytest function cannot pass silently. */
export function pytestChecks(checks: CheckSpec[]): AgentGrader[] {
  const runs: Record<string, CheckResult[]> = {};
  const resultsFor = (workdir: string, graderFiles: string): CheckResult[] => {
    if (runs[workdir] === undefined) {
      runs[workdir] = runPytest({ workdir, graderFiles, mode: pytestMode() });
    }
    return runs[workdir];
  };
  return checks.map((check) =>
    grader<AgentInput>(
      ({ workdir, graderFiles }) => {
        if (graderFiles === "") {
          throw new Error("pytestChecks needs a graderFiles/ directory holding test_outputs.py");
        }
        const results = resultsFor(workdir, graderFiles);
        const found = results.find((result) => checkName(result.name) === check.name);
        if (found === undefined) {
          return binary(false, `no pytest function named test_${check.name.replace(/-/g, "_")}`);
        }
        return binary(found.passed, found.passed ? "passed" : found.message);
      },
      { name: check.name, mustPass: check.mustPass ?? false, weight: check.weight ?? 1 },
    ),
  );
}

/** How much of the 100-round budget the agent used. Scores fall as rounds
 *  rise, so a brain that spends more turns for the same result shows it. */
export function roundsUsed(): AgentGrader {
  return grader<AgentInput>(
    ({ record }) => {
      const rounds = record.metrics.llmCalls;
      return scalar(1 - Math.min(rounds, 100) / 100, `${rounds} LLM calls`);
    },
    { name: "rounds-used", weight: 0.1 },
  );
}

/** Wall-clock time as a share of a 20-minute allowance. */
export function wallSeconds(): AgentGrader {
  return grader<AgentInput>(
    ({ record }) => {
      const seconds = Math.round(record.durationMs / 1000);
      return scalar(1 - Math.min(seconds, 1200) / 1200, `${seconds}s`);
    },
    { name: "wall-seconds", weight: 0.1 },
  );
}

/** The graders every test uses: its pytest checks and the two harness
 *  measures. */
export function agentGraders(checks: CheckSpec[]): AgentGrader[] {
  return [...pytestChecks(checks), roundsUsed(), wallSeconds()];
}
