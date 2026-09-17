import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "agency-lang/config";

export type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig };

export type ServerName = string;

export function isHttpServer(config: McpServerConfig): config is McpHttpServerConfig {
  return "type" in config && config.type === "http";
}

export function isStdioServer(config: McpServerConfig): config is McpStdioServerConfig {
  return !("type" in config);
}

export function isOAuthServer(config: McpServerConfig): config is McpHttpServerConfig {
  return isHttpServer(config) && config.auth === "oauth";
}

export type McpTool = {
  name: string;
  description: string;
  serverName: string;
  inputSchema: Record<string, unknown>;
  __mcpTool: true;
};
