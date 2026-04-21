export type ServerName = string;

export type McpStdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: "http";
  url: string;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpTool = {
  name: string;
  description: string;
  serverName: string;
  inputSchema: Record<string, unknown>;
  __mcpTool: true;
};
