export type ServerName = string;

export type McpStdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: "http";
  url: string;
  auth?: "oauth";
  authTimeout?: number;
  clientId?: string;
  clientSecret?: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export function isOAuthServer(config: McpServerConfig): config is McpHttpServerConfig {
  return "type" in config && config.type === "http" && config.auth === "oauth";
}

export type McpTool = {
  name: string;
  description: string;
  serverName: string;
  inputSchema: Record<string, unknown>;
  __mcpTool: true;
};
