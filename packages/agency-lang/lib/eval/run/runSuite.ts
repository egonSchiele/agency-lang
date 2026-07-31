import { execFileSync } from "child_process";
import * as path from "path";

import { nanoid } from "nanoid";

import { assertEvalEntryNodeTakesOneParameter, resolveEvalTarget, type EvalTarget } from "@/agentTarget.js";
import { ttyColor } from "@/utils/termcolors.js";

import { makeStatelogCostTailer } from "./costTail.js";
import { formatElapsed, startStatusBoard } from "./statusBoard.js";
import type { AgencyConfig } from "@/config.js";
import {
  buildProvenance,
  initializeEvalRun,
  prepareInput,
  recordInputPrepareFailure,
  writeEvalRunSummary,
  type EvalRunProvenance,
  type PreparedInput,
  type SourceProvenance,
} from "@/eval/runArtifacts.js";
import type { EvalRunInputResult, EvalRunResult, Input } from "@/eval/runTypes.js";

import { runAgent, type AgentRun, type RunAgentOptions } from "./runAgent.js";
import { seedFromAgentFile } from "./seed.js";
import type { EvalInputRunner } from "./subprocess.js";

/** Per-run knobs forwarded verbatim to every runAgent call in the suite.
 *  Pick, not re-declaration: the compiler keeps this in sync with
 *  RunAgentOptions. NOTE the omission semantics shift at suite level: with
 *  `seed` omitted, runSuite computes ONE closure walk for the whole suite and
 *  passes it to every run — never one walk per input (RunAgentOptions.seed's
 *  own doc describes the single-run case). */
export type PerRunOptions = Pick<RunAgentOptions, "seed" | "overlayFiles" | "pipeOutput" | "extractor">;

/** Options for running a LOADED suite: parsed Input[], resolved values.
 *  The raw-flags side lives in the evalRun command (EvalRunCliOptions). */
export type RunSuiteOptions = {
  /** The agent. A string is file-target convenience (path, path:node, or a
   *  directory meaning main.agency) and is resolved here; a resolved
   *  EvalTarget passes through with no re-validation — it already passed
   *  resolveEvalTarget, including the {task}-placeholder check. */
  agent: string | EvalTarget;
  inputs: Input[];
  runId?: string;
  runsDir?: string;
  /** Default true. */
  continueOnError?: boolean;
  config?: AgencyConfig;
  /** Worker-pool size for input scheduling; 1 (default) = sequential with
   *  piped agent output, >1 = parallel with a status board instead. */
  parallel?: number;
  /** Source provenance recorded in config.json; "unspecified" when omitted. */
  provenance?: { inputsSource: SourceProvenance; files: Record<string, SourceProvenance> };
  perRun?: PerRunOptions;
};

/** Test seam, same pattern as RunAgentDeps. */
export type RunSuiteDeps = { runner?: EvalInputRunner };

/**
 * Run an agent against a loaded input suite and write the run directory:
 * per-input artifacts, provenance, summary. Executes only — grading reads
 * the finished directory separately (docs/dev/eval-grading.md).
 */
export async function runSuite(opts: RunSuiteOptions, deps: RunSuiteDeps = {}): Promise<EvalRunResult> {
  const target: EvalTarget = typeof opts.agent === "string"
    ? resolveEvalTarget({ agent: opts.agent })
    : opts.agent;
  if (target.kind === "file") {
    // Before any workdir is seeded or agent compiled: a mis-shaped entry
    // node is a configuration error, not a per-input run failure. The
    // command analog (the {task}-placeholder check) ran at resolution.
    assertEvalEntryNodeTakesOneParameter(target.agentFile, target.node);
  }

  const runsDir = path.resolve(
    opts.runsDir ?? opts.config?.eval?.runsDir ?? "runs",
  );
  const runId = opts.runId ?? defaultRunId();
  const continueOnError = opts.continueOnError ?? true;
  const config = opts.config ?? {};
  const perRun = opts.perRun ?? {};

  // One closure walk per suite; never per input. Command targets have no
  // closure and nothing to compile.
  const defaultSeed = target.kind === "file"
    ? (perRun.seed ?? seedFromAgentFile(target.agentFile))
    : undefined;

  const provenance: EvalRunProvenance = buildProvenance({
    inputsSource: opts.provenance?.inputsSource ?? { source: "unspecified" },
    files: opts.provenance?.files ?? {},
    agent: defaultSeed !== undefined
      ? { kind: "file", seed: defaultSeed }
      : { kind: "command", command: target.label, cliVersion: commandCliVersion((target as { tokens: string[] }).tokens) },
  });

  const state = initializeEvalRun({
    runId,
    runsDir,
    agentLabel: target.label,
    inputs: opts.inputs,
    continueOnError,
    startedAt: new Date(),
    provenance,
  });
  // Up front, not just at the end: a long run's evidence (statelogs, the
  // live `eval logs -f` view) lives here while it is still running.
  console.error(`run dir: ${state.runDir}`);

  // Ctrl-C mid-suite must still produce a run directory the toolchain can
  // read: the in-flight input finishes as an error result (the runner kills
  // its child; runAgent's error path salvages an eval record and writes
  // error.txt), the loop stops, and the summary below is written as normal.
  // `once`, so a second Ctrl-C gets default handling — immediate death.
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    console.warn(
      "\neval run interrupted — salvaging the in-flight input and writing a " +
      "partial summary; press Ctrl-C again to force quit",
    );
  };
  process.once("SIGINT", onSigint);

  const parallel = Math.max(1, Math.floor(opts.parallel ?? 1));

  // One input, executed and recorded — shared by both scheduling modes.
  // Prepare failures become error results, not throws. `onPrepared` fires
  // before the agent starts, so the pool can begin tailing the statelog
  // while the run is live.
  const executeInput = async (
    input: Input,
    pipeOutput: boolean,
    onPrepared?: (prepared: PreparedInput) => void,
  ): Promise<{ result: EvalRunInputResult; prepared?: PreparedInput }> => {
    let prepared: PreparedInput;
    try {
      prepared = prepareInput(state, input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runSuite] prepare failed for input ${input.id ?? ""}: ${message}`);
      return { result: recordInputPrepareFailure(input.id ?? "", message) };
    }
    onPrepared?.(prepared);
    const run = await runAgent(target, input.task, {
      runDir: prepared.inputDir,
      config,
      seedFiles: input.files,
      overlayFiles: perRun.overlayFiles,
      seed: defaultSeed,
      pipeOutput,
      extractor: perRun.extractor,
      timeoutSec: input.timeoutSec,
    }, { runner: deps.runner });
    return { result: toInputResult(input, prepared, run), prepared };
  };

  let results: EvalRunInputResult[] = [];
  try {
    if (parallel === 1) {
      for (const input of opts.inputs) {
        // Progress heartbeat: agents legitimately go quiet for a minute
        // inside one LLM call, and a silent terminal reads as a hang.
        // stderr, so piped agent output and result printing stay clean.
        const startedAt = Date.now();
        const inputLabel = ttyColor.green(input.id ?? "");
        const ticker = setInterval(() => {
          console.error(`[${inputLabel}] running… ${formatElapsed(Date.now() - startedAt)}`);
        }, 15_000);
        let outcome: Awaited<ReturnType<typeof executeInput>>;
        try {
          outcome = await executeInput(input, perRun.pipeOutput ?? true);
        } finally {
          clearInterval(ticker);
        }
        const status = outcome.result.status === "error" ? ttyColor.red("error") : outcome.result.status;
        console.error(`[${inputLabel}] ${status} in ${formatElapsed(Date.now() - startedAt)}`);
        results.push(outcome.result);
        if (interrupted) break;
        if (outcome.result.status === "error" && !continueOnError) break;
      }
    } else {
      results = await runPool({
        inputs: opts.inputs,
        parallel,
        continueOnError,
        isInterrupted: () => interrupted,
        executeInput,
      });
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  return writeEvalRunSummary(state, results);
}

/**
 * Parallel scheduling: a pool of workers pulls inputs in order. Agent output
 * is never piped (n interleaved streams are noise — `eval logs <dir> -f` is
 * the drill-down); a status board shows each test's state, elapsed time, and
 * cost so far (tailed from its live statelog every second). An error under
 * continueOnError=false, or an interrupt, stops SCHEDULING; in-flight runs
 * settle normally (interrupt: their forwarded SIGINT kills their trees and
 * they come back as error results). Results keep input order.
 */
async function runPool(args: {
  inputs: Input[];
  parallel: number;
  continueOnError: boolean;
  isInterrupted: () => boolean;
  executeInput: (
    input: Input,
    pipeOutput: boolean,
    onPrepared?: (prepared: PreparedInput) => void,
  ) => Promise<{ result: EvalRunInputResult; prepared?: PreparedInput }>;
}): Promise<EvalRunInputResult[]> {
  const board = startStatusBoard(args.inputs.map((input) => input.id ?? ""));
  const slots: (EvalRunInputResult | undefined)[] = new Array(args.inputs.length);
  const costTails: (() => number)[] = [];
  let nextIndex = 0;
  let stopScheduling = false;

  const costPoll = setInterval(() => {
    for (const poll of costTails) poll();
  }, 1_000);

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopScheduling || args.isInterrupted()) return;
      const index = nextIndex++;
      if (index >= args.inputs.length) return;
      const input = args.inputs[index];
      const id = input.id ?? "";
      board.update(id, { status: "running", startedAt: Date.now() });

      const outcome = await args.executeInput(input, false, (prepared) => {
        // Tail this run's statelog for the board's cost column, from run
        // start; the tail stays registered afterwards so the final cost
        // sticks.
        const tailer = makeStatelogCostTailer(prepared.statelogPath);
        costTails.push(() => {
          const total = tailer.poll();
          board.update(id, { costUsd: total });
          return total;
        });
      });
      slots[index] = outcome.result;
      board.update(id, {
        status: outcome.result.status === "error" ? "error" : "done",
        endedAt: Date.now(),
      });
      if (outcome.result.status === "error" && !args.continueOnError) {
        stopScheduling = true;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: args.parallel }, () => worker()));
  } finally {
    for (const poll of costTails) poll();
    clearInterval(costPoll);
    board.stop();
  }
  return slots.filter((entry): entry is EvalRunInputResult => entry !== undefined);
}

/** Default run id: local-time timestamp then a short random suffix, so
 *  runs/ lists in creation order. An explicit --run-id is used verbatim. */
function defaultRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${nanoid(6)}`;
}

/** Best-effort --version of the CLI a command target invokes, recorded in
 *  provenance (the command string alone cannot anchor a comparison over
 *  time). Only attempted when the command looks like the agency CLI;
 *  failures are swallowed — provenance must never fail a run. */
function commandCliVersion(tokens: string[]): string | undefined {
  const first = tokens[0] ?? "";
  const invokesAgency = path.basename(first) === "agency" ||
    first.endsWith("agency.js") ||
    (first === "node" && (tokens[1] ?? "").endsWith("agency.js"));
  if (!invokesAgency) return undefined;
  const argv = first === "node" ? [tokens[1], "--version"] : ["--version"];
  try {
    return execFileSync(first, argv, { timeout: 5_000, encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** An AgentRun in the suite's per-input vocabulary. */
function toInputResult(input: Input, prepared: PreparedInput, run: AgentRun): EvalRunInputResult {
  return {
    inputId: input.id ?? "",
    status: run.status,
    evalRecordPath: prepared.evalRecordPath,
    statelogPath: prepared.statelogPath,
    workdirPath: prepared.workdirPath,
    errorMessage: run.status === "error" ? run.errorMessage : undefined,
  };
}
