import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import type { AgencyConfig } from "@/config.js";
import { loadTasks } from "@/eval/loadTasks.js";
import { agencyImportTargets, resolveAgencyImportPath } from "@/importPaths.js";
import { optimizeLoop } from "@/optimize/loop.js";
import type { OptimizeLoopConfig, OptimizeResult } from "@/optimize/types.js";
import { parseAgency } from "@/parser.js";
import { approve } from "@/runtime/interrupts.js";
import { getRuntimeContext, runInBootstrapFrame } from "@/runtime/asyncContext.js";
import { RuntimeContext } from "@/runtime/state/context.js";

import { resolveEvalRunTarget } from "./run.js";

export type EvalOptimizeOptions = {
  agent: string;
  tasks?: string;
  goal: string;
  iterations?: number;
  judgeSamples?: number;
  acceptThreshold?: number;
  runsDir?: string;
  runId?: string;
  mutatorModel?: string;
  config?: AgencyConfig;
};

export type EvalOptimizeDeps = {
  optimizeLoop?: (config: OptimizeLoopConfig) => Promise<OptimizeResult>;
  makeId?: () => string;
  makeRunId?: () => string;
};

const DEFAULT_ITERATIONS = 5;
const DEFAULT_JUDGE_SAMPLES = 3;
const DEFAULT_ACCEPT_THRESHOLD = 0;

export async function evalOptimize(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps = {},
): Promise<OptimizeResult> {
  const config = buildOptimizeLoopConfig(opts, deps);
  const ctx = new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: opts.config?.client ?? {},
    dirname: config.target.workingDir,
  });
  return runInBootstrapFrame(ctx, async () => {
    getRuntimeContext().ctx.pushHandler(async () => approve());
    try {
      if (deps.optimizeLoop) return await deps.optimizeLoop(config);
      return await optimizeLoop(config, { report: (message) => console.error(message) });
    } finally {
      getRuntimeContext().ctx.popHandler();
    }
  }, { moduleDir: config.target.workingDir });
}

function buildOptimizeLoopConfig(
  opts: EvalOptimizeOptions,
  deps: EvalOptimizeDeps,
): OptimizeLoopConfig {
  if (!opts.tasks) throw new Error("Provide --tasks for eval optimize");
  if (!opts.goal) throw new Error("Provide --goal for eval optimize");
  const target = resolveEvalRunTarget(opts.agent);
  const tasks = loadTasks(path.resolve(opts.tasks), deps.makeId ?? nanoid);
  const agentSource = fs.readFileSync(target.agentFile, "utf-8");
  const config = opts.config ?? {};
  const workingDir = optimizeWorkingDir(target.agentFile);
  return {
    runtime: { config, tasks },
    target: {
      agentSource,
      node: target.node,
      agentFilename: relativeAgencyPath(workingDir, target.agentFile),
      workingDir,
      writebackPath: target.agentFile,
    },
    policy: {
      goal: opts.goal,
      iterations: opts.iterations ?? DEFAULT_ITERATIONS,
      judgeSamples: opts.judgeSamples ?? DEFAULT_JUDGE_SAMPLES,
      acceptThreshold: opts.acceptThreshold ?? DEFAULT_ACCEPT_THRESHOLD,
      mutatorModel: opts.mutatorModel,
    },
    artifacts: {
      runsDir: path.resolve(opts.runsDir ?? config.eval?.optimizeRunsDir ?? path.join(config.eval?.runsDir ?? "runs", "optimize")),
      runId: opts.runId ?? (deps.makeRunId ?? nanoid)(),
    },
  };
}

function optimizeWorkingDir(agentFile: string): string {
  const files = localAgencyFileClosure(agentFile);
  const importClosureDir = commonAncestor(files.map((file) => path.dirname(file)));
  const cwd = process.cwd();
  if (isInsideOrSame(importClosureDir, cwd)) return cwd;
  return importClosureDir;
}

function isInsideOrSame(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeAgencyPath(baseDir: string, absoluteFile: string): string {
  const relative = path.relative(baseDir, absoluteFile);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Optimize entry file ${absoluteFile} must be inside optimize working directory ${baseDir}`);
  }
  return relative.split(path.sep).join("/");
}

function localAgencyFileClosure(entryFile: string): string[] {
  const files: string[] = [];
  const visited: Record<string, true> = {};
  visitLocalAgencyFile(entryFile, visited, files);
  return files;
}

function visitLocalAgencyFile(
  absoluteFile: string,
  visited: Record<string, true>,
  files: string[],
): void {
  const filePath = path.resolve(absoluteFile);
  const canonicalFile = fs.realpathSync(absoluteFile);
  if (visited[canonicalFile]) return;
  visited[canonicalFile] = true;
  files.push(filePath);

  const source = fs.readFileSync(canonicalFile, "utf-8");
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success) {
    throw new Error(`Failed to parse optimize agent file ${canonicalFile}: ${parseResult.message ?? "parse error"}`);
  }

  for (const importPath of agencyImportTargets(parseResult.result, { localOnly: true })) {
    visitLocalAgencyFile(resolveAgencyImportPath(importPath, canonicalFile), visited, files);
  }
}

function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return process.cwd();
  const [first, ...rest] = paths.map((candidate) => path.resolve(candidate).split(path.sep));
  const prefix: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (rest.some((candidate) => candidate[index] !== segment)) break;
    prefix.push(segment);
  }
  const joined = prefix.join(path.sep);
  return joined === "" ? path.sep : joined;
}
