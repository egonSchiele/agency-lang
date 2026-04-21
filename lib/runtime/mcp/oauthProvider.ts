import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { CallbackServer } from "./callbackServer.js";
import { TokenStore } from "./tokenStore.js";

const execFileAsync = promisify(execFile);

/**
 * Open a URL in the default browser. macOS-only for now.
 * Mirrors stdlib _openUrl() — duplicated here to avoid cross-tsconfig imports.
 */
async function openInBrowser(url: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(
      `Opening a browser is currently only supported on macOS (detected: ${process.platform}). ` +
      `Cross-platform support will be added in a future release.`,
    );
  }
  await execFileAsync("open", ["--", url]);
}

export type OAuthRequiredData = {
  serverName: string;
  authUrl: string;
  /** Promise that resolves when the OAuth flow completes (callback received) */
  complete: Promise<void>;
  /** Cancel the OAuth flow */
  cancel: () => void;
};

export type OAuthProviderOptions = {
  onOAuthRequired?: (data: OAuthRequiredData) => void | Promise<void>;
  timeoutMs?: number;
  clientId?: string;
  clientSecret?: string;
  /** Override the callback server port (default 19876). Use 0 for random port in tests. */
  port?: number;
};

export class AgencyOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private store: TokenStore;
  private options: OAuthProviderOptions;
  private callbackServer: CallbackServer | null = null;
  private _callbackUrl: string | null = null;

  constructor(
    serverName: string,
    store: TokenStore,
    options: OAuthProviderOptions = {},
  ) {
    this.serverName = serverName;
    this.store = store;
    this.options = options;
  }

  /**
   * Start the callback server before connect() so the redirect URL is
   * known when the SDK reads clientMetadata for dynamic registration.
   * Called by OAuthConnector before client.connect().
   */
  async prepare(): Promise<void> {
    this.callbackServer = new CallbackServer({
      port: this.options.port,
      timeoutMs: this.options.timeoutMs,
    });
    this._callbackUrl = await this.callbackServer.start();
  }

  /**
   * Wait for the authorization code from the callback server.
   * Returns the code string. Rejects on timeout or cancellation.
   */
  async waitForAuthCode(): Promise<string> {
    if (!this.callbackServer) {
      throw new Error(`OAuth flow for "${this.serverName}" not started — call prepare() first`);
    }
    return this.callbackServer.waitForCode();
  }

  state(): string {
    if (!this.callbackServer) {
      throw new Error(`OAuth flow for "${this.serverName}" not started — call prepare() first`);
    }
    return this.callbackServer.state;
  }

  get redirectUrl(): string {
    if (!this._callbackUrl) {
      throw new Error(`OAuth flow for "${this.serverName}" not started — call prepare() first`);
    }
    return this._callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: `agency-${this.serverName}`,
    };
  }

  private envVarName(suffix: string): string {
    const normalized = this.serverName.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    return `MCP_${normalized}_${suffix}`;
  }

  private resolveClientId(): string | undefined {
    return this.options.clientId ?? process.env[this.envVarName("CLIENT_ID")];
  }

  private resolveClientSecret(): string | undefined {
    return this.options.clientSecret ?? process.env[this.envVarName("CLIENT_SECRET")];
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.store.loadClientInfo(this.serverName);
    if (stored) return stored;
    // If a pre-registered clientId was provided (config or env var), use it.
    // This skips Dynamic Client Registration (DCR), which many servers
    // (like GitHub) don't support.
    const clientId = this.resolveClientId();
    if (clientId) {
      const info: Record<string, string> = { client_id: clientId };
      const clientSecret = this.resolveClientSecret();
      if (clientSecret) {
        info.client_secret = clientSecret;
      }
      return info as unknown as OAuthClientInformationMixed;
    }
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.saveClientInfo(this.serverName, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.store.loadTokens(this.serverName);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.saveTokens(this.serverName, tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Set up a completion promise for the onOAuthRequired callback
    let resolveComplete: () => void;
    let rejectComplete: (err: Error) => void;
    const completePromise = new Promise<void>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });

    // Wire callback server completion to the complete promise
    if (this.callbackServer) {
      this.callbackServer.waitForCode()
        .then(() => resolveComplete())
        .catch((err) => rejectComplete(err));
    }

    if (this.options.onOAuthRequired) {
      await this.options.onOAuthRequired({
        serverName: this.serverName,
        authUrl: authorizationUrl.toString(),
        complete: completePromise,
        cancel: () => {
          void this.cleanup().catch(() => {});
          rejectComplete!(new Error("OAuth flow cancelled"));
        },
      });
    } else {
      try {
        await openInBrowser(authorizationUrl.toString());
        console.log(
          `Waiting for authorization for "${this.serverName}"... (press Ctrl+C to cancel)`,
        );
      } catch {
        console.log(
          `Please open this URL to authorize "${this.serverName}":\n${authorizationUrl.toString()}`,
        );
      }
    }
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.saveCodeVerifier(this.serverName, verifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.store.loadCodeVerifier(this.serverName);
    if (!verifier) {
      throw new Error(`No PKCE code verifier found for "${this.serverName}"`);
    }
    return verifier;
  }

  async cleanup(): Promise<void> {
    if (this.callbackServer) {
      await this.callbackServer.stop();
      this.callbackServer = null;
    }
    this._callbackUrl = null;
    await this.store.deleteCodeVerifier(this.serverName);
  }
}
