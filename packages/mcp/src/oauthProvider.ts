import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { promisify } from "util";
import { CallbackServer, callbackUrlFor } from "./callbackServer.js";
import { NeedsLoginError } from "./needsLogin.js";
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
  /** The callback page's port (default 19876). */
  port?: number;
  /** What a connection does when it needs a login. Default "askFirst". */
  loginMode?: LoginMode;
};

/** "askFirst" starts a login and waits for it, as 0.0.5 did. "never" fails
 *  with NeedsLoginError instead, and only startLogin starts a login. */
export type LoginMode = "askFirst" | "never";

/** The scopes the SDK may pass to invalidateCredentials. */
type CredentialScope = "all" | "client" | "tokens" | "verifier" | "discovery";

export class AgencyOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private store: TokenStore;
  private options: OAuthProviderOptions;
  private callbackServer: CallbackServer | null = null;
  private lastState: string | null = null;
  /** True between startLogin and the end of that login. */
  private startingLogin = false;
  private loginUrl: string | null = null;
  private rejectedRefreshToken: string | null = null;

  constructor(
    serverName: string,
    store: TokenStore,
    options: OAuthProviderOptions = {},
  ) {
    this.serverName = serverName;
    this.store = store;
    this.options = options;
  }

  /** Mark a login as being started: tokens() returns nothing, so the SDK goes
   *  straight to a new login, and redirectToAuthorization keeps the URL. */
  beginLogin(): void {
    this.startingLogin = true;
    this.loginUrl = null;
  }

  endLogin(): void {
    this.startingLogin = false;
  }

  /** The login page URL kept by the last redirectToAuthorization of a login
   *  being started, or null. */
  get pendingLoginUrl(): string | null {
    return this.loginUrl;
  }

  /**
   * Wait for the authorization code from the callback page. Rejects on
   * timeout or cancellation, or when no page is running.
   */
  async waitForAuthCode(): Promise<string> {
    if (!this.callbackServer) {
      throw new Error(`No login in progress for "${this.serverName}"`);
    }
    return this.callbackServer.waitForCode();
  }

  /** A new `state` value for each login. The SDK puts it in the login URL. */
  state(): string {
    this.lastState = randomBytes(32).toString("hex");
    return this.lastState;
  }

  get redirectUrl(): string {
    return callbackUrlFor(this.options.port);
  }

  /** Record the refresh token the server last refused. invalidateCredentials
   *  deletes the saved login only when it still holds this token. */
  noteRejectedRefreshToken(token: string): void {
    this.rejectedRefreshToken = token;
  }

  async invalidateCredentials(scope: CredentialScope): Promise<void> {
    if (scope === "all") {
      await this.store.deleteTokens(this.serverName);
      return;
    }
    if (scope !== "tokens") {
      return;
    }
    // Another call may have saved a newer login after this one refreshed
    // with the old token. Keep that login.
    const saved = await this.store.loadTokens(this.serverName);
    if (saved?.refresh_token !== undefined && saved.refresh_token === this.rejectedRefreshToken) {
      await this.store.deleteLogin(this.serverName);
    }
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
    if (this.startingLogin) {
      return undefined;
    }
    return this.store.loadTokens(this.serverName);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.saveTokens(this.serverName, tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.startingLogin) {
      await this.startCallbackPage();
      this.loginUrl = authorizationUrl.toString();
      return;
    }
    if (this.options.loginMode === "never") {
      throw new NeedsLoginError(this.serverName);
    }
    await this.startCallbackPage();
    await this.askFirst(authorizationUrl);
  }

  private async startCallbackPage(): Promise<void> {
    if (this.callbackServer) {
      await this.callbackServer.stop();
    }
    this.callbackServer = new CallbackServer({
      port: this.options.port,
      timeoutMs: this.options.timeoutMs,
      state: this.lastState ?? this.state(),
    });
    await this.callbackServer.start();
  }

  /** The 0.0.5 login: hand the URL to onOAuthRequired, or open the browser. */
  private async askFirst(authorizationUrl: URL): Promise<void> {
    let resolveComplete: () => void;
    let rejectComplete: (err: Error) => void;
    const completePromise = new Promise<void>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    // Drops the rejection only when the callback never awaits `complete`.
    completePromise.catch(() => {});

    this.callbackServer!.waitForCode()
      .then(() => resolveComplete())
      .catch((err) => rejectComplete(err));

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
      const server = this.callbackServer;
      this.callbackServer = null;
      await server.stop();
    }
    await this.store.deleteCodeVerifier(this.serverName);
  }
}
