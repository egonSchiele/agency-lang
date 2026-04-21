import { McpConnection } from "./mcpConnection.js";
import type { ServerName, McpServerConfig, McpTool } from "./types.js";
import { success, failure, type ResultValue } from "../result.js";

export class McpManager {
  private config: Record<ServerName, McpServerConfig>;
  private connections: Record<ServerName, McpConnection> = {};
  private toolCache: Record<ServerName, McpTool[]> = {};

  constructor(config: Record<ServerName, McpServerConfig>) {
    this.config = config;
  }

  async getTools(serverName: string): Promise<ResultValue> {
    if (!this.config[serverName]) {
      throw new Error(
        `MCP server "${serverName}" not found in agency.json mcpServers config`,
      );
    }

    if (this.toolCache[serverName]) {
      return success(this.toolCache[serverName]);
    }

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
    const conns = Object.values(this.connections);
    if (conns.length === 0) return;
    // Swallow individual disconnect errors to ensure all servers get cleaned up
    await Promise.all(conns.map((conn) => conn.disconnect().catch(() => {})));
    this.connections = {};
    this.toolCache = {};
  }
}
