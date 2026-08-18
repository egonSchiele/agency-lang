import * as fs from "fs";
import * as path from "path";

import type { EvalTarget } from "@/agentTarget.js";
import type { AgencyConfig } from "@/config.js";
import { extractEvalRecord } from "@/eval/extract.js";
import type { EvalRecord } from "@/eval/types.js";
import { computeCodeIdentity } from "@/runDirectory/codeIdentity.js";
import { readTraces } from "@/runDirectory/traces.js";

import { substituteInput } from "./commandLine.js";
import { agentRunPaths, hasStatelog, type AgentRunPaths } from "./extract.js";
import {
  applyOverlay,
  commandFilesToCopy,
  compileAgent,
  copyFiles,
  filesToCopy,
  seedFromAgentFile,
  type AgentSeed,
} from "./seed.js";
import { runCommandInSpawn } from "./spawnRunner.js";
import {
  costCapFromConfig,
  limitsFromConfig,
  makeSubprocessRunner,
  type EvalInputRunner,
  type EvalRunnerJob,
} from "./subprocess.js";

export type RunAgentOptions = {
  /** The staging directory for THIS run — the statelog lands in
   *  <runDir>/agent/, the agent executes in <runDir>/workdir/. A suite
   *  allocates one per test and folds it into the run directory afterwards. */
  runDir: string;
  /** The trace id the run adopts. The harness mints it so the run directory
   *  can key the workdir and the run row even when the agent never starts. */
  traceId: string;
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
  /** The test's per-test wall-clock override, in seconds. */
  timeoutSec?: number;
};

/** Test seam: inject a fake in place of the subprocess fork. */
export type RunAgentDeps = { runner?: EvalInputRunner };

/** What one run left behind, for the suite to fold into the run directory:
 *  the staged statelog (when the agent wrote one), the workdir, and the seeded
 *  agent entry (file targets) whose closure hash the trace recorded. */
export type AgentRunArtifacts = {
  runDir: string;
  workdir: string;
  statelogPath: string | null;
  seededAgentEntry: string | null;
};

export type AgentRun =
  /** Ran and left a statelog behind. `output` is the trace's last recorded
   *  eval output; the statelog is the evidence anything downstream reads. */
  | ({ status: "success"; output: unknown } & AgentRunArtifacts)
  /** Anything else: crashed, failed to seed/compile, or the run left no
   *  statelog behind (a completed run always writes one, so its absence is a
   *  failure too). */
  | ({ status: "error"; errorMessage: string } & AgentRunArtifacts);

const MAX_LISTED_SEEDED_FILES = 50;

/**
 * Run one agent, once, and collect what happened. The level-1 atom: suites,
 * grading, and optimizing all compose over this. Never throws — every failure
 * is an error result with error.txt written. Both target kinds run through
 * the same pipeline; only seeding (commands compile nothing) and execution
 * (fork vs spawn) branch — extraction, salvage, and error-writing are one
 * path.
 */
export async function runAgent(
  target: EvalTarget,
  input: string | Record<string, any> | undefined,
  options: RunAgentOptions,
  deps: RunAgentDeps = {},
): Promise<AgentRun> {
  return new AgentRunner(target, input, options, deps).run();
}

/** One run's worth of state — the paths, and what got seeded — so the steps
 *  below can be plain methods instead of one long function passing locals. */
class AgentRunner {
  private readonly paths: AgentRunPaths;
  private seededFiles: string[] = [];
  /** The seeded copy of the agent entry — the code that actually runs. */
  private seededAgentEntry: string | null = null;

  constructor(
    private readonly target: EvalTarget,
    private readonly input: string | Record<string, any> | undefined,
    private readonly options: RunAgentOptions,
    private readonly deps: RunAgentDeps,
  ) {
    this.paths = agentRunPaths(options.runDir);
  }

  async run(): Promise<AgentRun> {
    let compiledPath: string | null;
    try {
      compiledPath = this.seedWorkdir();
    } catch (err) {
      return this.fail(errMessage(err));
    }

    const result = await this.execute(compiledPath);

    if (!result.ok) {
      return this.fail(this.withSeedListing(result.errorMessage));
    }

    let record: EvalRecord | undefined;
    try {
      record = this.readRecord(result.statelogPath);
    } catch (err) {
      return this.fail(`statelog could not be read: ${errMessage(err)}`);
    }
    if (record === undefined) {
      const commandHint =
        this.target.kind === "command"
          ? " If your command passes --log, remove it — the harness sets the statelog path itself. " +
            "If the command is not an Agency CLI, it cannot produce the statelog eval requires."
          : "";
      return this.fail(
        "run completed but wrote no statelog (or it landed somewhere unexpected)." + commandHint,
      );
    }
    return { status: "success", output: lastOutput(record), ...this.artifacts() };
  }

  private artifacts(): AgentRunArtifacts {
    return {
      runDir: this.options.runDir,
      workdir: this.paths.workdirPath,
      statelogPath: hasStatelog(this.paths.statelogPath) ? this.paths.statelogPath : null,
      seededAgentEntry: this.seededAgentEntry,
    };
  }

  /** Put every needed file in place and, for file targets, compile the agent
   *  inside the workdir. Command targets seed the input's files plus the
   *  invoking cwd's config files and compile nothing (compiledPath null). */
  private seedWorkdir(): string | null {
    if (this.target.kind === "command") {
      const files = commandFilesToCopy(this.options.seedFiles);
      copyFiles(this.paths.workdirPath, files);
      applyOverlay(this.paths.workdirPath, this.options.overlayFiles);
      this.seededFiles = Object.keys(files).sort();
      return null;
    }
    const base = this.options.seed ?? seedFromAgentFile(this.target.agentFile);
    const seed =
      this.options.seedFiles === undefined ? base : { ...base, filesDir: this.options.seedFiles };
    const files = filesToCopy(seed);
    copyFiles(this.paths.workdirPath, files);
    applyOverlay(this.paths.workdirPath, this.options.overlayFiles);
    this.seededFiles = Object.keys(files).sort();
    this.seededAgentEntry = path.join(this.paths.workdirPath, seed.agentRelPath);
    return compileAgent(this.paths.workdirPath, seed.agentRelPath, this.options.config);
  }

  /** Run the agent: workdir as cwd, statelog captured under agent/. */
  private execute(compiledEntryPath: string | null): ReturnType<EvalInputRunner> {
    fs.mkdirSync(this.paths.agentDir, { recursive: true });
    let job: EvalRunnerJob;
    try {
      job = this.buildJob(compiledEntryPath);
    } catch (err) {
      return Promise.resolve({ ok: false as const, errorMessage: errMessage(err) });
    }
    return this.makeRunner()(job);
  }

  /** The runner job for this target kind. Task substitution happens here for
   *  commands (and can throw on a task too large for argv); the trace id is
   *  minted per run so two inputs never share a trace. */
  private buildJob(compiledEntryPath: string | null): EvalRunnerJob {
    const cwd = this.paths.workdirPath;
    const statelogPath = this.paths.statelogPath;
    if (this.target.kind === "command") {
      const argv = substituteInput(this.target.tokens, this.input);
      return { kind: "command", argv, traceId: this.options.traceId, cwd, statelogPath };
    }
    if (compiledEntryPath === null || this.seededAgentEntry === null) {
      throw new Error("A file target must be seeded and compiled before its job is built.");
    }
    return {
      kind: "file",
      compiledEntryPath,
      node: this.target.node,
      input: this.input,
      cwd,
      statelogPath,
      code: computeCodeIdentity(this.seededAgentEntry),
      traceId: this.options.traceId,
    };
  }

  /** The injected test runner when present; otherwise fork for file jobs,
   *  spawn for command jobs, under the config's limits and cost cap. */
  private makeRunner(): EvalInputRunner {
    if (this.deps.runner !== undefined) {
      return this.deps.runner;
    }
    const pipeOutput = this.options.pipeOutput ?? true;
    const limits = limitsFromConfig(this.options.config, this.options.timeoutSec);
    const maxCostUsd = costCapFromConfig(this.options.config);
    return (job: EvalRunnerJob) =>
      job.kind === "command"
        ? runCommandInSpawn({ ...job, pipeOutput, limits, maxCostUsd })
        : makeSubprocessRunner(pipeOutput, limits, maxCostUsd)(job);
  }

  /** The eval record for the run's trace, read from the statelog. Undefined
   *  when there is nothing to read (no/empty statelog); throws when the
   *  statelog cannot be parsed into a trace at all. */
  private readRecord(runnerStatelogPath: string | undefined): EvalRecord | undefined {
    const statelogPath = this.adoptStatelogFallback(runnerStatelogPath);
    if (!hasStatelog(statelogPath)) {
      return undefined;
    }
    const { traces } = readTraces(statelogPath);
    const trace = traces.find((entry) => entry.traceId === this.options.traceId) ?? traces[0];
    if (trace === undefined) {
      return undefined;
    }
    return extractEvalRecord(trace.events, statelogPath);
  }

  /** Some runtimes write the statelog into the workdir under a default name;
   *  adopt it at the expected location so the run directory finds it. */
  private adoptStatelogFallback(runnerStatelogPath: string | undefined): string {
    const expected = this.paths.statelogPath;
    if (runnerStatelogPath !== undefined && runnerStatelogPath !== expected) {
      if (hasStatelog(runnerStatelogPath)) {
        fs.copyFileSync(runnerStatelogPath, expected);
      }
      return expected;
    }
    if (hasStatelog(expected)) {
      return expected;
    }
    const fallbackPath = `${this.paths.workdirPath}/statelog.log`;
    if (hasStatelog(fallbackPath)) {
      fs.copyFileSync(fallbackPath, expected);
    }
    return expected;
  }

  private fail(errorMessage: string): AgentRun {
    return { status: "error", errorMessage, ...this.artifacts() };
  }

  /** Append what the workdir contained, so "the agent read a file nobody
   *  seeded" is diagnosable from error.txt alone — and the fix differs by
   *  what kind of file is missing. */
  private withSeedListing(errorMessage: string): string {
    const listed = this.seededFiles.slice(0, MAX_LISTED_SEEDED_FILES).join(", ");
    const truncated = this.seededFiles.length > MAX_LISTED_SEEDED_FILES ? ", …" : "";
    return (
      `${errorMessage}\n\nWorkdir was seeded with ${this.seededFiles.length} file(s): ${listed}${truncated}\n` +
      `If a data file the test needs is missing, add it to the input's "files". ` +
      `If a file the AGENT imports is missing, the closure scan missed it — that is a bug worth reporting.`
    );
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
