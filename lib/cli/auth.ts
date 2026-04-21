import { TokenStore } from "../runtime/mcp/tokenStore.js";
import { OAuthConnector } from "../runtime/mcp/oauthConnector.js";
import type { AgencyConfig } from "../config.js";
import type { McpHttpServerConfig } from "../runtime/mcp/types.js";

const store = new TokenStore();

export async function authServer(
  serverName: string,
  config: AgencyConfig,
): Promise<void> {
  const mcpServers = config.mcpServers;
  if (!mcpServers || !mcpServers[serverName]) {
    console.error(
      `MCP server "${serverName}" not found in agency.json. Available servers: ${
        mcpServers ? Object.keys(mcpServers).join(", ") : "(none)"
      }`,
    );
    process.exit(1);
  }

  const serverConfig = mcpServers[serverName];
  if (!("type" in serverConfig) || serverConfig.type !== "http") {
    console.error(`MCP server "${serverName}" is not an HTTP server — OAuth is only for HTTP servers.`);
    process.exit(1);
  }

  const httpConfig = serverConfig as McpHttpServerConfig;
  if (httpConfig.auth !== "oauth") {
    console.error(`MCP server "${serverName}" does not have auth: "oauth" in its config.`);
    process.exit(1);
  }

  const existing = await store.loadTokens(serverName);
  if (existing) {
    console.log(`Token already exists for "${serverName}". Use --revoke to remove it first.`);
    return;
  }

  console.log(`Starting OAuth authorization for "${serverName}"...`);

  const connector = new OAuthConnector(serverName, httpConfig.url, store, {
    timeoutMs: httpConfig.authTimeout,
    clientId: httpConfig.clientId,
    clientSecret: httpConfig.clientSecret,
  });

  try {
    const { client } = await connector.connect();
    console.log(`Successfully authorized "${serverName}". Token stored.`);
    await client.close();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Authorization failed for "${serverName}": ${msg}`);
    process.exit(1);
  }
}

export async function listAuth(): Promise<void> {
  const servers = await store.listServers();
  if (servers.length === 0) {
    console.log("No stored OAuth tokens.");
    return;
  }
  console.log("Stored OAuth tokens:");
  for (const name of servers) {
    const tokens = await store.loadTokens(name);
    const hasRefresh = tokens?.refresh_token ? "yes" : "no";
    console.log(`  ${name} (refresh token: ${hasRefresh})`);
  }
}

export async function revokeAuth(serverName: string): Promise<void> {
  const tokens = await store.loadTokens(serverName);
  if (!tokens) {
    console.log(`No stored token for "${serverName}".`);
    return;
  }
  await store.deleteTokens(serverName);
  console.log(`Removed stored token for "${serverName}".`);
}
