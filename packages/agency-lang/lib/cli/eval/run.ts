import * as fs from "fs";
import * as path from "path";
import { fork } from "child_process";

import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { compile } from "@/cli/commands.js";
import { parseTarget } from "@/cli/util.js";
import { RunStrategy } from "@/importStrategy.js";
import { StatelogParser } from "@/eval/statelogParser.js";
import { loadInputs, inputFromGoal } from "@/eval/loadInputs.js";
import {
  initializeEvalRun,
  writeEvalRunSummary,
} from "@/eval/runArtifacts.js";
import {
  runEvalInput,
  type EvalRecordExtractor,
  type EvalInputRunner,
} from "@/eval/runEvalInput.js";
import type {
  EvalRunCompiledAgent,
  EvalRunResult,
  Input,
  EvalRunInputResult,
} from "@/eval/runTypes.js";
import {
  buildForkOptions,
  buildRunInstruction,
  subprocessBootstrapPath,
  type RunLimits,
} from "@/runtime/ipc.js";

export type EvalRunCliOptions = {
  agent: string;
  inputs?: string;
  goal?: string;
  runId?: string;
  runsDir?: string;
  continueOnError?: boolean;
  verbose?: boolean;
  config?: AgencyConfig;
};

export type EvalRunLoadedInputsOptions = {
  agent: string;
  inputs: Input[];
  inputsSource: string;
  runId?: string;
  runsDir?: string;
  continueOnError?: boolean;
  verbose?: boolean;
  config?: AgencyConfig;
  /** Suppress compile progress lines for the agent compile. */
  quietCompile?: boolean;
  /** Pipe agent subprocess stdout/stderr through to the console. Defaults to true. */
  pipeAgentOutput?: boolean;
};

/**
 * Per-task resource limits for subprocess invocations driven by `agency eval
 * run`. Lifted out of the runner so it's obvious where to tune them and so
 * the runner body isn't cluttered with magic numbers.
 *
 * TODO: pipe these through `AgencyConfig.eval.limits` once that field exists.
 */
const DEFAULT_EVAL_RUN_LIMITS: RunLimits = {
  wallClock: 60_000,
  memory: 512 * 1024 * 1024,
  ipcPayload: 100 * 1024 * 1024,
  stdout: 1024 * 1024,
};

export function resolveEvalRunTarget(target: string): {
  agentFile: string;
  node: string;
  label: string;
} {
  const parsed = parseTarget(target);
  const resolved = path.resolve(parsed.filename);
  const agentFile =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? path.join(resolved, "main.agency")
      : resolved;
  const node = parsed.nodeName || "main";
  return { agentFile, node, label: `${agentFile}:${node}` };
}

export function validateInputSelection(opts: {
  inputs?: string;
  goal?: string;
}): "inputs" | "goal" {
  const count = (opts.inputs ? 1 : 0) + (opts.goal ? 1 : 0);
  if (count !== 1) {
    throw new Error("Provide exactly one of --inputs or --goal");
  }
  return opts.goal ? "goal" : "inputs";
}

/**
 * Run a compiled agent against an input suite and write per-input artifacts.
 *
 * The orchestration here is intentionally tiny: build the run state, loop
 * through inputs calling `runEvalInput` (the shared boundary), write a
 * summary. All per-input error handling lives inside `runEvalInput`.
 */
export async function evalRun(
  opts: EvalRunCliOptions,
  overrides: {
    runner?: EvalInputRunner;
    extractor?: EvalRecordExtractor;
  } = {},
): Promise<EvalRunResult> {
  const selection = validateInputSelection(opts);
  const inputs =
    selection === "goal"
      ? [inputFromGoal(opts.goal ?? "")]
      : loadInputs(path.resolve(opts.inputs ?? ""), nanoid);

  return evalRunLoadedInputs({
    agent: opts.agent,
    inputs,
    inputsSource:
      selection === "goal"
        ? "inline:--goal"
        : path.resolve(opts.inputs ?? ""),
    runId: opts.runId,
    runsDir: opts.runsDir,
    continueOnError: opts.continueOnError,
    verbose: opts.verbose,
    config: opts.config,
  }, overrides);
}

export async function evalRunLoadedInputs(
  opts: EvalRunLoadedInputsOptions,
  overrides: {
    runner?: EvalInputRunner;
    extractor?: EvalRecordExtractor;
  } = {},
): Promise<EvalRunResult> {
  const target = resolveEvalRunTarget(opts.agent);

  const runsDir = path.resolve(
    opts.runsDir ?? opts.config?.eval?.runsDir ?? "runs",
  );
  const runId = opts.runId ?? nanoid();
  const continueOnError = opts.continueOnError ?? true;

  const compiled = await compileAgentForEvalRun({
    config: opts.config ?? {},
    agentFile: target.agentFile,
    quiet: opts.quietCompile ?? false,
  });

  const state = initializeEvalRun({
    runId,
    runsDir,
    agent: target.label,
    inputsSource: opts.inputsSource,
    inputs: opts.inputs,
    continueOnError,
    startedAt: new Date(),
  });

  const runner = overrides.runner ?? makeSubprocessEvalInputRunner(opts.pipeAgentOutput ?? true);
  const extractor = overrides.extractor ?? defaultEvalRecordExtractor;

  const results: EvalRunInputResult[] = [];
  for (const input of opts.inputs) {
    const result = await runEvalInput({
      state,
      input,
      compiled,
      defaultNode: target.node,
      runner,
      extractor,
    });
    results.push(result);
    if (result.status === "error" && !continueOnError) break;
  }

  return writeEvalRunSummary(state, results);
}

async function compileAgentForEvalRun(args: {
  config: AgencyConfig;
  agentFile: string;
  quiet?: boolean;
}): Promise<EvalRunCompiledAgent> {
  const compiledPath = compile(args.config, args.agentFile, undefined, {
    importStrategy: new RunStrategy(),
    quiet: args.quiet,
  });
  if (compiledPath === null) {
    throw new Error(`Failed to compile ${args.agentFile}`);
  }
  return {
    moduleId: path.basename(compiledPath, ".js"),
    path: compiledPath,
  };
}

const defaultEvalRecordExtractor: EvalRecordExtractor = async ({
  statelogPath,
  outPath,
}) => {
  const record = new StatelogParser(statelogPath).evalRecord();
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
};

/**
 * Extractor for the optimizer: grades the entry node's return value (not the
 * last LLM completion) when `evalOutput()` wasn't called, and omits the
 * evalValue/evalOutput "did you forget to call…" warnings — inputs come from
 * the input spec and the graded output is the return value, so neither applies.
 */
export const optimizeEvalRecordExtractor: EvalRecordExtractor = async ({
  statelogPath,
  outPath,
}) => {
  const record = new StatelogParser(statelogPath, {
    outputFallback: "returnValue",
    warnMissingValue: false,
  }).evalRecord();
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
};

function makeSubprocessEvalInputRunner(pipeAgentOutput: boolean): EvalInputRunner {
  return async ({ compiled, node, args, cwd, statelogPath }) => {
    if (!compiled.path) {
      return { ok: false, errorMessage: "Compiled agent has no path" };
    }
    return runCompiledAgentInSubprocess({
      compiledPath: compiled.path,
      node,
      args,
      cwd,
      statelogPath,
      pipeAgentOutput,
    });
  };
}

async function runCompiledAgentInSubprocess(args: {
  compiledPath: string;
  node: string;
  args: Record<string, any>;
  cwd: string;
  statelogPath: string;
  pipeAgentOutput: boolean;
}): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  const limits = DEFAULT_EVAL_RUN_LIMITS;
  const child = fork(
    subprocessBootstrapPath,
    [],
    buildForkOptions({ limits, cwd: args.cwd }),
  );
  const instruction = buildRunInstruction({
    scriptPath: args.compiledPath,
    node: args.node,
    args: args.args,
    limits,
    configOverrides: {
      observability: true,
      log: { logFile: args.statelogPath },
    },
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      value: { ok: true } | { ok: false; errorMessage: string },
    ) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    if (args.pipeAgentOutput) {
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    }

    child.on("message", (msg: any) => {
      if (msg?.type === "result") {
        settle({ ok: true });
      } else if (msg?.type === "error") {
        settle({ ok: false, errorMessage: String(msg.error) });
      } else if (msg?.type === "interrupt") {
        child.send({
          type: "decision",
          interruptId: msg.interruptId,
          approved: true,
          value: undefined,
        });
      }
    });

    child.on("error", (err) => settle({ ok: false, errorMessage: err.message }));
    child.on("close", (code, signal) => {
      if (code === 0) {
        settle({ ok: true });
      } else {
        settle({
          ok: false,
          errorMessage: `Subprocess exited with code ${code}${signal ? ` signal ${signal}` : ""}`,
        });
      }
    });

    child.send(instruction);
  });
}
