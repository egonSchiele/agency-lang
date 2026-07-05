import type { SmolConfig } from "smoltalk";

import type { AgencyConfig } from "../config.js";
import type { StatelogConfig } from "../statelogClient.js";
import type { LogLevel } from "../logger.js";
import type { MemoryConfig } from "./memory/types.js";
import type { TraceConfig } from "./trace/types.js";

export type RuntimeContextConstructorArgs = {
  statelogConfig: StatelogConfig;
  smoltalkDefaults: Partial<SmolConfig>;
  maxToolResultChars?: number;
  providerModules?: string[];
  dirname: string;
  maxRestores?: number;
  maxCallDepth?: number;
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
 * `RuntimeContext`. `log.*` fields and the top-level `observability` flag flow
 * into the statelog config; `client.providerModules` and `maxCallDepth` are
 * forwarded explicitly (see below). Other `AgencyConfig` fields are ignored
 * because the runtime has its own pathways for them. If a new statelog-relevant
 * override field is added, it will be picked up automatically by the shallow
 * merge below.
 *
 * `client.providerModules` is honored: `_run` forwards the parent's
 * (absolutized) provider-module paths here so a subprocess loads the same
 * custom/local providers the parent has, regardless of how the child was
 * compiled. They are merged with any baked-in `providerModules` on `args`;
 * `loadProviderModules` de-duplicates by resolved path at load time.
 *
 * `maxCallDepth` is honored so a subprocess inherits the parent's runaway-
 * recursion ceiling rather than falling back to the default.
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

  const merged: RuntimeContextConstructorArgs = {
    ...args,
    statelogConfig: { ...args.statelogConfig, ...statelogOverrides },
  };

  const overrideModules = overrides.client?.providerModules;
  if (overrideModules && overrideModules.length > 0) {
    merged.providerModules = [
      ...(args.providerModules ?? []),
      ...overrideModules,
    ];
  }

  // Let a subprocess inherit the parent's runaway-recursion ceiling.
  if (overrides.maxCallDepth !== undefined) {
    merged.maxCallDepth = overrides.maxCallDepth;
  }

  return merged;
}
