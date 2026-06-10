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

export function setRuntimeConfigOverrides(
  overrides: Partial<AgencyConfig> | undefined,
): void {
  activeRuntimeConfigOverrides = overrides;
}

export function getRuntimeConfigOverrides(): Partial<AgencyConfig> | undefined {
  return activeRuntimeConfigOverrides;
}

/**
 * Apply runtime config overrides (set per-subprocess via
 * `setRuntimeConfigOverrides`) to the args used to construct a
 * `RuntimeContext`. Today only `log.*` fields and the top-level
 * `observability` flag flow into the statelog config; other
 * `AgencyConfig` fields are ignored because the runtime has its own
 * pathways for them. If a new statelog-relevant override field is added,
 * it will be picked up automatically by the shallow merge below.
 */
export function applyRuntimeConfigOverridesToContextArgs(
  args: RuntimeContextConstructorArgs,
  overrides: Partial<AgencyConfig> | undefined = activeRuntimeConfigOverrides,
): RuntimeContextConstructorArgs {
  if (!overrides) return args;

  const statelogOverrides: Partial<StatelogConfig> = {
    ...(overrides.log ?? {}),
  };
  if (overrides.observability !== undefined) {
    statelogOverrides.observability = overrides.observability;
  }

  return {
    ...args,
    statelogConfig: { ...args.statelogConfig, ...statelogOverrides },
  };
}
