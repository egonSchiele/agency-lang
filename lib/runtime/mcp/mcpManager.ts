import { McpConnection } from "./mcpConnection.js";
import { OAuthConnector } from "./oauthConnector.js";
import { TokenStore } from "./tokenStore.js";
import { isOAuthServer } from "./types.js";
import type { ServerName, McpServerConfig, McpHttpServerConfig, McpTool } from "./types.js";
import { success, failure, type ResultValue } from "../result.js";
import type { OAuthRequiredData } from "./oauthProvider.js";

export type McpManagerOptions = {
  onOAuthRequired?: (data: OAuthRequiredData) => void | Promise<void>;
  tokenStoreDir?: string;
};

export class McpManager {
  private config: Record<ServerName, McpServerConfig>;
  private connections: Record<ServerName, McpConnection> = {};
  private toolCache: Record<ServerName, McpTool[]> = {};
  private connectPromises: Record<ServerName, Promise<ResultValue>> = {};
  private tokenStore: TokenStore;
  private onOAuthRequired?: (data: OAuthRequiredData) => void | Promise<void>;

  constructor(
    config: Record<ServerName, McpServerConfig>,
    options: McpManagerOptions = {},
  ) {
    this.config = config;
    this.tokenStore = new TokenStore(options.tokenStoreDir);
    this.onOAuthRequired = options.onOAuthRequired;
  }

  private createConnection(serverName: string): McpConnection {
    const serverConfig = this.config[serverName];
    if (isOAuthServer(serverConfig)) {
      const httpConfig = serverConfig as McpHttpServerConfig;
      const connector = new OAuthConnector(serverName, httpConfig.url, this.tokenStore, {
        onOAuthRequired: this.onOAuthRequired,
        timeoutMs: httpConfig.authTimeout,
        clientId: httpConfig.clientId,
        clientSecret: httpConfig.clientSecret,
      });
      // Pass connector.connect() as the opaque ConnectorFn.
      // McpConnection doesn't know what happens inside.
      return new McpConnection(serverName, serverConfig, {
        connector: () => connector.connect(),
      });
    }

    return new McpConnection(serverName, serverConfig);
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

    // Prevent concurrent connection attempts for the same server.
    // Only one OAuth flow should fire per server.
    if (serverName in this.connectPromises) {
      return this.connectPromises[serverName];
    }

    const connectPromise = (async () => {
      try {
        const conn = this.createConnection(serverName);
        await conn.connect();
        this.connections[serverName] = conn;
        this.toolCache[serverName] = conn.getTools();
        return success(this.toolCache[serverName]);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[mcp] Failed to connect to server "${serverName}": ${message}`);
        return failure(
          `Failed to connect to MCP server "${serverName}": ${message}`,
        );
      } finally {
        delete this.connectPromises[serverName];
      }
    })();

    this.connectPromises[serverName] = connectPromise;
    return connectPromise;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const conn = this.connections[serverName];
    if (!conn) {
      if (this.config[serverName]) {
        const reconnConn = this.createConnection(serverName);
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
    // Clear pending connect promises so in-flight connections don't write
    // back to this.connections after we've cleaned up.
    this.connectPromises = {};

    const conns = Object.values(this.connections);
    // Swallow individual disconnect errors to ensure all servers get cleaned up
    await Promise.all(conns.map((conn) => conn.disconnect().catch(() => {})));
    this.connections = {};
    this.toolCache = {};
  }
}
