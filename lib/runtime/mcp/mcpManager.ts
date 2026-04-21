import { McpConnection } from "./mcpConnection.js";
import type { McpServerConfig, McpToolObject } from "./types.js";
import { success, failure, type ResultValue } from "../result.js";

export class McpManager {
  private config: Record<string, McpServerConfig>;
  private connections: Record<string, McpConnection> = {};
  private toolCache: Record<string, McpToolObject[]> = {};

  constructor(config: Record<string, McpServerConfig>) {
    this.config = config;
  }

  async getTools(serverName: string): Promise<ResultValue> {
    // Config validation — programmer error, throw
    if (!this.config[serverName]) {
      throw new Error(
        `MCP server "${serverName}" not found in agency.json mcpServers config`,
      );
    }

    // Return cached tools if already connected
    if (this.toolCache[serverName]) {
      return success(this.toolCache[serverName]);
    }

    // Connect and fetch tools — runtime error, return Result
    try {
      const conn = new McpConnection(serverName, this.config[serverName]);
      await conn.connect();
      this.connections[serverName] = conn;
      this.toolCache[serverName] = conn.getTools();
      return success(this.toolCache[serverName]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return failure(
        `Failed to connect to MCP server "${serverName}": ${message}`,
      );
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const conn = this.connections[serverName];
    if (!conn) {
      // Attempt to reconnect (lazy reconnection after restore)
      if (this.config[serverName]) {
        const reconnConn = new McpConnection(serverName, this.config[serverName]);
        await reconnConn.connect();
        this.connections[serverName] = reconnConn;
        return reconnConn.callTool(toolName, args);
      }
      throw new Error(
        `No MCP connection for server "${serverName}" and no config to reconnect`,
      );
    }
    return conn.callTool(toolName, args);
  }

  async disconnectAll(): Promise<void> {
    const disconnects = Object.values(this.connections).map((conn) =>
      conn.disconnect().catch(() => {}),
    );
    await Promise.all(disconnects);
    this.connections = {};
    this.toolCache = {};
  }
}
