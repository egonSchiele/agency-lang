import { McpConnection } from "./mcpConnection.js";
import { OAuthConnector } from "./oauthConnector.js";
import { TokenStore } from "./tokenStore.js";
import { isOAuthServer } from "./types.js";
import { asNeedsLogin } from "./needsLogin.js";
import type { ServerName, McpServerConfig, McpHttpServerConfig, McpTool } from "./types.js";
import { success, failure, type ResultValue } from "agency-lang/runtime";
import type { LoginMode, OAuthRequiredData } from "./oauthProvider.js";

export type McpManagerOptions = {
  onOAuthRequired?: (data: OAuthRequiredData) => void | Promise<void>;
  tokenStoreDir?: string;
  /** The callback page's port for every login (default 19876). */
  callbackPort?: number;
};

/** What the manager knows about one server. */
export type ServerRecord =
  | { status: "connected"; tools: McpTool[] }
  | { status: "needsLogin" }
  | { status: "failed"; message: string };

type ConnectedRecord = Extract<ServerRecord, { status: "connected" }>;

type PendingLogin = { serverName: string; connector: OAuthConnector };

const NEEDS_LOGIN: ServerRecord = { status: "needsLogin" };

export class McpManager {
  private config: Record<ServerName, McpServerConfig>;
  private connections: Record<ServerName, McpConnection> = {};
  private serverRecords: Record<ServerName, ServerRecord> = {};
  private connectPromises: Record<ServerName, Promise<ResultValue>> = {};
  /** The servers a no-login method was called for. Their connections never
   *  start a login on their own. */
  private neverLogin: ServerName[] = [];
  /** One login per process, because every login's callback page uses the
   *  same port. */
  private pendingLogin: PendingLogin | null = null;
  private tokenStore: TokenStore;
  private onOAuthRequired?: (data: OAuthRequiredData) => void | Promise<void>;
  private callbackPort?: number;

  constructor(
    config: Record<ServerName, McpServerConfig>,
    options: McpManagerOptions = {},
  ) {
    this.config = config;
    this.tokenStore = new TokenStore(options.tokenStoreDir);
    this.onOAuthRequired = options.onOAuthRequired;
    this.callbackPort = options.callbackPort;
  }

  setConfig(config: Record<ServerName, McpServerConfig>): void {
    this.config = config;
  }

  /** A copy of every server's record. Connects nothing. */
  records(): Record<ServerName, ServerRecord> {
    return { ...this.serverRecords };
  }

  /** Connect one server without ever starting a login. */
  async connectServer(serverName: string): Promise<ServerRecord> {
    this.markNeverLogin(serverName);
    if (!this.config[serverName]) {
      return { status: "failed", message: `MCP server "${serverName}" is not in the config` };
    }
    try {
      const conn = this.createConnection(serverName);
      await conn.connect();
      return await this.storeConnection(serverName, conn);
    } catch (error) {
      const record: ServerRecord = asNeedsLogin(error)
        ? NEEDS_LOGIN
        : { status: "failed", message: messageOf(error) };
      await this.replaceConnection(serverName, record);
      return record;
    }
  }

  /** Start a login and return the login page URL. Cancels any login in
   *  progress, for any server. */
  async startLogin(serverName: string): Promise<string> {
    this.markNeverLogin(serverName);
    const serverConfig = this.config[serverName];
    if (!serverConfig) {
      throw new Error(`MCP server "${serverName}" is not in the config`);
    }
    if (!isOAuthServer(serverConfig)) {
      throw new Error(`MCP server "${serverName}" is not an OAuth server`);
    }
    await this.cancelAnyLogin();
    const connector = this.oauthConnector(serverName, serverConfig);
    const url = await connector.startLogin();
    this.pendingLogin = { serverName, connector };
    return url;
  }

  /** Wait for the login started for this server, then connect with it. On
   *  failure the record and any old connection stay as they were. */
  async finishLogin(serverName: string): Promise<ServerRecord> {
    const pending = this.pendingLogin;
    if (pending === null || pending.serverName !== serverName) {
      throw new Error(`no login in progress for ${serverName}`);
    }
    try {
      const result = await pending.connector.finishLogin();
      const conn = new McpConnection(serverName, this.config[serverName], {
        connector: async () => result,
      });
      await conn.connect();
      return await this.storeConnection(serverName, conn);
    } finally {
      if (this.pendingLogin === pending) {
        this.pendingLogin = null;
      }
    }
  }

  async cancelLogin(serverName: string): Promise<void> {
    if (this.pendingLogin?.serverName === serverName) {
      await this.cancelAnyLogin();
    }
  }

  async cancelAnyLogin(): Promise<void> {
    const pending = this.pendingLogin;
    this.pendingLogin = null;
    await pending?.connector.cancelLogin();
  }

  /** Delete the saved login and disconnect. Keeps the registration. */
  async logout(serverName: string): Promise<void> {
    await this.tokenStore.deleteLogin(serverName);
    await this.replaceConnection(serverName, NEEDS_LOGIN);
  }

  async disconnectServer(serverName: string): Promise<void> {
    await this.replaceConnection(serverName, null);
  }

  async getTools(serverName: string): Promise<ResultValue> {
    if (!this.config[serverName]) {
      throw new Error(
        `MCP server "${serverName}" not found in agency.json mcpServers config`,
      );
    }

    const record = this.serverRecords[serverName];
    if (record?.status === "connected") {
      return success(record.tools);
    }

    // Prevent concurrent connection attempts for the same server.
    // Only one OAuth flow should fire per server.
    if (Object.hasOwn(this.connectPromises, serverName)) {
      return this.connectPromises[serverName];
    }

    const connectPromise = (async () => {
      try {
        const conn = this.createConnection(serverName);
        await conn.connect();
        const connected = await this.storeConnection(serverName, conn);
        return success(connected.tools);
      } catch (error) {
        const message = messageOf(error);
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
    try {
      const conn = this.connections[serverName] ?? (await this.reconnect(serverName));
      return await conn.callTool(toolName, args);
    } catch (error) {
      const needsLogin = asNeedsLogin(error);
      if (needsLogin === null) {
        throw error;
      }
      await this.replaceConnection(serverName, NEEDS_LOGIN);
      throw needsLogin;
    }
  }

  async disconnectAll(): Promise<void> {
    // Clear pending connect promises so in-flight connections don't write
    // back to this.connections after we've cleaned up.
    this.connectPromises = {};
    await this.cancelAnyLogin();

    const conns = Object.values(this.connections);
    // Swallow individual disconnect errors to ensure all servers get cleaned up
    await Promise.all(conns.map((conn) => conn.disconnect().catch(() => {})));
    this.connections = {};
    this.serverRecords = {};
  }

  private markNeverLogin(serverName: string): void {
    if (!this.neverLogin.includes(serverName)) {
      this.neverLogin.push(serverName);
    }
  }

  private loginModeFor(serverName: string): LoginMode {
    return this.neverLogin.includes(serverName) ? "never" : "askFirst";
  }

  private oauthConnector(serverName: string, config: McpHttpServerConfig): OAuthConnector {
    return new OAuthConnector(serverName, config.url, this.tokenStore, {
      onOAuthRequired: this.onOAuthRequired,
      timeoutMs: config.authTimeout,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      port: this.callbackPort,
      loginMode: this.loginModeFor(serverName),
    });
  }

  private createConnection(serverName: string): McpConnection {
    const serverConfig = this.config[serverName];
    if (isOAuthServer(serverConfig)) {
      const connector = this.oauthConnector(serverName, serverConfig);
      // Pass connector.connect() as the opaque ConnectorFn.
      // McpConnection doesn't know what happens inside.
      return new McpConnection(serverName, serverConfig, {
        connector: () => connector.connect(),
      });
    }
    return new McpConnection(serverName, serverConfig);
  }

  /** Build a connection for a tool call on a server that has none. */
  private async reconnect(serverName: string): Promise<McpConnection> {
    if (!this.config[serverName]) {
      throw new Error(
        `No MCP connection for server "${serverName}" and no config to reconnect`,
      );
    }
    const conn = this.createConnection(serverName);
    await conn.connect();
    await this.storeConnection(serverName, conn);
    return conn;
  }

  /** Close and forget the server's connection, if it has one. Then store
   *  `record`, or forget the record when `record` is null. */
  private async replaceConnection(serverName: string, record: ServerRecord | null): Promise<void> {
    const conn = this.connections[serverName];
    delete this.connections[serverName];
    if (record === null) {
      delete this.serverRecords[serverName];
    } else {
      this.serverRecords[serverName] = record;
    }
    await conn?.disconnect().catch(() => {});
  }

  /** Store a live connection and its connected record. Closes the
   *  connection it replaces. */
  private async storeConnection(serverName: string, conn: McpConnection): Promise<ConnectedRecord> {
    const old = this.connections[serverName];
    this.connections[serverName] = conn;
    const record: ConnectedRecord = { status: "connected", tools: conn.getTools() };
    this.serverRecords[serverName] = record;
    if (old !== undefined && old !== conn) {
      await old.disconnect().catch(() => {});
    }
    return record;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
