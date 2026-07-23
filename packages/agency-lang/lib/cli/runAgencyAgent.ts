import { declaredName } from "../types/hole.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import type { AgencyConfig } from "@/config.js";
import { parseAgency } from "@/parser.js";
import type { GraphNodeDefinition } from "@/types.js";
import type { LLMMock, ScopedLLMMocks } from "@/runtime/deterministicClient.js";

import { executeNodeAsync } from "./util.js";

export type AgencyAgentLimits = {
  wallClockMs?: number;
  memoryBytes?: number;
  stdoutBytes?: number;
  ipcPayloadBytes?: number;
};

export type RunAgencyAgentArgs = {
  agent: string;
  node: string;
  args: Record<string, unknown>;
  config: AgencyConfig;
  cwd?: string;
  scratchDir?: string;
  statelogPath?: string;
  limits?: AgencyAgentLimits;
  llmMocks?: LLMMock[] | ScopedLLMMocks;
  useTestLLMProvider?: boolean;
  argv?: string[];
};

export type RunAgencyAgentResult = {
  data: unknown;
  stdout: string;
  stderr: string;
  statelogPath?: string;
};

export type RunAgencyAgentDeps = {
  executeNodeAsync?: typeof executeNodeAsync;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const bundledAgentsDir = path.resolve(currentDir, "../agents");

export async function runAgencyAgent(
  args: RunAgencyAgentArgs,
  deps: RunAgencyAgentDeps = {},
): Promise<RunAgencyAgentResult> {
  validateLimits(args.limits);
  const agencyFile = resolveAgencyAgentPath(args.agent, args.cwd);
  const scratchDir = args.scratchDir ?? defaultScratchDirForAgent(agencyFile);
  const node = findNode(agencyFile, args.node, args.config);
  if (scratchDir) fs.mkdirSync(scratchDir, { recursive: true });

  const result = await (deps.executeNodeAsync ?? executeNodeAsync)({
    config: configWithStatelog(args.config, args.statelogPath),
    agencyFile,
    nodeName: args.node,
    hasArgs: node.parameters.length > 0,
    argsString: argsStringForNode(node, args.args),
    timeoutMs: args.limits?.wallClockMs,
    maxBufferBytes: args.limits?.stdoutBytes,
    llmMocks: args.llmMocks,
    useTestLLMProvider: args.useTestLLMProvider,
    argv: args.argv,
    scratchDir,
    // Builtin-agent compiles are ephemeral implementation details; their
    // progress lines only clutter the caller's log.
    quietCompile: true,
  });

  return {
    data: result.data,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(args.statelogPath ? { statelogPath: args.statelogPath } : {}),
  };
}

export function resolveAgencyAgentPath(agent: string, cwd = process.cwd()): string {
  const candidate = path.resolve(cwd, agent);
  if (fs.existsSync(candidate)) return candidate;

  // Bundled lookup: a bare name ("foo.agency") or a relative subpath
  // ("eval/goalJudge.agency") under the bundled agents dir. Absolute paths and
  // `..` traversal are excluded so a bundled name can never escape that dir.
  const segments = agent.split(/[\\/]/);
  if (!path.isAbsolute(agent) && !segments.includes("..")) {
    const bundled = path.join(bundledAgentsDir, agent);
    if (fs.existsSync(bundled)) return bundled;
  }

  throw new Error(`Agency agent not found: ${agent}`);
}

function validateLimits(limits?: AgencyAgentLimits): void {
  if (!limits) return;
  if (limits.memoryBytes !== undefined) {
    throw new Error("runAgencyAgent limits.memoryBytes is not supported by this runner yet");
  }
  if (limits.ipcPayloadBytes !== undefined) {
    throw new Error("runAgencyAgent limits.ipcPayloadBytes is not supported by this runner yet");
  }
}

function defaultScratchDirForAgent(agencyFile: string): string | undefined {
  const relative = path.relative(bundledAgentsDir, agencyFile);
  const isBundled = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  return isBundled ? fs.mkdtempSync(path.join(os.tmpdir(), "agency-agent-")) : undefined;
}

function configWithStatelog(
  config: AgencyConfig,
  statelogPath: string | undefined,
): AgencyConfig {
  if (!statelogPath) return config;
  return {
    ...config,
    observability: true,
    log: { ...config.log, logFile: statelogPath },
  };
}

function findNode(
  agencyFile: string,
  nodeName: string,
  config: AgencyConfig,
): GraphNodeDefinition {
  const parsed = parseAgency(fs.readFileSync(agencyFile, "utf-8"), config);
  if (!parsed.success) {
    throw new Error(`Failed to parse ${agencyFile}: ${parsed.message}`);
  }
  const node = parsed.result.nodes.find(
    (candidate): candidate is GraphNodeDefinition =>
      candidate.type === "graphNode" && candidate.nodeName === nodeName,
  );
  if (!node) throw new Error(`Node "${nodeName}" not found in ${agencyFile}`);
  return node;
}

function argsStringForNode(
  node: GraphNodeDefinition,
  args: Record<string, unknown>,
): string {
  const parameterNames = node.parameters.map((param) => param.name);
  for (const name of Object.keys(args)) {
    if (!parameterNames.includes(name)) {
      throw new Error(`Unknown argument "${name}" for node ${declaredName(node.nodeName)}`);
    }
  }
  if (node.parameters.length === 0) {
    if (Object.keys(args).length > 0) {
      throw new Error(`Node ${declaredName(node.nodeName)} does not take arguments`);
    }
    return "";
  }
  const lastProvidedIndex = node.parameters.reduce(
    (last, param, index) => Object.prototype.hasOwnProperty.call(args, param.name) ? index : last,
    -1,
  );
  const lastRequiredIndex = node.parameters.reduce(
    (last, param, index) => param.defaultValue ? last : index,
    -1,
  );
  return node.parameters
    .slice(0, Math.max(lastProvidedIndex, lastRequiredIndex) + 1)
    .map((param) => serializeArg(args, param, declaredName(node.nodeName)))
    .join(", ");
}

function serializeArg(
  args: Record<string, unknown>,
  param: GraphNodeDefinition["parameters"][number],
  nodeName: string,
): string {
  if (!Object.prototype.hasOwnProperty.call(args, param.name)) {
    if (param.defaultValue) return "undefined";
    throw new Error(`Missing argument "${param.name}" for node ${nodeName}`);
  }
  const value = args[param.name];
  return value === undefined ? "undefined" : JSON.stringify(value);
}
