import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import type { AgencyConfig } from "@/config.js";
import { parseAgency } from "@/parser.js";
import type { GraphNodeDefinition } from "@/types.js";
import type { LLMMock } from "@/runtime/deterministicClient.js";

import { executeNodeAsync, type InterruptHandler } from "./util.js";

export type AgencyAgentLimits = {
  wallClockMs?: number;
  memoryBytes?: number;
  stdoutBytes?: number;
  ipcPayloadBytes?: number;
};

export type AgencyAgentPolicy = {
  allowedTools?: string[];
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
  policy?: AgencyAgentPolicy;
  interruptHandlers?: InterruptHandler[];
  llmMocks?: LLMMock[];
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
  validatePolicy(args.policy);
  validateLimits(args.limits);
  const agencyFile = resolveAgencyAgentPath(args.agent, args.cwd);
  const node = findNode(agencyFile, args.node, args.config);
  if (args.scratchDir) fs.mkdirSync(args.scratchDir, { recursive: true });

  const result = await (deps.executeNodeAsync ?? executeNodeAsync)({
    config: configWithStatelog(args.config, args.statelogPath),
    agencyFile,
    nodeName: args.node,
    hasArgs: node.parameters.length > 0,
    argsString: argsStringForNode(node, args.args),
    interruptHandlers: args.interruptHandlers,
    timeoutMs: args.limits?.wallClockMs,
    maxBufferBytes: args.limits?.stdoutBytes,
    llmMocks: args.llmMocks,
    useTestLLMProvider: args.useTestLLMProvider,
    argv: args.argv,
    scratchDir: args.scratchDir,
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

  if (!agent.includes("/") && !agent.includes(path.sep)) {
    const bundled = path.join(bundledAgentsDir, agent);
    if (fs.existsSync(bundled)) return bundled;
  }

  throw new Error(`Agency agent not found: ${agent}`);
}

function validatePolicy(policy?: AgencyAgentPolicy): void {
  if (policy?.allowedTools && policy.allowedTools.length > 0) {
    throw new Error("runAgencyAgent policy.allowedTools is not supported yet");
  }
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
  if (node.parameters.length === 0) {
    if (Object.keys(args).length > 0) {
      throw new Error(`Node ${node.nodeName} does not take arguments`);
    }
    return "";
  }
  return node.parameters
    .map((param) => serializeArg(args, param.name, node.nodeName))
    .join(", ");
}

function serializeArg(
  args: Record<string, unknown>,
  name: string,
  nodeName: string,
): string {
  if (!Object.prototype.hasOwnProperty.call(args, name)) {
    throw new Error(`Missing argument "${name}" for node ${nodeName}`);
  }
  const value = args[name];
  return value === undefined ? "undefined" : JSON.stringify(value);
}
