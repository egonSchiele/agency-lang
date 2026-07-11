import { createRequire } from "node:module";
import { McpManager } from "./mcpManager.js";
import { mcpToolToAgencyFunction } from "./toolAdapter.js";
import { readMcpConfig } from "./configReader.js";
import type { McpServerConfig, McpTool } from "./types.js";
import { success, failure, registerGlobalHook, type ResultValue } from "agency-lang/runtime";

let singleton: McpManager | null = null;
let cleanupRegistered = false;
let registeredCallback: ((data: any) => void | Promise<void>) | undefined;

export type McpRawOptions = {
  config?: Record<string, McpServerConfig>;
  onOAuthRequired?: (data: any) => void | Promise<void>;
};

export type McpRawResult = {
  tools: McpTool[];
  callTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
};

function getManager(
  onOAuthRequired?: (data: any) => void | Promise<void>,
  config?: Record<string, McpServerConfig>,
): McpManager {
  // The manager is a process-wide singleton built on the FIRST call. Both the
  // injected `config` and `onOAuthRequired` are FIRST-CALLER-WINS: they are
  // honored only when the singleton does not yet exist. If `mcp()` (which reads
  // config from agency.json) runs before `mcpRaw({ config })`, the singleton is
  // already built and the injected config is ignored — so we warn rather than
  // silently drop it.
  if (!singleton) {
    const resolved = config ?? readMcpConfig();
    if (onOAuthRequired) registeredCallback = onOAuthRequired;
    singleton = new McpManager(resolved, { onOAuthRequired });
    if (!cleanupRegistered) {
      cleanupRegistered = true;
      registerGlobalHook("onAgentEnd", async () => {
        if (singleton) {
          await singleton.disconnectAll();
          singleton = null;
        }
      });
    }
  } else {
    if (config) {
      console.warn(
        "[mcp] the MCP manager was already created by an earlier call; the config passed here is ignored. Ensure the config-injecting caller runs first.",
      );
    }
    if (onOAuthRequired && onOAuthRequired !== registeredCallback) {
      console.warn(
        "[mcp] onOAuthRequired callback was already set on the first mcp() call and cannot be changed. The callback passed here will be ignored.",
      );
    }
  }
  return singleton;
}

export async function mcp(
  serverName: string,
  onOAuthRequired?: (data: any) => void | Promise<void>,
): Promise<ResultValue> {
  let manager: McpManager;
  try {
    manager = getManager(onOAuthRequired);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message);
  }

  let result: ResultValue;
  try {
    result = await manager.getTools(serverName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message);
  }

  if (!result.success) {
    return result;
  }

  const tools = result.value;
  const agencyFunctions = tools.map((tool: any) =>
    mcpToolToAgencyFunction(tool, (sn, tn, args) =>
      manager.callTool(sn, tn, args),
    ),
  );

  return success(agencyFunctions);
}

export async function mcpRaw(
  serverName: string,
  options?: McpRawOptions,
): Promise<ResultValue> {
  let manager: McpManager;
  try {
    manager = getManager(options?.onOAuthRequired, options?.config);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  let result: ResultValue;
  try {
    result = await manager.getTools(serverName);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  if (!result.success) {
    return result;
  }
  const value: McpRawResult = {
    tools: result.value,
    callTool: (server, tool, args) => manager.callTool(server, tool, args),
  };
  return success(value);
}

export { readMcpConfig, validateMcpServers } from "./configReader.js";
export { mcpToolToAgencyFunction } from "./toolAdapter.js";

export const MCP_PACKAGE_VERSION: string = (() => {
  // Resolve the package.json from BOTH src/mcp.ts (../package.json, vitest) and
  // the built dist/src/mcp.js (../../package.json). Try nearest-first.
  const require = createRequire(import.meta.url);
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const version = require(rel).version;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return "0.0.0";
})();

export type { McpTool, McpServerConfig } from "./types.js";
