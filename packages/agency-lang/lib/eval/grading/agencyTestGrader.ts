/**
 * The framework grader for eval agency tests: runs one harness .test.json
 * against the agent-written workdir through the shipped reject-all wrapper
 * (lib/agents/eval/agencyTestWrapper.agency), scoring the fraction of
 * passing cases with `{ mustPass: true, threshold: 1 }` so partial credit
 * feeds the objective while anything short of all-green gates.
 *
 * Tamper defense: the scratch dir starts as a wholesale copy of the
 * agent's workdir (symlinks copied AS symlinks — a followed link would
 * read the external file before the closure validator could refuse it;
 * cpSync's default dereference:false is load-bearing), then BOTH harness
 * files are overwritten from the graders snapshot. Everything the agent
 * wrote is testable input; everything that judges comes from the snapshot.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { BaseGrader } from "./baseGrader.js";
import type { Grade, GraderInput } from "./types.js";
import { parseReportEnvelope } from "./reportEnvelope.js";
import { getAgentsDir } from "../../importPaths.js";
import { safeDeleteDirectoryWithin } from "../../utils.js";

const WRAPPER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DIAGNOSTIC_CHARS = 2000;

export type AgencyTestGraderOptions = {
  /** Harness pair, declared relative to the grading module (externalFiles
   *  contract): rebound to snapshot copies when grading a run directory. */
  harnessAgency: string;
  harnessJson: string;
  name: string;
  /** Framework-owned whole-batch cost cap. Omitted = no cap. */
  maxCost?: number;
};

/** Injectable spawn seam so unit tests can stub the wrapper; the spawn
 *  tests drive the real one. */
export type RunWrapper = (args: {
  scratchDir: string;
  jsonFilename: string;
  sourceFilename: string;
  reportPath: string;
  maxCost?: number;
}) => { stdout: string };

export function wrapperPath(): string {
  return path.join(getAgentsDir(), "eval", "agencyTestWrapper.agency");
}

const spawnWrapper: RunWrapper = (args) => {
  const argv = [
    process.argv[1],
    "run",
    wrapperPath(),
    args.scratchDir,
    args.jsonFilename,
    args.sourceFilename,
    args.reportPath,
  ];
  if (args.maxCost !== undefined) argv.push(String(args.maxCost));
  try {
    const stdout = execFileSync(process.execPath, argv, {
      stdio: "pipe",
      timeout: WRAPPER_TIMEOUT_MS,
    });
    return { stdout: stdout.toString() };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const text = [err.stdout, err.stderr]
      .map((part) => (part === undefined ? "" : part.toString()))
      .join("\n");
    throw new Error(`wrapper run failed: ${err.message ?? String(e)}\n${text}`);
  }
};

export class AgencyTestGrader extends BaseGrader {
  protected readonly defaultName: string;
  private readonly opts: AgencyTestGraderOptions;
  private readonly runWrapper: RunWrapper;
  private bound: Record<string, string> = {};

  constructor(opts: AgencyTestGraderOptions, runWrapper: RunWrapper = spawnWrapper) {
    super({ name: opts.name, mustPass: true, threshold: 1 });
    this.defaultName = opts.name;
    this.opts = opts;
    this.runWrapper = runWrapper;
  }

  override externalFiles(): string[] {
    return [this.opts.harnessAgency, this.opts.harnessJson];
  }

  override rebindExternalFile(from: string, to: string): void {
    this.bound[from] = to;
  }

  /** Snapshot grading rebinds each declared path to the stored copy; live
   *  grading resolves against the grading module's directory (the bundle
   *  is imported from there). */
  private harnessPath(declared: string): string {
    return this.bound[declared] ?? path.resolve(declared);
  }

  protected async _run({ run }: GraderInput): Promise<Grade> {
    if (run.workdir === "" || !fs.existsSync(run.workdir)) {
      return fail("run left no workdir");
    }
    // Under process.cwd(), never os.tmpdir(): compiled Agency resolves
    // agency-lang from the directory it runs in.
    const scratch = fs.mkdtempSync(path.join(process.cwd(), ".agency-test-grade-"));
    const reportDir = fs.mkdtempSync(path.join(process.cwd(), ".agency-test-report-"));
    const reportPath = path.join(reportDir, "report.json");
    try {
      fs.cpSync(run.workdir, scratch, { recursive: true });
      const jsonFilename = path.basename(this.opts.harnessJson);
      const sourceFilename = path.basename(this.opts.harnessAgency);
      fs.copyFileSync(this.harnessPath(this.opts.harnessAgency), path.join(scratch, sourceFilename));
      fs.copyFileSync(this.harnessPath(this.opts.harnessJson), path.join(scratch, jsonFilename));

      let stdout = "";
      try {
        stdout = this.runWrapper({
          scratchDir: scratch,
          jsonFilename,
          // The wrapper's second gate expects the SNAPSHOT harness source by
          // name; a json declaring a different sourceFile is rejected at
          // that gate rather than widening authorization.
          sourceFilename,
          reportPath,
          ...(this.opts.maxCost !== undefined ? { maxCost: this.opts.maxCost } : {}),
        }).stdout;
      } catch (e) {
        return fail(diagnosticTail(e instanceof Error ? e.message : String(e)));
      }

      if (!fs.existsSync(reportPath)) {
        return fail(`the wrapper wrote no report\n${diagnosticTail(stdout)}`);
      }
      let envelope;
      try {
        envelope = parseReportEnvelope(fs.readFileSync(reportPath, "utf-8"));
      } catch (e) {
        return fail(
          `${e instanceof Error ? e.message : String(e)}\n${diagnosticTail(stdout)}`,
        );
      }
      if (envelope.status === "could-not-test") {
        return fail(envelope.feedback);
      }
      const cases = envelope.report.cases;
      const passed = cases.filter((c) => c.pass).length;
      const value = cases.length === 0 ? 1 : passed / cases.length;
      const failing = cases
        .filter((c) => !c.pass)
        .map((c) => `${c.node}: ${c.feedback}`)
        .join("\n");
      const grade: Grade = { score: { kind: "scalar", value } };
      if (failing !== "") grade.feedback = failing;
      return grade;
    } finally {
      safeDeleteDirectoryWithin(process.cwd(), scratch);
      safeDeleteDirectoryWithin(process.cwd(), reportDir);
    }
  }
}

function fail(feedback: string): Grade {
  return { score: { kind: "scalar", value: 0 }, feedback };
}

/** ANSI-stripped tail of diagnostic output, bounded for annotations. */
function diagnosticTail(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return clean.length > MAX_DIAGNOSTIC_CHARS
    ? `…${clean.slice(-MAX_DIAGNOSTIC_CHARS)}`
    : clean;
}
