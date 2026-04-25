import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isHttpServer, isStdioServer } from "./types.js";
import type { McpServerConfig, McpStdioServerConfig, McpHttpServerConfig, McpTool } from "./types.js";

/** Returns a connected MCP Client. Used by OAuthConnector. */
export type ConnectorFn = () => Promise<{ client: Client }>;

export type McpConnectionOptions = {
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
      const result = await this.connector();
      this.client = result.client;
    } else if (isHttpServer(this.config)) {
      const opts: Record<string, any> = {};
      if (this.config.headers) {
        opts.requestInit = { headers: this.config.headers };
      }
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), opts);
      await this.client.connect(transport);
    } else if (isStdioServer(this.config)) {
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env,
      });
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
