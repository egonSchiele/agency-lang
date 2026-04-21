# MCP OAuth Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OAuth 2.1 authentication and static header support for HTTP-based MCP servers, so users can connect to OAuth-protected MCP servers (GitHub, Google, etc.) with a single config change.

**Architecture:** OAuth logic is strictly encapsulated behind two classes: `AgencyOAuthProvider` (implements the MCP SDK's `OAuthClientProvider` — owns tokens, PKCE, browser, callback server) and `OAuthConnector` (owns the two-phase connect/retry flow). `McpConnection` does not know OAuth exists — it receives a pre-connected `{client, transport}` pair from `OAuthConnector`, or builds its own transport for non-OAuth paths. `McpManager` uses a factory function to create connectors and never touches `AgencyOAuthProvider` directly. All instance variables are private; functionality is exposed via methods.

**Tech Stack:** `@modelcontextprotocol/sdk` (already installed — provides `OAuthClientProvider` interface, `UnauthorizedError`, `StreamableHTTPClientTransport.finishAuth()`), macOS `open` command (no npm dep), Zod (config validation), vitest (testing)

**Spec:** `docs/superpowers/specs/2026-04-20-mcp-oauth-design.md`

**Key MCP SDK auth types (from `@modelcontextprotocol/sdk`):**
- `OAuthClientProvider` interface (`sdk/client/auth.js`) — provider passed to `StreamableHTTPClientTransport`
- `UnauthorizedError` (`sdk/client/auth.js`) — thrown by `connect()` when auth is needed
- `StreamableHTTPClientTransport.finishAuth(code)` — called after user authorizes in browser
- `OAuthTokens` — `{ access_token, token_type, expires_in?, refresh_token?, scope? }`
- `OAuthClientMetadata` — `{ redirect_uris, client_name?, scope?, ... }`
- `OAuthClientInformationMixed` — client registration info (client_id, etc.)

**Encapsulation boundaries:**

```
McpManager (orchestrator — creates connections, caches tools)
  → createOAuthConnector() factory (one place that knows how to build OAuth)
  → McpConnection (NO OAuth knowledge — connects via transport or connector)

OAuthConnector (owns the two-phase connect/retry flow)
  → connect(): Promise<{client, transport}> — the ONE public method
  → AgencyOAuthProvider (implements OAuthClientProvider)
  → StreamableHTTPClientTransport, Client

AgencyOAuthProvider (owns tokens, browser, callback)
  → TokenStore (disk persistence)
  → CallbackServer (localhost redirect handler)
```

**What each class does NOT know:**
- `McpConnection`: does not import `UnauthorizedError`, `AgencyOAuthProvider`, `OAuthConnector` types, `TokenStore`, or `CallbackServer`
- `McpManager`: does not import `AgencyOAuthProvider`, `TokenStore`, or `CallbackServer`
- `OAuthConnector`: does not know about `McpConnection` or `McpManager`
- `AgencyOAuthProvider`: does not know about `McpConnection`, `McpManager`, or `OAuthConnector`

---

### Task 1: Add `openUrl` to the stdlib (already done)

The `_openUrl` function has been added to `stdlib/lib/system.ts` and exposed as `openUrl` in `stdlib/system.agency`. It uses the macOS `open` command (no npm dependency). Cross-platform support can be added later. The OAuth provider inlines the same `execFile("open", [url])` call to avoid cross-tsconfig imports.

**Files (already modified):**
- `stdlib/lib/system.ts` — added `_openUrl(url: string): Promise<void>`
- `stdlib/system.agency` — added `export def openUrl(url: string): Result`
- `stdlib/lib/__tests__/system-openUrl.test.ts` — tests

This task is complete. Run `make stdlib` if needed, then proceed.

---

### Task 2: Token store

Handles reading, writing, and deleting OAuth tokens and client registration info on disk. Uses atomic writes and restrictive file permissions. All fields are private.

**Files:**
- Create: `lib/runtime/mcp/tokenStore.ts`
- Create: `lib/runtime/mcp/tokenStore.test.ts`

- [ ] **Step 1: Write the tests**

Create `lib/runtime/mcp/tokenStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TokenStore } from "./tokenStore.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("TokenStore", () => {
  let store: TokenStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-token-test-"));
    store = new TokenStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return undefined when no tokens exist", async () => {
    const tokens = await store.loadTokens("github");
    expect(tokens).toBeUndefined();
  });

  it("should save and load tokens", async () => {
    const tokens = { access_token: "abc", token_type: "bearer" };
    await store.saveTokens("github", tokens);
    const loaded = await store.loadTokens("github");
    expect(loaded).toEqual(tokens);
  });

  it("should overwrite existing tokens", async () => {
    await store.saveTokens("github", { access_token: "old", token_type: "bearer" });
    await store.saveTokens("github", { access_token: "new", token_type: "bearer" });
    const loaded = await store.loadTokens("github");
    expect(loaded?.access_token).toBe("new");
  });

  it("should delete tokens", async () => {
    await store.saveTokens("github", { access_token: "abc", token_type: "bearer" });
    await store.deleteTokens("github");
    const loaded = await store.loadTokens("github");
    expect(loaded).toBeUndefined();
  });

  it("should save and load PKCE code verifier", async () => {
    await store.saveCodeVerifier("github", "verifier123");
    const loaded = await store.loadCodeVerifier("github");
    expect(loaded).toBe("verifier123");
  });

  it("should delete PKCE code verifier", async () => {
    await store.saveCodeVerifier("github", "verifier123");
    await store.deleteCodeVerifier("github");
    const loaded = await store.loadCodeVerifier("github");
    expect(loaded).toBeUndefined();
  });

  it("should save and load client info", async () => {
    const info = { client_id: "my-client", client_secret: "secret" };
    await store.saveClientInfo("github", info);
    const loaded = await store.loadClientInfo("github");
    expect(loaded).toEqual(info);
  });

  it("should list stored server names", async () => {
    await store.saveTokens("github", { access_token: "a", token_type: "bearer" });
    await store.saveTokens("slack", { access_token: "b", token_type: "bearer" });
    const names = await store.listServers();
    expect(names.sort()).toEqual(["github", "slack"]);
  });

  it("should set file permissions to 0600", async () => {
    await store.saveTokens("github", { access_token: "abc", token_type: "bearer" });
    const filePath = path.join(tmpDir, "github.json");
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/runtime/mcp/tokenStore.test.ts`
Expected: FAIL — `tokenStore.js` doesn't exist

- [ ] **Step 3: Implement TokenStore**

Create `lib/runtime/mcp/tokenStore.ts`:

```ts
import fs from "fs";
import path from "path";
import os from "os";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";

const DEFAULT_TOKEN_DIR = path.join(os.homedir(), ".agency", "tokens");

export class TokenStore {
  private dir: string;

  constructor(dir: string = DEFAULT_TOKEN_DIR) {
    this.dir = dir;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  private tokenPath(serverName: string): string {
    return path.join(this.dir, `${serverName}.json`);
  }

  private verifierPath(serverName: string): string {
    return path.join(this.dir, `${serverName}.verifier`);
  }

  private clientInfoPath(serverName: string): string {
    return path.join(this.dir, `${serverName}.client.json`);
  }

  private atomicWrite(filePath: string, data: string): void {
    this.ensureDir();
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  }

  private readJson(filePath: string): any | undefined {
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  async saveTokens(serverName: string, tokens: OAuthTokens): Promise<void> {
    this.atomicWrite(this.tokenPath(serverName), JSON.stringify(tokens));
  }

  async loadTokens(serverName: string): Promise<OAuthTokens | undefined> {
    return this.readJson(this.tokenPath(serverName));
  }

  async deleteTokens(serverName: string): Promise<void> {
    const p = this.tokenPath(serverName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    await this.deleteCodeVerifier(serverName);
    await this.deleteClientInfo(serverName);
  }

  async saveCodeVerifier(serverName: string, verifier: string): Promise<void> {
    this.atomicWrite(this.verifierPath(serverName), verifier);
  }

  async loadCodeVerifier(serverName: string): Promise<string | undefined> {
    try {
      return fs.readFileSync(this.verifierPath(serverName), "utf-8");
    } catch {
      return undefined;
    }
  }

  async deleteCodeVerifier(serverName: string): Promise<void> {
    const p = this.verifierPath(serverName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async saveClientInfo(serverName: string, info: OAuthClientInformationMixed): Promise<void> {
    this.atomicWrite(this.clientInfoPath(serverName), JSON.stringify(info));
  }

  async loadClientInfo(serverName: string): Promise<OAuthClientInformationMixed | undefined> {
    return this.readJson(this.clientInfoPath(serverName));
  }

  async deleteClientInfo(serverName: string): Promise<void> {
    const p = this.clientInfoPath(serverName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async listServers(): Promise<string[]> {
    try {
      const files = fs.readdirSync(this.dir);
      return files
        .filter((f) => f.endsWith(".json") && !f.endsWith(".client.json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm vitest run lib/runtime/mcp/tokenStore.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/mcp/tokenStore.ts lib/runtime/mcp/tokenStore.test.ts
git commit -m "feat: add TokenStore for MCP OAuth token persistence"
```

---

### Task 3: Callback server

A temporary localhost HTTP server that listens for the OAuth redirect callback. All fields are private. The only public methods are `start()`, `waitForCode()`, and `stop()`. The `state` getter is read-only.

**Files:**
- Create: `lib/runtime/mcp/callbackServer.ts`
- Create: `lib/runtime/mcp/callbackServer.test.ts`

- [ ] **Step 1: Write the tests**

Create `lib/runtime/mcp/callbackServer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CallbackServer } from "./callbackServer.js";

describe("CallbackServer", () => {
  it("should start on an available port and return a URL", async () => {
    const server = new CallbackServer();
    const url = await server.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    await server.stop();
  });

  it("should resolve with the authorization code when callback is received", async () => {
    const server = new CallbackServer();
    const url = await server.start();
    const state = server.state;

    const callbackUrl = `${url}?code=auth-code-123&state=${state}`;
    const response = await fetch(callbackUrl);
    expect(response.ok).toBe(true);

    const code = await server.waitForCode();
    expect(code).toBe("auth-code-123");

    await server.stop();
  });

  it("should reject when state parameter doesn't match", async () => {
    const server = new CallbackServer();
    const url = await server.start();

    const callbackUrl = `${url}?code=auth-code-123&state=wrong-state`;
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(403);

    await server.stop();
  });

  it("should reject when code is missing", async () => {
    const server = new CallbackServer();
    const url = await server.start();
    const state = server.state;

    const callbackUrl = `${url}?state=${state}`;
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(400);

    await server.stop();
  });

  it("should time out if no callback is received", async () => {
    const server = new CallbackServer({ timeoutMs: 200 });
    await server.start();

    await expect(server.waitForCode()).rejects.toThrow(/timed out/i);

    await server.stop();
  });

  it("should stop cleanly even if no callback was received", async () => {
    const server = new CallbackServer();
    await server.start();
    await server.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/runtime/mcp/callbackServer.test.ts`
Expected: FAIL — `callbackServer.js` doesn't exist

- [ ] **Step 3: Implement CallbackServer**

Create `lib/runtime/mcp/callbackServer.ts`:

```ts
import http from "http";
import { randomBytes } from "crypto";

const SUCCESS_HTML = `<!DOCTYPE html><html><body><h1>Authorization successful</h1><p>You can close this tab and return to your terminal.</p></body></html>`;
const ERROR_HTML = `<!DOCTYPE html><html><body><h1>Authorization failed</h1><p>Please try again.</p></body></html>`;

export type CallbackServerOptions = {
  timeoutMs?: number; // default 300000 (5 minutes)
};

export class CallbackServer {
  private server: http.Server | null = null;
  private port = 0;
  private _state: string;
  private timeoutMs: number;
  private codePromise: Promise<string>;
  private resolveCode!: (code: string) => void;
  private rejectCode!: (err: Error) => void;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: CallbackServerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this._state = randomBytes(32).toString("hex");
    this.codePromise = new Promise<string>((resolve, reject) => {
      this.resolveCode = resolve;
      this.rejectCode = reject;
    });
  }

  get state(): string {
    return this._state;
  }

  get callbackUrl(): string {
    return `http://127.0.0.1:${this.port}/oauth/callback`;
  }

  async start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);

        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (state !== this._state) {
          res.writeHead(403, { "Content-Type": "text/html" });
          res.end(ERROR_HTML);
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(ERROR_HTML);
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        this.resolveCode(code);
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve(this.callbackUrl);
      });

      this.server.on("error", reject);

      this.timeoutHandle = setTimeout(() => {
        this.rejectCode(new Error("OAuth callback timed out"));
      }, this.timeoutMs);
    });
  }

  async waitForCode(): Promise<string> {
    return this.codePromise;
  }

  async stop(): Promise<void> {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        this.server = null;
      });
    }
  }
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm vitest run lib/runtime/mcp/callbackServer.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/mcp/callbackServer.ts lib/runtime/mcp/callbackServer.test.ts
git commit -m "feat: add CallbackServer for MCP OAuth redirect handling"
```

---

### Task 4: OAuth provider

Implements the MCP SDK's `OAuthClientProvider` interface. All fields are private. The only public surface is what `OAuthClientProvider` requires, plus `prepare()`, `waitForAuthCode()`, and `cleanup()`.

**Files:**
- Create: `lib/runtime/mcp/oauthProvider.ts`
- Create: `lib/runtime/mcp/oauthProvider.test.ts`

**Context:** The MCP SDK's `StreamableHTTPClientTransport` constructor accepts `{ authProvider?: OAuthClientProvider }`. When the server requires auth:
1. The SDK calls `authProvider.tokens()` to check for existing tokens
2. If no tokens / expired, the SDK calls `authProvider.redirectToAuthorization(url)` — our implementation opens the browser
3. The SDK throws `UnauthorizedError` from `connect()`
4. The caller catches it, waits for the callback code via `provider.waitForAuthCode()`, and calls `transport.finishAuth(code)`
5. The SDK calls `authProvider.saveTokens()` with the new tokens
6. The caller retries `connect()`

- [ ] **Step 1: Write the tests**

Create `lib/runtime/mcp/oauthProvider.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgencyOAuthProvider } from "./oauthProvider.js";
import { TokenStore } from "./tokenStore.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("AgencyOAuthProvider", () => {
  let tmpDir: string;
  let store: TokenStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-oauth-test-"));
    store = new TokenStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return undefined tokens when none are stored", async () => {
    const provider = new AgencyOAuthProvider("github", "https://example.com/mcp", store);
    const tokens = await provider.tokens();
    expect(tokens).toBeUndefined();
  });

  it("should return stored tokens", async () => {
    const savedTokens = { access_token: "abc", token_type: "bearer" };
    await store.saveTokens("github", savedTokens);

    const provider = new AgencyOAuthProvider("github", "https://example.com/mcp", store);
    const tokens = await provider.tokens();
    expect(tokens).toEqual(savedTokens);
  });

  it("should save tokens via saveTokens", async () => {
    const provider = new AgencyOAuthProvider("github", "https://example.com/mcp", store);
    const tokens = { access_token: "new-token", token_type: "bearer" };
    await provider.saveTokens(tokens);

    const loaded = await store.loadTokens("github");
    expect(loaded).toEqual(tokens);
  });

  it("should save and load code verifier", async () => {
    const provider = new AgencyOAuthProvider("github", "https://example.com/mcp", store);
    await provider.saveCodeVerifier("verifier-abc");
    const loaded = await provider.codeVerifier();
    expect(loaded).toBe("verifier-abc");
  });

  it("should save and load client info", async () => {
    const provider = new AgencyOAuthProvider("github", "https://example.com/mcp", store);
    const info = { client_id: "my-id", client_secret: "secret" };
    await provider.saveClientInformation(info);
    const loaded = await provider.clientInformation();
    expect(loaded).toEqual(info);
  });

  it("should have correct client metadata", () => {
    const provider = new AgencyOAuthProvider("github", "https://example.com/mcp", store);
    const meta = provider.clientMetadata;
    expect(meta.client_name).toBe("agency-github");
    expect(meta.redirect_uris).toBeDefined();
  });

  it("should have a real redirectUrl after prepare()", async () => {
    const provider = new AgencyOAuthProvider("github", "https://example.com/mcp", store);
    await provider.prepare();
    expect(provider.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(provider.redirectUrl).not.toContain(":0/");
    await provider.cleanup();
  });

  it("should call onOAuthRequired callback instead of opening browser when provided", async () => {
    const onOAuthRequired = vi.fn();
    const provider = new AgencyOAuthProvider("github", "https://example.com/mcp", store, {
      onOAuthRequired,
    });

    const authUrl = new URL("https://example.com/authorize?code=123");
    await provider.redirectToAuthorization(authUrl);

    expect(onOAuthRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "github",
        authUrl: authUrl.toString(),
      }),
    );
  });

  it("should expose waitForAuthCode() that resolves when callback arrives", async () => {
    const provider = new AgencyOAuthProvider("github", "https://example.com/mcp", store);
    await provider.prepare();

    // Simulate callback arriving
    const callbackUrl = provider.redirectUrl;
    const state = provider.state;
    // Fire the callback in the background
    const codePromise = provider.waitForAuthCode();
    await fetch(`${callbackUrl}?code=test-code&state=${state}`);
    const code = await codePromise;
    expect(code).toBe("test-code");

    await provider.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/runtime/mcp/oauthProvider.test.ts`
Expected: FAIL — `oauthProvider.js` doesn't exist

- [ ] **Step 3: Implement AgencyOAuthProvider**

Create `lib/runtime/mcp/oauthProvider.ts`:

```ts
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

/** Open a URL in the default browser. macOS-only for now. */
async function openInBrowser(url: string): Promise<void> {
  await execFileAsync("open", [url]);
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
};

export class AgencyOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private serverUrl: string;
  private store: TokenStore;
  private options: OAuthProviderOptions;
  private callbackServer: CallbackServer | null = null;
  private _callbackUrl: string | null = null;

  constructor(
    serverName: string,
    serverUrl: string,
    store: TokenStore,
    options: OAuthProviderOptions = {},
  ) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
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

  get state(): string {
    if (!this.callbackServer) {
      throw new Error(`OAuth flow for "${this.serverName}" not started — call prepare() first`);
    }
    return this.callbackServer.state;
  }

  get redirectUrl(): string {
    // After prepare(), this is the real localhost URL with actual port.
    return this._callbackUrl ?? "http://127.0.0.1:0/oauth/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [new URL(this.redirectUrl)],
      client_name: `agency-${this.serverName}`,
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.store.loadClientInfo(this.serverName);
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
          this.cleanup();
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
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm vitest run lib/runtime/mcp/oauthProvider.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/mcp/oauthProvider.ts lib/runtime/mcp/oauthProvider.test.ts
git commit -m "feat: add AgencyOAuthProvider implementing MCP SDK OAuthClientProvider"
```

---

### Task 5: OAuthConnector

Encapsulates the entire two-phase OAuth connect flow. This is the ONLY class that knows about `UnauthorizedError`, `finishAuth()`, and the retry logic. All fields are private. The only public method is `connect()`, which returns a connected `{client, transport}` pair.

**Files:**
- Create: `lib/runtime/mcp/oauthConnector.ts`
- Create: `lib/runtime/mcp/oauthConnector.test.ts`

- [ ] **Step 1: Write the tests**

Create `lib/runtime/mcp/oauthConnector.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { OAuthConnector } from "./oauthConnector.js";
import { TokenStore } from "./tokenStore.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("OAuthConnector", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should construct with server name, url, and token store", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-connector-test-"));
    const store = new TokenStore(tmpDir);
    const connector = new OAuthConnector("github", "https://example.com/mcp", store);
    expect(connector).toBeDefined();
  });

  it("should return a failure-path error when server is unreachable", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-connector-test-"));
    const store = new TokenStore(tmpDir);
    const connector = new OAuthConnector("test", "http://127.0.0.1:1/nonexistent", store);

    // connect() should throw since the server is unreachable
    await expect(connector.connect()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/runtime/mcp/oauthConnector.test.ts`
Expected: FAIL — `oauthConnector.js` doesn't exist

- [ ] **Step 3: Implement OAuthConnector**

Create `lib/runtime/mcp/oauthConnector.ts`:

```ts
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
    this.provider = new AgencyOAuthProvider(serverName, url, tokenStore, options);
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

        // Create fresh client/transport for retry — the SDK may not support
        // reusing a Client/transport after an UnauthorizedError.
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
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm vitest run lib/runtime/mcp/oauthConnector.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/mcp/oauthConnector.ts lib/runtime/mcp/oauthConnector.test.ts
git commit -m "feat: add OAuthConnector encapsulating two-phase MCP OAuth flow"
```

---

### Task 6: Extend config types and validation

Add `auth`, `authTimeout`, and `headers` fields to HTTP server config, with mutual exclusion validation.

**Files:**
- Modify: `lib/runtime/mcp/types.ts`
- Modify: `lib/config.ts`
- Modify: `lib/config.test.ts`

- [ ] **Step 1: Write the new config validation tests**

Add to `lib/config.test.ts` (inside the existing `describe("AgencyConfigSchema")` block):

```ts
it("should accept HTTP server with auth: oauth", () => {
  const result = AgencyConfigSchema.safeParse({
    mcpServers: {
      github: { type: "http", url: "https://github-mcp.example.com/mcp", auth: "oauth" },
    },
  });
  expect(result.success).toBe(true);
});

it("should accept HTTP server with headers", () => {
  const result = AgencyConfigSchema.safeParse({
    mcpServers: {
      weather: {
        type: "http",
        url: "https://weather.example.com/mcp",
        headers: { "Authorization": "Bearer ${WEATHER_KEY}" },
      },
    },
  });
  expect(result.success).toBe(true);
});

it("should accept HTTP server with authTimeout", () => {
  const result = AgencyConfigSchema.safeParse({
    mcpServers: {
      github: {
        type: "http",
        url: "https://github-mcp.example.com/mcp",
        auth: "oauth",
        authTimeout: 120000,
      },
    },
  });
  expect(result.success).toBe(true);
});

it("should reject HTTP server with both auth and headers", () => {
  const result = AgencyConfigSchema.safeParse({
    mcpServers: {
      github: {
        type: "http",
        url: "https://example.com/mcp",
        auth: "oauth",
        headers: { "Authorization": "Bearer token" },
      },
    },
  });
  expect(result.success).toBe(false);
});

it("should reject authTimeout without auth: oauth", () => {
  const result = AgencyConfigSchema.safeParse({
    mcpServers: {
      github: {
        type: "http",
        url: "https://example.com/mcp",
        authTimeout: 120000,
      },
    },
  });
  expect(result.success).toBe(false);
});

it("should reject auth on stdio server", () => {
  const result = AgencyConfigSchema.safeParse({
    mcpServers: {
      local: {
        command: "npx",
        args: ["some-server"],
        auth: "oauth",
      },
    },
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify the new tests fail**

Run: `pnpm vitest run lib/config.test.ts`
Expected: New tests FAIL (existing tests still pass)

- [ ] **Step 3: Update the types**

In `lib/runtime/mcp/types.ts`, update `McpHttpServerConfig`:

```ts
export type McpHttpServerConfig = {
  type: "http";
  url: string;
  auth?: "oauth";
  authTimeout?: number;
  headers?: Record<string, string>;
};
```

- [ ] **Step 4: Update the Zod schema**

In `lib/config.ts`, replace `McpHttpServerSchema`:

```ts
const McpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  auth: z.literal("oauth").optional(),
  authTimeout: z.number().optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).strict();

const McpServerSchema = z.union([MccStdioServerSchema, McpHttpServerSchema]);
```

Then chain `.superRefine()` on `AgencyConfigSchema` for cross-field validation. The existing schema chains `.partial().passthrough()`. Preserve that and append `.superRefine(...)`:

```ts
export const AgencyConfigSchema = z.object({
  // ... existing fields ...
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
  // ... existing fields ...
}).partial().passthrough().superRefine((data, ctx) => {
  if (!data.mcpServers) return;
  for (const [name, server] of Object.entries(data.mcpServers)) {
    if ("type" in server && server.type === "http") {
      const httpServer = server as z.infer<typeof McpHttpServerSchema>;
      if (httpServer.auth && httpServer.headers) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `MCP server "${name}": cannot specify both 'auth' and 'headers'`,
          path: ["mcpServers", name],
        });
      }
      if (httpServer.authTimeout && httpServer.auth !== "oauth") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `MCP server "${name}": 'authTimeout' requires 'auth: "oauth"'`,
          path: ["mcpServers", name],
        });
      }
    }
  }
});
```

This keeps `McpHttpServerSchema` as a plain `ZodObject` (no `ZodEffects`), so `z.union` works.

- [ ] **Step 5: Run tests and verify they pass**

Run: `pnpm vitest run lib/config.test.ts`
Expected: All tests PASS (both old and new)

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/mcp/types.ts lib/config.ts lib/config.test.ts
git commit -m "feat: add auth, headers, authTimeout to MCP HTTP server config"
```

---

### Task 7: Static headers and OAuth connector in McpConnection

Add env var interpolation for `headers` config. Add support for receiving a pre-connected `{client, transport}` from `OAuthConnector`. **McpConnection does NOT import any OAuth types.**

**Files:**
- Modify: `lib/runtime/mcp/mcpConnection.ts`
- Modify: `lib/runtime/mcp/mcpConnection.test.ts`

- [ ] **Step 1: Write the tests**

Add to `lib/runtime/mcp/mcpConnection.test.ts`:

```ts
import { interpolateEnvVars } from "./mcpConnection.js";

describe("interpolateEnvVars", () => {
  it("should replace ${VAR} with env values", () => {
    const original = process.env.TEST_VAR_ABC;
    process.env.TEST_VAR_ABC = "hello";
    try {
      const result = interpolateEnvVars({ "Authorization": "Bearer ${TEST_VAR_ABC}" });
      expect(result["Authorization"]).toBe("Bearer hello");
    } finally {
      if (original === undefined) delete process.env.TEST_VAR_ABC;
      else process.env.TEST_VAR_ABC = original;
    }
  });

  it("should throw if env var is not set", () => {
    delete process.env.NONEXISTENT_VAR_XYZ;
    expect(() =>
      interpolateEnvVars({ "Authorization": "Bearer ${NONEXISTENT_VAR_XYZ}" }),
    ).toThrow(/NONEXISTENT_VAR_XYZ/);
  });

  it("should pass through headers without env vars unchanged", () => {
    const result = interpolateEnvVars({ "X-Custom": "static-value" });
    expect(result["X-Custom"]).toBe("static-value");
  });

  it("should reject values containing newlines (CRLF injection)", () => {
    const original = process.env.TEST_CRLF_VAR;
    process.env.TEST_CRLF_VAR = "token\r\nX-Injected: evil";
    try {
      expect(() =>
        interpolateEnvVars({ "Authorization": "Bearer ${TEST_CRLF_VAR}" }),
      ).toThrow(/newline/i);
    } finally {
      if (original === undefined) delete process.env.TEST_CRLF_VAR;
      else process.env.TEST_CRLF_VAR = original;
    }
  });

  it("should reject values containing bare \\n (LF injection)", () => {
    const original = process.env.TEST_LF_VAR;
    process.env.TEST_LF_VAR = "token\nX-Injected: evil";
    try {
      expect(() =>
        interpolateEnvVars({ "Authorization": "Bearer ${TEST_LF_VAR}" }),
      ).toThrow(/newline/i);
    } finally {
      if (original === undefined) delete process.env.TEST_LF_VAR;
      else process.env.TEST_LF_VAR = original;
    }
  });
});

describe("McpConnection with connector", () => {
  it("should accept a connector function option", () => {
    const conn = new McpConnection("test", {
      type: "http",
      url: "https://example.com/mcp",
      auth: "oauth",
    }, {
      connector: async () => {
        throw new Error("mock connector");
      },
    });
    expect(conn).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/runtime/mcp/mcpConnection.test.ts`
Expected: FAIL — `interpolateEnvVars` not exported, connector not accepted

- [ ] **Step 3: Implement**

Replace the full contents of `lib/runtime/mcp/mcpConnection.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpStdioServerConfig, McpHttpServerConfig, McpTool } from "./types.js";

export function interpolateEnvVars(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        throw new Error(
          `Environment variable "${varName}" is not set (referenced in MCP server headers)`,
        );
      }
      return envValue;
    });
    // Guard against CRLF injection: env var values containing \r or \n
    // could inject additional HTTP headers.
    if (/[\r\n]/.test(result[key])) {
      throw new Error(
        `Header "${key}" contains illegal newline characters after environment variable interpolation (possible CRLF injection)`,
      );
    }
  }
  return result;
}

/**
 * A function that returns a connected {client, transport} pair.
 * Used by OAuthConnector to provide pre-authenticated connections.
 * McpConnection does NOT know what this function does internally.
 */
export type ConnectorFn = () => Promise<{ client: Client; transport: any }>;

export type McpConnectionOptions = {
  /** Opaque connector function that returns a connected client+transport. */
  connector?: ConnectorFn;
};

export class McpConnection {
  private client: Client;
  private serverName: string;
  private config: McpServerConfig;
  private tools: McpTool[] = [];
  private connected = false;
  private connector: ConnectorFn | undefined;

  constructor(serverName: string, config: McpServerConfig, options: McpConnectionOptions = {}) {
    this.serverName = serverName;
    this.config = config;
    this.connector = options.connector;
    this.client = new Client({
      name: "agency-lang",
      version: "1.0.0",
    });
  }

  async connect(): Promise<void> {
    if (this.connector) {
      // Delegate entirely to the connector (e.g. OAuthConnector).
      // McpConnection doesn't know what happens inside.
      const result = await this.connector();
      this.client = result.client;
    } else {
      // Build transport directly (stdio or plain HTTP with optional headers)
      let transport;
      if ("type" in this.config && this.config.type === "http") {
        const httpConfig = this.config as McpHttpServerConfig;
        const opts: Record<string, any> = {};
        if (httpConfig.headers) {
          const headers = interpolateEnvVars(httpConfig.headers);
          opts.requestInit = { headers };
        }
        transport = new StreamableHTTPClientTransport(new URL(httpConfig.url), opts);
      } else {
        const stdio = this.config as McpStdioServerConfig;
        transport = new StdioClientTransport({
          command: stdio.command,
          args: stdio.args,
          env: stdio.env,
        });
      }
      await this.client.connect(transport);
    }

    this.connected = true;

    const result = await this.client.listTools();
    this.tools = (result.tools || []).map((tool) => ({
      name: `${this.serverName}__${tool.name}`,
      description: tool.description || "",
      serverName: this.serverName,
      inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
      __mcpTool: true as const,
    }));
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.client.callTool({ name: toolName, arguments: args });
    const textParts = (result.content as any[])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    return textParts.join("\n");
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
```

Note: `McpConnection` imports **zero** OAuth-related modules. It takes an opaque `ConnectorFn` that returns `{client, transport}`. It doesn't know or care whether OAuth happened.

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm vitest run lib/runtime/mcp/mcpConnection.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/mcp/mcpConnection.ts lib/runtime/mcp/mcpConnection.test.ts
git commit -m "feat: add static headers and connector support to McpConnection"
```

---

### Task 8: Wire OAuth into McpManager via factory

`McpManager` creates `OAuthConnector` instances for OAuth servers and passes their `connect()` method as the `ConnectorFn` to `McpConnection`. `McpManager` never touches `AgencyOAuthProvider`, `TokenStore`, or `CallbackServer` directly — it only imports `OAuthConnector`.

**Files:**
- Modify: `lib/runtime/mcp/mcpManager.ts`
- Modify: `lib/runtime/mcp/mcpManager.test.ts`

- [ ] **Step 1: Write the tests**

Add `fs` and `os` to the existing imports at the top of `lib/runtime/mcp/mcpManager.test.ts` (the file already imports `path`):

```ts
import fs from "fs";
import os from "os";
```

Then add a new describe block:

```ts
describe("McpManager OAuth config", () => {
  it("should accept onOAuthRequired callback", () => {
    const manager = new McpManager(
      {
        github: { type: "http" as const, url: "https://example.com/mcp", auth: "oauth" as const },
      },
      { onOAuthRequired: () => {} },
    );
    expect(manager).toBeDefined();
  });

  it("should accept a custom tokenStoreDir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-mgr-test-"));
    try {
      const manager = new McpManager(
        { github: { type: "http" as const, url: "https://example.com/mcp", auth: "oauth" as const } },
        { tokenStoreDir: tmpDir },
      );
      expect(manager).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return a failure when OAuth server is unreachable", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-mgr-test-"));
    try {
      const manager = new McpManager(
        {
          test: {
            type: "http" as const,
            url: "http://127.0.0.1:1/nonexistent",
            auth: "oauth" as const,
          },
        },
        { tokenStoreDir: tmpDir },
      );
      const result = await manager.getTools("test");
      expect(result.success).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should deduplicate concurrent getTools calls for the same server", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-mgr-test-"));
    try {
      const manager = new McpManager(
        {
          test: {
            type: "http" as const,
            url: "http://127.0.0.1:1/nonexistent",
            auth: "oauth" as const,
          },
        },
        { tokenStoreDir: tmpDir },
      );
      const [result1, result2] = await Promise.all([
        manager.getTools("test"),
        manager.getTools("test"),
      ]);
      expect(result1.success).toBe(false);
      expect(result2.success).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/runtime/mcp/mcpManager.test.ts`
Expected: FAIL — `McpManager` doesn't accept a second argument

- [ ] **Step 3: Update McpManager**

Replace the full contents of `lib/runtime/mcp/mcpManager.ts`:

```ts
import { McpConnection } from "./mcpConnection.js";
import { OAuthConnector } from "./oauthConnector.js";
import { TokenStore } from "./tokenStore.js";
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
    const isOAuth =
      "type" in serverConfig &&
      serverConfig.type === "http" &&
      (serverConfig as McpHttpServerConfig).auth === "oauth";

    if (isOAuth) {
      const httpConfig = serverConfig as McpHttpServerConfig;
      const connector = new OAuthConnector(serverName, httpConfig.url, this.tokenStore, {
        onOAuthRequired: this.onOAuthRequired,
        timeoutMs: httpConfig.authTimeout,
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
    if (this.connectPromises[serverName]) {
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
    const conns = Object.values(this.connections);
    if (conns.length === 0) return;
    await Promise.all(conns.map((conn) => conn.disconnect().catch(() => {})));
    this.connections = {};
    this.toolCache = {};
  }
}
```

Note: `McpManager` imports `OAuthConnector` and `TokenStore` but does NOT import `AgencyOAuthProvider`, `CallbackServer`, or any MCP SDK auth types. It passes `connector.connect()` as an opaque function.

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm vitest run lib/runtime/mcp/mcpManager.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/mcp/mcpManager.ts lib/runtime/mcp/mcpManager.test.ts
git commit -m "feat: wire OAuthConnector into McpManager via factory pattern"
```

---

### Task 9: Thread onOAuthRequired callback from RuntimeContext

`McpManager` is created in `RuntimeContext.createMcpManager()`, which is called from generated code. The lifecycle callbacks need to flow from the caller through to `McpManager`.

**Files:**
- Modify: `lib/runtime/state/context.ts`
- Modify: `lib/runtime/hooks.ts`
- Modify: `lib/types/function.ts`

- [ ] **Step 1: Add `onOAuthRequired` to the callback types**

In `lib/types/function.ts`, add to `VALID_CALLBACK_NAMES`:

```ts
export const VALID_CALLBACK_NAMES = [
  "onAgentStart",
  "onAgentEnd",
  "onNodeStart",
  "onNodeEnd",
  "onLLMCallStart",
  "onLLMCallEnd",
  "onFunctionStart",
  "onFunctionEnd",
  "onToolCallStart",
  "onToolCallEnd",
  "onStream",
  "onTrace",
  "onOAuthRequired",
] as const;
```

In `lib/runtime/hooks.ts`, add the new callback type to `CallbackMap`:

```ts
onOAuthRequired: {
  serverName: string;
  authUrl: string;
  complete: Promise<void>;
  cancel: () => void;
};
```

- [ ] **Step 2: Update `createMcpManager` to pass the callback**

In `lib/runtime/state/context.ts`, update `createMcpManager`:

```ts
createMcpManager(config: Record<string, any>): void {
  const onOAuthRequired = this._registeredCallbacks.onOAuthRequired as
    | ((data: any) => void | Promise<void>)
    | undefined;
  this._mcpManager = new McpManager(config, { onOAuthRequired });
}
```

- [ ] **Step 3: Run existing tests to make sure nothing broke**

Run: `pnpm vitest run lib/runtime/mcp/`
Expected: All existing MCP tests PASS

Run: `pnpm vitest run lib/config.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add lib/types/function.ts lib/runtime/hooks.ts lib/runtime/state/context.ts
git commit -m "feat: thread onOAuthRequired lifecycle callback to McpManager"
```

---

### Task 10: CLI `agency auth` command

Adds `agency auth <server>`, `agency auth --list`, and `agency auth --revoke <server>` commands for managing OAuth tokens.

**Files:**
- Create: `lib/cli/auth.ts`
- Modify: `scripts/agency.ts`

- [ ] **Step 1: Implement the auth CLI module**

Create `lib/cli/auth.ts`:

```ts
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
```

Note: `auth.ts` only imports `OAuthConnector` and `TokenStore`. It does not import `AgencyOAuthProvider` or `CallbackServer`.

- [ ] **Step 2: Register the CLI command**

In `scripts/agency.ts`, add the import:

```ts
import { authServer, listAuth, revokeAuth } from "@/cli/auth.js";
```

Then add the command:

```ts
program
  .command("auth [server-name]")
  .description("Manage OAuth tokens for MCP servers")
  .option("--list", "List all stored OAuth tokens")
  .option("--revoke <server>", "Remove stored OAuth token for a server")
  .action(async (serverName: string | undefined, opts: { list?: boolean; revoke?: string }) => {
    if (opts.list) {
      await listAuth();
    } else if (opts.revoke) {
      await revokeAuth(opts.revoke);
    } else if (serverName) {
      const config = loadConfig();
      await authServer(serverName, config);
    } else {
      console.error("Usage: agency auth <server-name> | --list | --revoke <server-name>");
      process.exit(1);
    }
  });
```

- [ ] **Step 3: Build and verify the command registers**

Run: `make all && pnpm run agency auth --help`
Expected: Shows the auth command help

- [ ] **Step 4: Test the `--list` command with no tokens**

Run: `pnpm run agency auth --list`
Expected: `No stored OAuth tokens.`

- [ ] **Step 5: Commit**

```bash
git add lib/cli/auth.ts scripts/agency.ts
git commit -m "feat: add agency auth CLI command for managing MCP OAuth tokens"
```

---

### Task 11: Run full test suite and rebuild fixtures

Verify nothing is broken across the entire test suite, rebuild fixtures if needed.

**Files:**
- Potentially modify: binary fixture files in `tests/typescriptGenerator/` and `tests/typescriptBuilder/`

- [ ] **Step 1: Build the project**

Run: `make all`
Expected: Clean build, no errors

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test:run`
Expected: All tests PASS. If any fixture tests fail due to the config changes, proceed to step 3.

- [ ] **Step 3: Rebuild fixtures if needed**

If fixture tests fail:
Run: `make fixtures`
Then verify: `pnpm test:run`

- [ ] **Step 4: Commit if fixtures changed**

```bash
git add -A tests/
git commit -m "chore: rebuild test fixtures after MCP OAuth changes"
```
