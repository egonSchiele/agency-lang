#!/usr/bin/env node

import { readMcpConfig } from "./configReader.js";
import { OAuthConnector } from "./oauthConnector.js";
import { TokenStore } from "./tokenStore.js";
import { isOAuthServer } from "./types.js";
import type { McpHttpServerConfig } from "./types.js";

const store = new TokenStore();
const args = process.argv.slice(2);

async function main() {
  if (args.includes("--list")) {
    await listAuth();
  } else if (args.includes("--revoke")) {
    const idx = args.indexOf("--revoke");
    const serverName = args[idx + 1];
    if (!serverName) {
      console.error("Usage: @agency-lang/mcp auth --revoke <server-name>");
      process.exit(1);
    }
    await revokeAuth(serverName);
  } else if (args[0] === "auth" && args[1]) {
    await authServer(args[1]);
  } else {
    console.error(
      "Usage: @agency-lang/mcp auth <server-name> | --list | --revoke <server-name>",
    );
    process.exit(1);
  }
}

async function authServer(serverName: string): Promise<void> {
  const config = readMcpConfig();
  if (!config[serverName]) {
    const available = Object.keys(config);
    console.error(
      `MCP server "${serverName}" not found in agency.json. Available servers: ${
        available.length > 0 ? available.join(", ") : "(none)"
      }`,
    );
    process.exit(1);
  }

  if (!isOAuthServer(config[serverName])) {
    console.error(`MCP server "${serverName}" is not configured with auth: "oauth".`);
    process.exit(1);
  }

  const httpConfig = config[serverName] as McpHttpServerConfig;

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

async function listAuth(): Promise<void> {
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

async function revokeAuth(serverName: string): Promise<void> {
  const tokens = await store.loadTokens(serverName);
  if (!tokens) {
    console.log(`No stored token for "${serverName}".`);
    return;
  }
  await store.deleteTokens(serverName);
  console.log(`Removed stored token for "${serverName}".`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
