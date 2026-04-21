import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpToolObject } from "./types.js";

export class McpConnection {
  private client: Client;
  private serverName: string;
  private config: McpServerConfig;
  private tools: McpToolObject[] = [];
  private connected = false;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
    this.client = new Client({
      name: "agency-lang",
      version: "1.0.0",
    });
  }

  async connect(): Promise<void> {
    let transport;
    if ("command" in this.config) {
      transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env
          ? { ...process.env, ...this.config.env } as Record<string, string>
          : undefined,
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(this.config.url));
    }

    await this.client.connect(transport);
    this.connected = true;

    // Eagerly fetch tools on connect
    const result = await this.client.listTools();
    this.tools = (result.tools || []).map((tool) => ({
      name: `${this.serverName}__${tool.name}`,
      description: tool.description || "",
      serverName: this.serverName,
      inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
      __mcpTool: true as const,
    }));
  }

  getTools(): McpToolObject[] {
    return this.tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.client.callTool({ name: toolName, arguments: args });
    // MCP tool results have a `content` array; concatenate text entries
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
