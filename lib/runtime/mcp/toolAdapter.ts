import type { McpToolObject } from "./types.js";
import type { ToolRegistryEntry } from "../builtins.js";

export function isMcpTool(obj: any): obj is McpToolObject {
  return (
    obj !== null &&
    typeof obj === "object" &&
    obj.__mcpTool === true &&
    typeof obj.name === "string" &&
    typeof obj.serverName === "string"
  );
}

type CallToolFn = (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

export function mcpToolToRegistryEntry(
  tool: McpToolObject,
  callTool: CallToolFn,
): ToolRegistryEntry {
  // Extract parameter names from the JSON Schema inputSchema
  const properties = (tool.inputSchema as any)?.properties || {};
  const params = Object.keys(properties);

  // Strip the serverName__ prefix to get the original MCP tool name
  const originalName = tool.name.replace(`${tool.serverName}__`, "");

  return {
    definition: {
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
    },
    handler: {
      name: tool.name,
      params,
      execute: async (...args: any[]) => {
        // Last arg is the internal context object that prompt.ts appends — strip it
        const actualArgs = args.slice(0, params.length);
        const argsObj: Record<string, unknown> = {};
        params.forEach((p, i) => {
          argsObj[p] = actualArgs[i];
        });
        return callTool(tool.serverName, originalName, argsObj);
      },
      isBuiltin: false,
    },
  };
}
