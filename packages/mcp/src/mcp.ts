import { McpManager } from "./mcpManager.js";
import { mcpToolToAgencyFunction } from "./toolAdapter.js";
import { readMcpConfig } from "./configReader.js";
import type { McpServerConfig } from "./types.js";
import { success, type ResultValue } from "agency-lang/runtime";

let singleton: McpManager | null = null;
let cleanupRegistered = false;

function getManager(onOAuthRequired?: (data: any) => void | Promise<void>): McpManager {
  if (!singleton) {
    const config = readMcpConfig();
    singleton = new McpManager(config, { onOAuthRequired });
    if (!cleanupRegistered) {
      cleanupRegistered = true;
      process.once("beforeExit", async () => {
        if (singleton) {
          await singleton.disconnectAll();
          singleton = null;
        }
      });
    }
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
