import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { AgencyOAuthProvider, type OAuthProviderOptions } from "./oauthProvider.js";
import { TokenStore } from "./tokenStore.js";
import { asNeedsLogin } from "./needsLogin.js";

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
  /** The client of a login started and not yet finished. */
  private pending: OAuthConnectResult | null = null;

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
      fetch: watchingRefreshes((token) => this.provider.noteRejectedRefreshToken(token)),
    });
  }

  private createClient(): Client {
    return new Client({ name: "agency-lang", version: "1.0.0" });
  }

  /**
   * Connect to the MCP server, handling OAuth if required.
   *
   * In "never" mode, a connection that needs a login rejects with
   * NeedsLoginError. In "ask first" mode, the SDK calls
   * redirectToAuthorization and throws UnauthorizedError; this waits for the
   * browser, exchanges the code, and connects again with a fresh client.
   */
  async connect(): Promise<OAuthConnectResult> {
    const client = this.createClient();
    const transport = this.createTransport();

    try {
      await client.connect(transport);
      await this.provider.cleanup();
      return { client, transport };
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) {
        await this.provider.cleanup();
        throw asNeedsLogin(error) ?? error;
      }
      try {
        await this.finishWith(client, transport);
        return await this.connectAgain();
      } finally {
        await this.provider.cleanup();
      }
    }
  }

  /** Start a login and return the login page URL, without waiting for it. A
   *  working saved login is ignored. */
  async startLogin(): Promise<string> {
    await this.cancelLogin();
    this.provider.beginLogin();
    const client = this.createClient();
    const transport = this.createTransport();
    try {
      await client.connect(transport);
    } catch (error) {
      const url = this.provider.pendingLoginUrl;
      if (error instanceof UnauthorizedError && url !== null) {
        this.pending = { client, transport };
        return url;
      }
      this.provider.endLogin();
      await this.provider.cleanup();
      throw asNeedsLogin(error) ?? error;
    }
    await client.close().catch(() => {});
    this.provider.endLogin();
    throw new Error(`MCP server "${this.serverName}" did not ask for a login`);
  }

  /** Wait for the browser, save the new login, and connect with it. */
  async finishLogin(): Promise<OAuthConnectResult> {
    const pending = this.pending;
    if (pending === null) {
      throw new Error(`no login in progress for ${this.serverName}`);
    }
    try {
      await this.finishWith(pending.client, pending.transport);
      this.provider.endLogin();
      return await this.connectAgain();
    } finally {
      this.pending = null;
      this.provider.endLogin();
      await pending.client.close().catch(() => {});
      await this.provider.cleanup();
    }
  }

  /** Stop a login in progress. A waiting finishLogin rejects. */
  async cancelLogin(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    this.provider.endLogin();
    await this.provider.cleanup();
    await pending?.client.close().catch(() => {});
  }

  private async finishWith(client: Client, transport: StreamableHTTPClientTransport): Promise<void> {
    const code = await this.provider.waitForAuthCode();
    await transport.finishAuth(code);
    // The first client cannot be reused after UnauthorizedError.
    await client.close().catch(() => {});
  }

  private async connectAgain(): Promise<OAuthConnectResult> {
    const client = this.createClient();
    const transport = this.createTransport();
    await client.connect(transport);
    return { client, transport };
  }
}

/** A fetch that reports each refresh token the server refuses with
 *  `invalid_grant`. The SDK sends token requests through the transport's
 *  fetch, and does not tell the provider which token it refused. */
function watchingRefreshes(onRejected: (refreshToken: string) => void): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const refreshToken = refreshTokenSent(init?.body);
    if (refreshToken === null || response.status !== 400) {
      return response;
    }
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (typeof body === "object" && body !== null && (body as { error?: unknown }).error === "invalid_grant") {
      onRejected(refreshToken);
    }
    return response;
  };
}

/** The refresh token in a token request's body, or null for any other request. */
function refreshTokenSent(body: RequestInit["body"]): string | null {
  if (!(body instanceof URLSearchParams) && typeof body !== "string") {
    return null;
  }
  const params = new URLSearchParams(body);
  return params.get("grant_type") === "refresh_token" ? params.get("refresh_token") : null;
}
