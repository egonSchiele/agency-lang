/**
 * Grades a coding test by running one harness pair against the agent's
 * workdir with `agency test --json --agency-only --reject '*'`. The score is
 * the passing fraction; the gate needs all of them. Why that command line
 * is safe to run on agent-written code: docs/dev/test-cli-sandbox.md.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { BaseGrader } from "./baseGrader.js";
import type { Grade, GraderInput } from "./types.js";
import { TestReportSchema, type TestReport } from "../../cli/testReport.js";
import { getPackageRoot } from "../../importPaths.js";
import { makeAgencyTempDir } from "../../utils/agencyTempDir.js";
import { safeDeleteDirectoryWithin } from "../../utils.js";
import { harnessSha256 } from "./harnessSnapshot.js";

const WRAPPER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DIAGNOSTIC_CHARS = 2000;
/** Dollars a harness case may spend on `llm()` unless the test says otherwise. */
export const DEFAULT_HARNESS_MAX_COST = 5;

export type AgencyTestGraderOptions = {
  /** The framework's copy of the harness pair, installed in the scratch dir
   *  as `<name>.agency` and `<name>.test.json`. */
  agencyFile: string;
  testJsonFile: string;
  name: string;
  maxCost?: number;
};

/** The CLI spawn, replaceable in unit tests. */
export type RunHarness = (args: { scratchDir: string; jsonFilename: string; maxCost: number }) => {
  stdout: string;
};

/** argv[1] inside `agency eval grade`; under vitest, the package's own CLI. */
function agencyCliPath(): string {
  const argv1 = process.argv[1] ?? "";
  if (path.basename(argv1) === "agency.js") return argv1;
  return path.join(getPackageRoot(), "dist", "scripts", "agency.js");
}

const spawnHarness: RunHarness = (args) => {
  const argv = [
    agencyCliPath(),
    "test",
    "run",
    "--json",
    "--agency-only",
    "--reject",
    "*",
    "--max-cost",
    String(args.maxCost),
    args.jsonFilename,
  ];
  try {
    const stdout = execFileSync(process.execPath, argv, {
      cwd: args.scratchDir,
      stdio: "pipe",
      timeout: WRAPPER_TIMEOUT_MS,
    });
    return { stdout: stdout.toString() };
  } catch (e) {
    // A failing case exits 1 but still prints the document.
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stdout = err.stdout === undefined ? "" : err.stdout.toString();
    if (stdout.trim() !== "") return { stdout };
    const stderr = err.stderr === undefined ? "" : err.stderr.toString();
    throw new Error(`agency test failed: ${err.message ?? String(e)}\n${stderr}`);
  }
};

export class AgencyTestGrader extends BaseGrader {
  protected readonly defaultName: string;
  private readonly opts: AgencyTestGraderOptions;
  private readonly runHarness: RunHarness;

  constructor(opts: AgencyTestGraderOptions, runHarness: RunHarness = spawnHarness) {
    super({ name: opts.name, mustPass: true, threshold: 1 });
    this.defaultName = opts.name;
    this.opts = opts;
    this.runHarness = runHarness;
    // Grades are keyed by the harness content, so a changed harness regrades.
    this.revision = `agency-tests/${opts.name}@${harnessSha256(
      fs.readFileSync(opts.agencyFile, "utf-8"),
      fs.readFileSync(opts.testJsonFile, "utf-8"),
    )}`;
  }

  protected async _run({ run }: GraderInput): Promise<Grade> {
    if (run.workdir === "" || !fs.existsSync(run.workdir)) {
      return fail("run left no workdir");
    }
    // Under .agency-tmp/, not os.tmpdir(): compiled Agency resolves
    // agency-lang from where it runs.
    const scratch = makeAgencyTempDir("test-grade");
    try {
      copyWithoutSymlinks(run.workdir, scratch);
      // Installed under the logical name (the run directory stores the pair
      // by content hash), which is the json's default sourceFile.
      const jsonFilename = `${this.opts.name}.test.json`;
      installHarnessFile(this.opts.agencyFile, path.join(scratch, `${this.opts.name}.agency`));
      installHarnessFile(this.opts.testJsonFile, path.join(scratch, jsonFilename));

      let stdout: string;
      try {
        stdout = this.runHarness({
          scratchDir: scratch,
          jsonFilename,
          maxCost: this.opts.maxCost ?? DEFAULT_HARNESS_MAX_COST,
        }).stdout;
      } catch (e) {
        return fail(diagnosticTail(e instanceof Error ? e.message : String(e)));
      }
      let report: TestReport;
      try {
        report = TestReportSchema.parse(JSON.parse(stdout));
      } catch (e) {
        return fail(
          `agency test produced no report: ${e instanceof Error ? e.message : String(e)}\n${diagnosticTail(stdout)}`,
        );
      }
      return gradeReport(report, jsonFilename);
    } finally {
      safeDeleteDirectoryWithin(process.cwd(), scratch);
    }
  }
}

/** Score one file's report: the passing fraction, 0 when the file did not
 *  run, 1 when it ran with nothing to fail. */
export function gradeReport(report: TestReport, jsonFilename: string): Grade {
  const file = report.files.find((f) => path.basename(f.file) === jsonFilename) ?? report.files[0];
  if (file === undefined) return fail("the report names no file");
  if (file.status !== "ran") {
    return fail(file.error ?? `the harness did not run (${file.status})`);
  }
  const passed = file.cases.filter((c) => c.status === "passed").length;
  const value = file.cases.length === 0 ? 1 : passed / file.cases.length;
  const failing = file.cases
    .filter((c) => c.status !== "passed")
    .map((c) => `${c.node}: ${c.feedback ?? c.status}`)
    .join("\n");
  const grade: Grade = { score: { kind: "scalar", value } };
  if (failing !== "") grade.feedback = failing;
  return grade;
}

/** Symlinks are left out, so nothing in the copy points outside it. */
function copyWithoutSymlinks(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => !fs.lstatSync(source).isSymbolicLink(),
  });
}

/** The agent may have left a file or directory at this name; replace it. */
function installHarnessFile(src: string, dest: string): void {
  fs.rmSync(dest, { force: true, recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src), { flag: "wx" });
}

function fail(feedback: string): Grade {
  return { score: { kind: "scalar", value: 0 }, feedback };
}

function diagnosticTail(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return clean.length > MAX_DIAGNOSTIC_CHARS ? `…${clean.slice(-MAX_DIAGNOSTIC_CHARS)}` : clean;
}
