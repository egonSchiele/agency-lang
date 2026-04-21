import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpStdioServerConfig, McpHttpServerConfig, McpTool } from "./types.js";

export function interpolateEnvVars(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        throw new Error(
          `Environment variable "${varName}" is not set (referenced in MCP server headers)`,
        );
      }
      return envValue;
    });
    // Guard against CRLF injection: env var values containing \r or \n
    // could inject additional HTTP headers.
    if (/[\r\n]/.test(result[key])) {
      throw new Error(
        `Header "${key}" contains illegal newline characters after environment variable interpolation (possible CRLF injection)`,
      );
    }
  }
  return result;
}

/** Returns a connected MCP Client. Used by OAuthConnector. */
export type ConnectorFn = () => Promise<{ client: Client }>;

export type McpConnectionOptions = {
  /** Opaque connector function that returns a connected client+transport. */
  connector?: ConnectorFn;
};

export class McpConnection {
  private client: Client;
  private serverName: string;
  private config: McpServerConfig;
  private tools: McpTool[] = [];
  private connected = false;
  private connector: ConnectorFn | undefined;

  constructor(serverName: string, config: McpServerConfig, options: McpConnectionOptions = {}) {
    this.serverName = serverName;
    this.config = config;
    this.connector = options.connector;
    this.client = new Client({
      name: "agency-lang",
      version: "1.0.0",
    });
  }

  async connect(): Promise<void> {
    if (this.connector) {
      // Delegate entirely to the connector (e.g. OAuthConnector).
      // McpConnection doesn't know what happens inside.
      const result = await this.connector();
      this.client = result.client;
    } else {
      // Build transport directly (stdio or plain HTTP with optional headers)
      let transport;
      if ("type" in this.config && this.config.type === "http") {
        const httpConfig = this.config as McpHttpServerConfig;
        const opts: Record<string, any> = {};
        if (httpConfig.headers) {
          const headers = interpolateEnvVars(httpConfig.headers);
          opts.requestInit = { headers };
        }
        transport = new StreamableHTTPClientTransport(new URL(httpConfig.url), opts);
      } else {
        const stdio = this.config as McpStdioServerConfig;
        transport = new StdioClientTransport({
          command: stdio.command,
          args: stdio.args,
          env: stdio.env,
        });
      }
      await this.client.connect(transport);
    }

    this.connected = true;

    const result = await this.client.listTools();
    this.tools = (result.tools || []).map((tool) => ({
      name: `${this.serverName}__${tool.name}`,
      description: tool.description || "",
      serverName: this.serverName,
      inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
      __mcpTool: true as const,
    }));
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.client.callTool({ name: toolName, arguments: args });
    const textParts = (result.content as any[])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    return textParts.join("\n");
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
