import * as fs from "fs";
import * as path from "path";

import { sha256Text } from "@/utils/hash.js";
import { agentRunPaths } from "./run/extract.js";

import { assertEvalRunId, assertEvalInputId } from "./ids.js";
import type {
  EvalRunResult,
  EvalRunGrading,
  Input,
  EvalRunInputResult,
} from "./runTypes.js";

export type SourceProvenance = { source: string; sha?: string };
export type ClosureFileProvenance = { file: string; sha256: string };
export type AgentProvenance = { entry: string; closure: ClosureFileProvenance[] };
export type EvalRunProvenance = {
  inputsSource: SourceProvenance;
  /** Keyed by input id. Ids the loader GENERATED (nanoid, for id-less specs)
   *  are random per run — stable within this config.json, not across runs.
   *  Do not diff these keys between runs; diff the recorded sources. */
  files: Record<string, SourceProvenance>;
  agent: AgentProvenance;
};

/** The one assembler of config.json's provenance key. */
export function buildProvenance(args: {
  inputsSource: SourceProvenance;
  files: Record<string, SourceProvenance>;
  seed: { baseDir: string; agentRelPath: string; closureFiles: string[] };
}): EvalRunProvenance {
  return {
    inputsSource: args.inputsSource,
    files: args.files,
    agent: {
      entry: args.seed.agentRelPath,
      closure: args.seed.closureFiles.map((closureFile) => ({
        file: path.relative(args.seed.baseDir, closureFile),
        sha256: sha256Text(fs.readFileSync(closureFile, "utf8")),
      })),
    },
  };
}

export type EvalRunState = {
  runId: string;
  runDir: string;
  inputsDir: string;
  agentLabel: string;
  continueOnError: boolean;
};

export type PreparedInput = {
  input: Input;
  inputDir: string;
  inputJsonPath: string;
  statelogPath: string;
  evalRecordPath: string;
  workdirPath: string;
  errorPath: string;
};

export function initializeEvalRun(args: {
  runId: string;
  runsDir: string;
  agentLabel: string;
  inputs: Input[];
  continueOnError: boolean;
  startedAt: Date;
  provenance?: EvalRunProvenance;
}): EvalRunState {
  assertEvalRunId(args.runId);

  const runDir = path.resolve(args.runsDir, args.runId);
  const inputsDir = path.join(runDir, "inputs");
  if (fs.existsSync(runDir)) {
    throw new Error(
      `Run directory already exists: ${runDir}.
Choose a different --run-id or delete the existing directory.`,
    );
  }
  fs.mkdirSync(inputsDir, { recursive: true });

  writeJson(path.join(runDir, "config.json"), {
    runId: args.runId,
    agentLabel: args.agentLabel,
    inputs: args.inputs,
    continueOnError: args.continueOnError,
    startedAt: args.startedAt.toISOString(),
    provenance: args.provenance,
  });

  return {
    runId: args.runId,
    runDir,
    inputsDir,
    agentLabel: args.agentLabel,
    continueOnError: args.continueOnError,
  };
}

export function prepareInput(
  state: EvalRunState,
  input: Input,
): PreparedInput {
  const id = input.id ?? "";
  assertEvalInputId(id);

  const inputDir = path.join(state.inputsDir, id);
  const paths = agentRunPaths(inputDir);
  fs.mkdirSync(paths.agentDir, { recursive: true });
  // workdir is materialized by seeding (copy + overlay + compile); we only
  // allocate the path here.

  const prepared: PreparedInput = {
    input,
    inputDir,
    inputJsonPath: path.join(inputDir, "input.json"),
    statelogPath: paths.statelogPath,
    evalRecordPath: paths.evalRecordPath,
    workdirPath: paths.workdirPath,
    errorPath: paths.errorPath,
  };

  // Defensive cleanup so re-runs of the same input id don't see stale
  // artifacts. We use raw rmSync (not utils.safeDeleteFile) because the
  // user can point runsDir at any path — including /tmp — and
  // safeDeleteFile refuses anything outside a project root. The targets
  // here are paths *we* just constructed under the validated inputDir, so
  // the project-root containment check is the wrong safeguard.
  for (const filePath of [prepared.statelogPath, prepared.evalRecordPath, prepared.errorPath]) {
    fs.rmSync(filePath, { force: true });
  }

  writeJson(prepared.inputJsonPath, input);
  return prepared;
}

/**
 * Build an EvalRunInputResult for an input that failed before any artifacts
 * were prepared (e.g. invalid id). The result
 * carries no on-disk paths because none were allocated.
 */
export function recordInputPrepareFailure(
  inputId: string,
  errorMessage: string,
): EvalRunInputResult {
  return {
    inputId,
    status: "error",
    evalRecordPath: "",
    statelogPath: "",
    workdirPath: "",
    errorMessage,
  };
}

/**
 * Build an EvalRunInputResult for a prepared input that failed during run or
 * extract. Writes the error message to the input's error.txt for offline
 * inspection.
 */
export function recordInputRunFailure(
  prepared: PreparedInput,
  errorMessage: string,
): EvalRunInputResult {
  fs.writeFileSync(prepared.errorPath, errorMessage);
  return {
    inputId: prepared.input.id ?? "",
    status: "error",
    evalRecordPath: prepared.evalRecordPath,
    statelogPath: prepared.statelogPath,
    workdirPath: prepared.workdirPath,
    errorMessage,
  };
}

export function recordInputSuccess(
  prepared: PreparedInput,
): EvalRunInputResult {
  return {
    inputId: prepared.input.id ?? "",
    status: "success",
    evalRecordPath: prepared.evalRecordPath,
    statelogPath: prepared.statelogPath,
    workdirPath: prepared.workdirPath,
  };
}


export function writeEvalRunSummary(
  state: EvalRunState,
  inputs: EvalRunInputResult[],
): EvalRunResult {
  const summary: EvalRunResult = {
    runId: state.runId,
    runDir: state.runDir,
    agentLabel: state.agentLabel,
    inputs,
    okCount: inputs.filter((input) => input.status === "success").length,
    errorCount: inputs.filter((input) => input.status === "error").length,
  };
  writeJson(path.join(state.runDir, "summary.json"), summary);
  return summary;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

/** One more than the highest existing verifier directory (the spec's rule:
 *  a deleted number stays retired, never reused). verifier == 1. */
function nextVerifierNumber(runDir: string): number {
  const numbers = fs.readdirSync(runDir)
    .map((name) => (name === "verifier" ? 1 : Number(/^verifier-(\d+)$/.exec(name)?.[1])))
    .filter((candidate) => Number.isInteger(candidate));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

/** Write a grading pass into the run's next verifier directory. The ONLY
 *  writer of this artifact — the inline eval-run path and `eval grade` both
 *  call it, so its location and shape cannot drift between them. */
export function writeVerifierGrading(runDir: string, grading: EvalRunGrading): string {
  const verifierNumber = nextVerifierNumber(runDir);
  const verifierDir = path.join(runDir, verifierNumber === 1 ? "verifier" : `verifier-${verifierNumber}`);
  fs.mkdirSync(verifierDir, { recursive: true });
  const gradingPath = path.join(verifierDir, "grading.json");
  fs.writeFileSync(gradingPath, JSON.stringify(grading, null, 2));
  return gradingPath;
}
