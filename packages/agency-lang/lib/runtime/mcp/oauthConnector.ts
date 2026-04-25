import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { AgencyOAuthProvider, type OAuthProviderOptions } from "./oauthProvider.js";
import { TokenStore } from "./tokenStore.js";

export type OAuthConnectResult = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

/**
 * Encapsulates the two-phase OAuth connect flow for an MCP HTTP server.
 *
 * This is the ONLY class that knows about UnauthorizedError, finishAuth(),
 * and the retry logic. McpConnection and McpManager do not import any
 * OAuth-related types.
 *
 * Usage:
 *   const connector = new OAuthConnector(serverName, url, tokenStore, options);
 *   const { client, transport } = await connector.connect();
 */
export class OAuthConnector {
  private serverName: string;
  private url: string;
  private provider: AgencyOAuthProvider;

  constructor(
    serverName: string,
    url: string,
    tokenStore: TokenStore,
    options: OAuthProviderOptions = {},
  ) {
    this.serverName = serverName;
    this.url = url;
    this.provider = new AgencyOAuthProvider(serverName, tokenStore, options);
  }

  private createTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(this.url), {
      authProvider: this.provider,
    });
  }

  private createClient(): Client {
    return new Client({ name: "agency-lang", version: "1.0.0" });
  }

  /**
   * Connect to the MCP server, handling OAuth if required.
   *
   * 1. Starts the callback server (so redirect URL is known for registration)
   * 2. Attempts to connect
   * 3. If the server requires auth, the SDK calls redirectToAuthorization
   *    and throws UnauthorizedError
   * 4. Waits for the user to authorize in the browser
   * 5. Calls finishAuth(code) to exchange the code for tokens
   * 6. Retries with a fresh client/transport (SDK may not support reuse)
   *
   * Returns a connected {client, transport} pair.
   */
  async connect(): Promise<OAuthConnectResult> {
    // Start callback server BEFORE connect so the redirect URL has a real port
    // when the SDK reads clientMetadata for dynamic client registration.
    await this.provider.prepare();

    const client = this.createClient();
    const transport = this.createTransport();

    try {
      await client.connect(transport);
      // No auth needed (or had valid stored tokens) — clean up callback server
      await this.provider.cleanup();
      return { client, transport };
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) {
        await this.provider.cleanup();
        throw error;
      }

      // Two-phase OAuth: the SDK has called redirectToAuthorization and thrown.
      // Wait for the user to complete auth in the browser.
      try {
        const code = await this.provider.waitForAuthCode();
        await transport.finishAuth(code);

        // Close the original client/transport — they can't be reused after
        // UnauthorizedError and would leak otherwise.
        await client.close().catch(() => {});

        const retryClient = this.createClient();
        const retryTransport = this.createTransport();
        await retryClient.connect(retryTransport);
        return { client: retryClient, transport: retryTransport };
      } finally {
        await this.provider.cleanup();
      }
    }
  }
}
