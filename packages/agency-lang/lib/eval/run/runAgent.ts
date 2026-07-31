import * as fs from "fs";

import type { AgencyConfig } from "@/config.js";
import type { EvalRecord } from "@/eval/types.js";

import { agentRunPaths, makeEvalRecordExtractor, shouldExtractStatelog, type AgentRunPaths, type EvalRecordExtractor } from "./extract.js";
import { applyOverlay, compileAgent, copyFiles, filesToCopy, seedFromAgentFile, type AgentSeed } from "./seed.js";
import { limitsFromConfig, makeSubprocessRunner, type EvalInputRunner } from "./subprocess.js";

export type RunAgentOptions = {
  /** The directory for THIS run — records land in <runDir>/agent/, the agent
   *  executes in <runDir>/workdir/. A suite allocates one per input
   *  (runs/<suiteId>/inputs/<inputId>/). */
  runDir: string;
  config: AgencyConfig;
  /** The test's fixture directory; contents land at the workdir root. */
  seedFiles?: string;
  /** Optimizer candidate edits, applied last (over both seed ingredients). */
  overlayFiles?: Record<string, string>;
  /** Which files the agent contributes to the workdir. Computed from the
   *  agent's imports when omitted, which is right for a one-off run. The
   *  optimizer supplies one instead, for two reasons: the import walk is
   *  expensive and would otherwise repeat for every one of hundreds of
   *  candidate runs, and every candidate's overlay was computed against the
   *  files as they were at discovery time — recomputing mid-optimization
   *  could see a changed checkout and mis-align the overlays. */
  seed?: AgentSeed;
  /** Show the agent's stdout/stderr live in this process (default true).
   *  The optimizer sets false: it runs many agents and the interleaved
   *  output would be noise — the statelog keeps the evidence either way. */
  pipeOutput?: boolean;
  /** How the statelog becomes the eval record. Defaults to
   *  makeEvalRecordExtractor({ warnMissingValue: true }); see that factory
   *  for why the optimizer passes warnMissingValue: false. Tests pass stubs. */
  extractor?: EvalRecordExtractor;
};

/** Test seam: inject a fake in place of the subprocess fork. */
export type RunAgentDeps = { runner?: EvalInputRunner };

export type AgentRun =
  /** Ran and was recorded. `output` is a convenience copy of the record's
   *  last eval output; the full evidence lives only on disk, at
   *  <runDir>/agent/eval-record.json — the run directory is the interface
   *  anything downstream (grading, reflection) reads. */
  | { status: "success"; output: unknown; runDir: string; workdir: string }
  /** Anything else: crashed, failed to seed/compile, the extractor blew up,
   *  or the run left no record behind (a completed run always writes a
   *  statelog, so its absence is a failure too). error.txt is on disk, and
   *  a salvaged eval-record.json sits beside it when one was extractable. */
  | { status: "error"; errorMessage: string; runDir: string; workdir: string };

const MAX_LISTED_SEEDED_FILES = 50;

/**
 * Run one agent, once, and collect what happened. The level-1 atom: suites,
 * grading, and optimizing all compose over this. Never throws — every failure
 * is an error result with error.txt written.
 */
export async function runAgent(
  agentPath: string,
  node: string,
  args: Record<string, any>,
  options: RunAgentOptions,
  deps: RunAgentDeps = {},
): Promise<AgentRun> {
  return new AgentRunner(agentPath, node, args, options, deps).run();
}

/** One run's worth of state — the paths, and what got seeded — so the steps
 *  below can be plain methods instead of one long function passing locals. */
class AgentRunner {
  private readonly paths: AgentRunPaths;
  private seededFiles: string[] = [];

  constructor(
    private readonly agentPath: string,
    private readonly node: string,
    private readonly args: Record<string, any>,
    private readonly options: RunAgentOptions,
    private readonly deps: RunAgentDeps,
  ) {
    this.paths = agentRunPaths(options.runDir);
  }

  async run(): Promise<AgentRun> {
    let compiledPath: string;
    try {
      compiledPath = this.seedWorkdir();
    } catch (err) {
      return this.fail(errMessage(err));
    }

    const result = await this.execute(compiledPath);

    if (!result.ok) {
      await this.salvageRecord();
      return this.fail(this.withSeedListing(result.errorMessage));
    }

    let record: EvalRecord | undefined;
    try {
      record = await this.extractRecord(result.statelogPath);
    } catch (err) {
      return this.fail(`eval-record extraction failed: ${errMessage(err)}`);
    }
    if (record === undefined) {
      return this.fail(
        "run completed but produced no eval record: no statelog was written " +
        "(or it landed somewhere unexpected), or the extractor wrote no record file",
      );
    }
    return {
      status: "success",
      output: lastOutput(record),
      runDir: this.options.runDir,
      workdir: this.paths.workdirPath,
    };
  }

  /** Best-effort: write the salvaged eval record to disk, so a crash after
   *  useful work keeps its evidence for diagnosis. Never affects the result —
   *  an errored run scores zero regardless. */
  private async salvageRecord(): Promise<void> {
    try {
      await this.extractRecord(undefined);
    } catch (err) {
      console.warn(`salvage extraction failed for ${this.options.runDir}: ${errMessage(err)}`);
    }
  }

  /** Put every needed file in place (agent closure + test files + overlay)
   *  and compile the agent inside the workdir. Returns the compiled entry. */
  private seedWorkdir(): string {
    const base = this.options.seed ?? seedFromAgentFile(this.agentPath);
    const seed = this.options.seedFiles === undefined ? base : { ...base, filesDir: this.options.seedFiles };
    const files = filesToCopy(seed);
    copyFiles(this.paths.workdirPath, files);
    applyOverlay(this.paths.workdirPath, this.options.overlayFiles);
    this.seededFiles = Object.keys(files).sort();
    return compileAgent(this.paths.workdirPath, seed.agentRelPath, this.options.config);
  }

  /** Run the compiled agent: workdir as cwd, statelog captured under agent/. */
  private execute(compiledEntryPath: string): ReturnType<EvalInputRunner> {
    fs.mkdirSync(this.paths.agentDir, { recursive: true });
    const runner = this.deps.runner ??
      makeSubprocessRunner(this.options.pipeOutput ?? true, limitsFromConfig(this.options.config));
    return runner({
      compiledEntryPath,
      node: this.node,
      args: this.args,
      cwd: this.paths.workdirPath,
      statelogPath: this.paths.statelogPath,
    });
  }

  /** Distill the statelog into the eval record. Undefined when there is
   *  nothing to extract (no/empty statelog, or the extractor wrote no record
   *  file); throws when the extractor itself blows up — a bug in the
   *  extractor, not in the input. */
  private async extractRecord(runnerStatelogPath: string | undefined): Promise<EvalRecord | undefined> {
    const statelogPath = this.adoptStatelogFallback(runnerStatelogPath);
    if (!shouldExtractStatelog(statelogPath)) {
      return undefined;
    }
    const extractor = this.options.extractor ?? makeEvalRecordExtractor({ warnMissingValue: true });
    await extractor({ statelogPath, outPath: this.paths.evalRecordPath });
    if (!fs.existsSync(this.paths.evalRecordPath)) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(this.paths.evalRecordPath, "utf8")) as EvalRecord;
  }

  /** Some runtimes write the statelog into the workdir under a default name;
   *  adopt it at the expected location so extraction finds it. */
  private adoptStatelogFallback(runnerStatelogPath: string | undefined): string {
    const expected = this.paths.statelogPath;
    if (runnerStatelogPath !== undefined && runnerStatelogPath !== expected) {
      if (shouldExtractStatelog(runnerStatelogPath)) {
        fs.copyFileSync(runnerStatelogPath, expected);
      }
      return expected;
    }
    if (shouldExtractStatelog(expected)) {
      return expected;
    }
    const fallbackPath = `${this.paths.workdirPath}/statelog.log`;
    if (shouldExtractStatelog(fallbackPath)) {
      fs.copyFileSync(fallbackPath, expected);
    }
    return expected;
  }

  private fail(errorMessage: string): AgentRun {
    fs.mkdirSync(this.paths.agentDir, { recursive: true });
    fs.writeFileSync(this.paths.errorPath, errorMessage);
    return { status: "error", errorMessage, runDir: this.options.runDir, workdir: this.paths.workdirPath };
  }

  /** Append what the workdir contained, so "the agent read a file nobody
   *  seeded" is diagnosable from error.txt alone — and the fix differs by
   *  what kind of file is missing. */
  private withSeedListing(errorMessage: string): string {
    const listed = this.seededFiles.slice(0, MAX_LISTED_SEEDED_FILES).join(", ");
    const truncated = this.seededFiles.length > MAX_LISTED_SEEDED_FILES ? ", …" : "";
    return `${errorMessage}\n\nWorkdir was seeded with ${this.seededFiles.length} file(s): ${listed}${truncated}\n` +
      `If a data file the test needs is missing, add it to the input's "files". ` +
      `If a file the AGENT imports is missing, the closure scan missed it — that is a bug worth reporting.`;
  }
}

/** "The output" is the last recorded eval output — the same definition
 *  grading uses (gradeRun reads evalOutputs the same way). */
function lastOutput(record: EvalRecord): unknown {
  const outputs = record.evalOutputs ?? [];
  return outputs.length === 0 ? undefined : outputs[outputs.length - 1].value;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
