import { z } from "zod";
import type { McpTool } from "./types.js";
import { AgencyFunction } from "agency-lang/runtime";

const McpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  serverName: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  __mcpTool: z.literal(true),
});

export function isMcpTool(obj: any): obj is McpTool {
  return McpToolSchema.safeParse(obj).success;
}

type CallToolFn = (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

export function mcpToolToAgencyFunction(
  tool: McpTool,
  callTool: CallToolFn,
): AgencyFunction {
  const properties = (tool.inputSchema as any)?.properties || {};
  const params = Object.keys(properties);

  const expectedPrefix = `${tool.serverName}__`;
  if (!tool.name.startsWith(expectedPrefix)) {
    throw new Error(
      `Invalid MCP tool name "${tool.name}": expected prefix "${expectedPrefix}"`,
    );
  }
  const originalName = tool.name.slice(expectedPrefix.length);

  // Smoltalk expects schemas with a .toJSONSchema() method (Zod-like).
  // MCP gives us plain JSON Schema, so wrap it.
  const schemaWrapper = {
    ...tool.inputSchema,
    toJSONSchema: () => tool.inputSchema,
  };

  return new AgencyFunction({
    name: tool.name,
    module: `mcp:${tool.serverName}`,
    fn: async (...args: any[]) => {
      // The last arg is __state from invoke(), the rest are positional params
      const actualArgs = args.slice(0, params.length);
      const argsObj: Record<string, unknown> = {};
      params.forEach((p, i) => {
        argsObj[p] = actualArgs[i];
      });
      return callTool(tool.serverName, originalName, argsObj);
    },
    params: params.map((p) => ({
      name: p,
      hasDefault: false,
      defaultValue: undefined,
      variadic: false,
    })),
    toolDefinition: {
      name: tool.name,
      description: tool.description,
      schema: schemaWrapper,
    },
  });
}
