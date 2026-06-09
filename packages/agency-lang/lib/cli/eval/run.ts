import * as fs from "fs";
import * as path from "path";
import { fork } from "child_process";

import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { compile } from "@/cli/commands.js";
import { parseTarget } from "@/cli/util.js";
import { RunStrategy } from "@/importStrategy.js";
import { extractEvalRecord } from "@/eval/extract.js";
import { readAllEvents } from "@/eval/parseJsonl.js";
import type { EvalRunCompiledAgent, EvalRunResult, EvalRunTask, EvalRunTaskResult } from "@/eval/runTypes.js";
import {
  initializeEvalRun,
  prepareEvalRunTask,
  recordEvalRunTaskError,
  recordEvalRunTaskSuccess,
  shouldExtractStatelog,
  writeEvalRunSummary,
  type EvalRunState,
  type PreparedEvalRunTask,
} from "@/eval/runArtifacts.js";
import { loadTasks, taskFromGoal } from "@/eval/loadTasks.js";
import { buildForkOptions, buildRunInstruction, subprocessBootstrapPath } from "@/runtime/ipc.js";

export type EvalRunCliOptions = {
  agent: string;
  tasks?: string;
  goal?: string;
  runId?: string;
  runsDir?: string;
  continueOnError?: boolean;
  verbose?: boolean;
  config?: AgencyConfig;
};

export type EvalRunCliDependencies = {
  now(): Date;
  makeId(): string;
  compileAgent(args: { config: AgencyConfig; agentFile: string }): Promise<EvalRunCompiledAgent>;
  runTask(args: { compiled: EvalRunCompiledAgent; node: string; args: Record<string, any>; cwd: string; statelogPath: string }): Promise<{ ok: true } | { ok: false; errorMessage: string }>;
  extract(args: { statelogPath: string; outPath: string; task: EvalRunTask }): Promise<void>;
};

export type ExecuteEvalRunTaskArgs = {
  state: EvalRunState;
  task: EvalRunTask;
  compiled: EvalRunCompiledAgent;
  defaultNode: string;
  runTask: EvalRunCliDependencies["runTask"];
  extract: EvalRunCliDependencies["extract"];
};

export function resolveEvalRunTarget(target: string): { agentFile: string; node: string; label: string } {
  const parsed = parseTarget(target);
  const resolved = path.resolve(parsed.filename);
  const agentFile = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? path.join(resolved, "main.agency")
    : resolved;
  const node = parsed.nodeName || "main";
  return { agentFile, node, label: `${agentFile}:${node}` };
}

export function validateTaskSelection(opts: { tasks?: string; goal?: string }): "tasks" | "goal" {
  const count = (opts.tasks ? 1 : 0) + (opts.goal ? 1 : 0);
  if (count !== 1) {
    throw new Error("Provide exactly one of --tasks or --goal");
  }
  return opts.goal ? "goal" : "tasks";
}

export async function evalRun(
  opts: EvalRunCliOptions,
  deps: EvalRunCliDependencies = defaultEvalRunDependencies,
): Promise<EvalRunResult> {
  const target = resolveEvalRunTarget(opts.agent);
  const taskSelection = validateTaskSelection(opts);
  const tasks = taskSelection === "goal"
    ? [taskFromGoal(opts.goal ?? "", deps.makeId)]
    : loadTasks(path.resolve(opts.tasks ?? ""), deps.makeId);
  const runsDir = path.resolve(opts.runsDir ?? opts.config?.eval?.runsDir ?? "runs");
  const runId = opts.runId ?? deps.makeId();
  const continueOnError = opts.continueOnError !== false;
  const compiled = await deps.compileAgent({ config: opts.config ?? {}, agentFile: target.agentFile });
  const state = initializeEvalRun({
    runId,
    runsDir,
    agent: target.label,
    tasksSource: taskSelection === "goal" ? "inline:--goal" : path.resolve(opts.tasks ?? ""),
    tasks,
    continueOnError,
    startedAt: deps.now(),
  });
  const results: EvalRunTaskResult[] = [];
  for (const task of tasks) {
    const taskResult = await executeEvalRunTask({
      state,
      task,
      compiled,
      defaultNode: target.node,
      runTask: deps.runTask,
      extract: deps.extract,
    });
    results.push(taskResult);
    if (taskResult.status === "error" && !continueOnError) break;
  }
  return writeEvalRunSummary(state, results);
}

export async function executeEvalRunTask(args: ExecuteEvalRunTaskArgs): Promise<EvalRunTaskResult> {
  let prepared: PreparedEvalRunTask;
  try {
    prepared = prepareEvalRunTask(args.state, args.task);
  } catch (err) {
    return recordEvalRunTaskError(args.task, (err as Error).message);
  }
  const runResult = await args.runTask({
    compiled: args.compiled,
    node: args.task.node ?? args.defaultNode,
    args: args.task.args,
    cwd: prepared.workdirPath,
    statelogPath: prepared.statelogPath,
  });
  if (!runResult.ok) {
    return recordEvalRunTaskError(prepared, runResult.errorMessage);
  }
  if (shouldExtractStatelog(prepared.statelogPath)) {
    try {
      await args.extract({ statelogPath: prepared.statelogPath, outPath: prepared.evalRecordPath, task: args.task });
    } catch (err) {
      return recordEvalRunTaskError(prepared, (err as Error).message);
    }
  }
  return recordEvalRunTaskSuccess(prepared);
}

const defaultEvalRunDependencies: EvalRunCliDependencies = {
  now: () => new Date(),
  makeId: () => nanoid(),
  async compileAgent({ config, agentFile }) {
    const compiledPath = compile(config, agentFile, undefined, { importStrategy: new RunStrategy() });
    if (compiledPath === null) throw new Error(`Failed to compile ${agentFile}`);
    return { moduleId: path.basename(compiledPath, ".js"), path: compiledPath };
  },
  async runTask({ compiled, node, args, cwd, statelogPath }) {
    if (!compiled.path) throw new Error("Compiled agent has no path");
    return runCompiledAgent({ compiledPath: compiled.path, node, args, cwd, statelogPath });
  },
  async extract({ statelogPath, outPath }) {
    const events = await readAllEvents(statelogPath);
    const record = extractEvalRecord(events, statelogPath);
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
  },
};

async function runCompiledAgent(args: {
  compiledPath: string;
  node: string;
  args: Record<string, any>;
  cwd: string;
  statelogPath: string;
}): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  const limits = { wallClock: 60_000, memory: 512 * 1024 * 1024, ipcPayload: 100 * 1024 * 1024, stdout: 1024 * 1024 };
  const child = fork(subprocessBootstrapPath, [], buildForkOptions({ limits, cwd: args.cwd }));
  const instruction = buildRunInstruction({
    scriptPath: args.compiledPath,
    node: args.node,
    args: args.args,
    limits,
    configOverrides: { observability: true, log: { logFile: args.statelogPath } },
  });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: { ok: true } | { ok: false; errorMessage: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.on("message", (msg: any) => {
      if (msg?.type === "result") settle({ ok: true });
      if (msg?.type === "error") settle({ ok: false, errorMessage: String(msg.error) });
      if (msg?.type === "interrupt") child.send({ type: "decision", interruptId: msg.interruptId, approved: true, value: undefined });
    });
    child.on("error", (err) => settle({ ok: false, errorMessage: err.message }));
    child.on("close", (code, signal) => {
      if (code === 0 && !settled) settle({ ok: true });
      if (!settled) settle({ ok: false, errorMessage: `Subprocess exited with code ${code}${signal ? ` signal ${signal}` : ""}` });
    });
    child.send(instruction);
  });
}
