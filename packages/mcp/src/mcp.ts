import { McpManager } from "./mcpManager.js";
import { mcpToolToAgencyFunction } from "./toolAdapter.js";
import { readMcpConfig } from "./configReader.js";
import type { McpServerConfig } from "./types.js";
import { success, registerGlobalHook, type ResultValue } from "agency-lang/runtime";

let singleton: McpManager | null = null;
let cleanupRegistered = false;
let registeredCallback: ((data: any) => void | Promise<void>) | undefined;

function getManager(onOAuthRequired?: (data: any) => void | Promise<void>): McpManager {
  if (!singleton) {
    const config = readMcpConfig();
    registeredCallback = onOAuthRequired;
    singleton = new McpManager(config, { onOAuthRequired });
    if (!cleanupRegistered) {
      cleanupRegistered = true;
      registerGlobalHook("onAgentEnd", async () => {
        if (singleton) {
          await singleton.disconnectAll();
          singleton = null;
        }
      });
    }
  } else if (onOAuthRequired && onOAuthRequired !== registeredCallback) {
    console.warn(
      "[mcp] onOAuthRequired callback was already set on the first mcp() call and cannot be changed. The callback passed here will be ignored.",
    );
  }
  return singleton;
}

export async function mcp(
  serverName: string,
  onOAuthRequired?: (data: any) => void | Promise<void>,
): Promise<ResultValue> {
  const manager = getManager(onOAuthRequired);
  const result = await manager.getTools(serverName);

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

export type { McpTool, McpServerConfig } from "./types.js";
