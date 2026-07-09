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
 * Apply runtime config overrides — a `Partial<AgencyConfig>` — onto the args
 * used to construct a `RuntimeContext`. This is THE single runtime merge; it
 * serves two transports:
 *   • subprocess IPC: the parent forwards `configOverrides` in the spawn
 *     message (`setRuntimeConfigOverrides` sets the active value).
 *   • bundled agents / packed bundles: `AGENCY_CONFIG_OVERRIDES` in the env
 *     (`config.ts` `readConfigOverrides`), passed explicitly by the caller.
 *
 * Fields honored (others are ignored — the runtime has its own pathways):
 *   • `log.*` + `observability` → statelogConfig
 *   • `trace` / `traceFile` / `traceDir` → traceConfig. An override always
 *     wins over the baked traceConfig: a supplied `traceDir` clears any baked
 *     `traceFile` (which `resolveTraceFilePath` would otherwise prefer), so a
 *     per-run `--trace` dir actually takes effect.
 *   • `client.providerModules` → merged with baked modules (subprocess loads
 *     the same custom/local providers; de-duped at load time).
 *   • `maxCallDepth` → inherit the parent's runaway-recursion ceiling.
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

  if (overrides.traceFile || overrides.traceDir) {
    merged.traceConfig = {
      ...(args.traceConfig ?? {}),
      // Override wins over baked. An explicit file sets traceFile; a dir-only
      // override clears any baked traceFile so the dir is honored (see above).
      ...(overrides.traceFile
        ? { traceFile: overrides.traceFile }
        : { traceFile: undefined, traceDir: overrides.traceDir }),
    };
  }

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
