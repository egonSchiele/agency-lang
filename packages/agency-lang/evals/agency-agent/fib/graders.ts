import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { BaseGrader } from "agency-lang/eval";
import type { Grade, GraderInput } from "agency-lang/eval";

/** The harness the grader runs, declared relative to this module. The same
 *  files are seeded into the agent's workdir (they live under files/), so
 *  the agent can check its own work with `agency test`. */
const HARNESS_FILES = ["files/fib-harness.agency", "files/fib-harness.test.json"];

/**
 * Runs the shipped agency-test harness against the agent-written fib.agency.
 *
 * Why this is safe to run on a local machine: the harness compiles the
 * solution with std::agency, which allows only std:: imports, and runs it in
 * the sandboxed subprocess, where the harness's handler rejects every effect
 * the code raises (a solution's own `with approve` cannot outvote it — every
 * handler up the chain gets a veto). Verified against inline-approved
 * writes, static-initializer writes, and a child_process import.
 *
 * Tamper defense: the harness is copied fresh from the graders snapshot into
 * a clean scratch directory, and only fib.agency is taken from the agent's
 * workdir — so edits the agent makes to its seeded harness copy change
 * nothing about grading.
 */
class FibHarnessGrader extends BaseGrader {
  protected readonly defaultName = "agency-tests";
  private bound: Record<string, string> = {};

  override externalFiles(): string[] {
    return HARNESS_FILES;
  }
  override rebindExternalFile(from: string, to: string): void {
    this.bound[from] = to;
  }

  /** Snapshot grading rebinds each declared path to the stored copy; live
   *  grading resolves it against this module's directory (the grading bundle
   *  is imported from there). */
  private harnessPath(declared: string): string {
    return this.bound[declared] ?? path.resolve(moduleDir(), declared);
  }

  protected async _run({ run }: GraderInput): Promise<Grade> {
    const solution = path.join(run.workdir, "fib.agency");
    if (run.workdir === "" || !fs.existsSync(solution)) {
      return fail("the run left no fib.agency in its workdir");
    }
    // The scratch dir lives under the grading cwd, not os.tmpdir(): compiled
    // Agency resolves agency-lang from the directory it runs in.
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".fib-grade-"));
    try {
      fs.copyFileSync(solution, path.join(dir, "fib.agency"));
      for (const declared of HARNESS_FILES) {
        fs.copyFileSync(this.harnessPath(declared), path.join(dir, path.basename(declared)));
      }
      try {
        execFileSync(process.execPath, [agencyCli(), "test", "fib-harness.test.json"], {
          cwd: dir,
          stdio: "pipe",
          timeout: 5 * 60 * 1000,
        });
        return { score: { kind: "binary", pass: true } };
      } catch (error) {
        return fail(testOutput(error));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function moduleDir(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}

/** Grading always runs inside the agency CLI (`agency eval grade`), so the
 *  running script is the CLI entry point. */
function agencyCli(): string {
  return process.argv[1];
}

function fail(feedback: string): Grade {
  return { score: { kind: "binary", pass: false }, feedback };
}

/** The tail of the failed test run's output, ANSI stripped — it carries the
 *  harness's exact-match diff ("fib(2) returned 2, expected 1"). */
function testOutput(error: unknown): string {
  const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  const text = [e.stdout, e.stderr]
    .map((part) => (part === undefined ? "" : part.toString()))
    .join("\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
  if (text === "") return e.message ?? String(error);
  return text.length > 2000 ? `…${text.slice(-2000)}` : text;
}

export default [new FibHarnessGrader({ mustPass: true })];
