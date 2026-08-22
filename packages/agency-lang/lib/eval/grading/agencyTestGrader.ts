/**
 * The framework grader for a harness pair: runs one `.test.json` against the
 * agent's workdir through `agency test --json --agency-only --reject '*'`,
 * scoring the fraction of passing cases with `{ mustPass: true, threshold: 1 }`
 * so partial credit feeds the objective while anything short of all-green
 * gates.
 *
 * Why that command line is the whole safety argument, in one place:
 * `--agency-only` means every effect the tested code can perform is an
 * interrupt (no TS/JS, Node built-ins, packages, splices, or symlinks in its
 * closure), and `--reject '*'` installs the root handler that rejects every
 * one of them before the entry node's body runs, winning over the code's own
 * `with approve`. `--max-cost` bounds `llm()`, which is not an interrupt.
 *
 * Tamper defense: the scratch dir is a copy of the agent's workdir with
 * symlinks left out (no link support, by rule), then BOTH harness files are
 * written over it from the framework's copy. Everything the agent wrote is
 * testable input; everything that judges comes from the framework.
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
  /** Absolute paths to the framework's copy of the pair; they are installed
   *  in the scratch dir as `<name>.agency` / `<name>.test.json`. */
  harnessAgency: string;
  harnessJson: string;
  name: string;
  maxCost?: number;
};

/** Injectable spawn seam so unit tests can stub the CLI; the spawn tests
 *  drive the real one. */
export type RunHarness = (args: { scratchDir: string; jsonFilename: string; maxCost: number }) => {
  stdout: string;
};

/** The agency CLI entry. Inside `agency eval grade` it IS argv[1]; under a
 *  test runner (vitest) argv[1] is the runner, so fall back to the package's
 *  own CLI script. */
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
    // A failing case exits 1 and still prints the document; only a missing
    // document is a spawn failure, judged by the caller.
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
    this.revision = `agency-tests/${opts.name}@${harnessSha256(
      fs.readFileSync(opts.harnessAgency, "utf-8"),
      fs.readFileSync(opts.harnessJson, "utf-8"),
    )}`;
  }

  protected async _run({ run }: GraderInput): Promise<Grade> {
    if (run.workdir === "" || !fs.existsSync(run.workdir)) {
      return fail("run left no workdir");
    }
    // Under the project's .agency-tmp/, never os.tmpdir(): compiled Agency
    // resolves agency-lang from the directory it runs in.
    const scratch = makeAgencyTempDir("test-grade");
    try {
      copyWithoutSymlinks(run.workdir, scratch);
      // The pair lands under its logical name whatever the framework's copy
      // is called (a run directory stores it by content hash): the json's
      // default sourceFile is `<name>.agency`, and that is also the name the
      // agent saw in its workdir.
      const jsonFilename = `${this.opts.name}.test.json`;
      installHarnessFile(this.opts.harnessAgency, path.join(scratch, `${this.opts.name}.agency`));
      installHarnessFile(this.opts.harnessJson, path.join(scratch, jsonFilename));

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

/** The workdir, minus symlinks: nothing in the copy can point outside it,
 *  so no code here needs to understand links. */
function copyWithoutSymlinks(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => !fs.lstatSync(source).isSymbolicLink(),
  });
}

/** The agent controls the scratch copy, so the destination may be a regular
 *  file or a directory it wrote. Remove it, then create the harness
 *  exclusively as a fresh file. */
function installHarnessFile(src: string, dest: string): void {
  fs.rmSync(dest, { force: true, recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src), { flag: "wx" });
}

function fail(feedback: string): Grade {
  return { score: { kind: "scalar", value: 0 }, feedback };
}

/** ANSI-stripped tail of diagnostic output, bounded for annotations. */
function diagnosticTail(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return clean.length > MAX_DIAGNOSTIC_CHARS ? `…${clean.slice(-MAX_DIAGNOSTIC_CHARS)}` : clean;
}
