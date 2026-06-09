import type { SmolConfig } from "smoltalk";

import type { AgencyConfig } from "../config.js";
import type { StatelogConfig } from "../statelogClient.js";
import type { LogLevel } from "../logger.js";
import type { MemoryConfig } from "./memory/types.js";
import type { TraceConfig } from "./trace/types.js";

export type RuntimeContextConstructorArgs = {
  statelogConfig: StatelogConfig;
  smoltalkDefaults: Partial<SmolConfig>;
  dirname: string;
  maxRestores?: number;
  traceConfig?: TraceConfig;
  verbose?: boolean;
  memory?: MemoryConfig;
  logLevel?: LogLevel;
};

let activeRuntimeConfigOverrides: Partial<AgencyConfig> | undefined;

export function setRuntimeConfigOverrides(overrides: Partial<AgencyConfig> | undefined): void {
  activeRuntimeConfigOverrides = overrides;
}

export function getRuntimeConfigOverrides(): Partial<AgencyConfig> | undefined {
  return activeRuntimeConfigOverrides;
}

export function applyRuntimeConfigOverridesToContextArgs(
  args: RuntimeContextConstructorArgs,
  overrides: Partial<AgencyConfig> | undefined = activeRuntimeConfigOverrides,
): RuntimeContextConstructorArgs {
  if (!overrides) return args;
  return {
    ...args,
    statelogConfig: {
      ...args.statelogConfig,
      ...(overrides.observability !== undefined ? { observability: overrides.observability } : {}),
      ...(overrides.log?.host !== undefined ? { host: overrides.log.host } : {}),
      ...(overrides.log?.apiKey !== undefined ? { apiKey: overrides.log.apiKey } : {}),
      ...(overrides.log?.projectId !== undefined ? { projectId: overrides.log.projectId } : {}),
      ...(overrides.log?.debugMode !== undefined ? { debugMode: overrides.log.debugMode } : {}),
      ...(overrides.log?.logFile !== undefined ? { logFile: overrides.log.logFile } : {}),
      ...(overrides.log?.requestTimeoutMs !== undefined ? { requestTimeoutMs: overrides.log.requestTimeoutMs } : {}),
      ...(overrides.log?.metadata !== undefined ? { metadata: overrides.log.metadata } : {}),
    },
  };
}
