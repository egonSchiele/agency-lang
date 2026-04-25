import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgencyOAuthProvider } from "../src/oauthProvider.js";
import { TokenStore } from "../src/tokenStore.js";
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
    const provider = new AgencyOAuthProvider("github", store);
    const tokens = await provider.tokens();
    expect(tokens).toBeUndefined();
  });

  it("should return stored tokens", async () => {
    const savedTokens = { access_token: "abc", token_type: "bearer" };
    await store.saveTokens("github", savedTokens);

    const provider = new AgencyOAuthProvider("github", store);
    const tokens = await provider.tokens();
    expect(tokens).toEqual(savedTokens);
  });

  it("should save tokens via saveTokens", async () => {
    const provider = new AgencyOAuthProvider("github", store);
    const tokens = { access_token: "new-token", token_type: "bearer" };
    await provider.saveTokens(tokens);

    const loaded = await store.loadTokens("github");
    expect(loaded).toEqual(tokens);
  });

  it("should save and load code verifier", async () => {
    const provider = new AgencyOAuthProvider("github", store);
    await provider.saveCodeVerifier("verifier-abc");
    const loaded = await provider.codeVerifier();
    expect(loaded).toBe("verifier-abc");
  });

  it("should save and load client info", async () => {
    const provider = new AgencyOAuthProvider("github", store);
    const info = { client_id: "my-id", client_secret: "secret" };
    await provider.saveClientInformation(info);
    const loaded = await provider.clientInformation();
    expect(loaded).toEqual(info);
  });

  it("should fall back to env vars for clientId and clientSecret", async () => {
    const origId = process.env.MCP_GITHUB_CLIENT_ID;
    const origSecret = process.env.MCP_GITHUB_CLIENT_SECRET;
    process.env.MCP_GITHUB_CLIENT_ID = "env-client-id";
    process.env.MCP_GITHUB_CLIENT_SECRET = "env-client-secret";
    try {
      // No clientId/clientSecret in options — should pick up env vars
      const provider = new AgencyOAuthProvider("github", store);
      const info = await provider.clientInformation();
      expect(info).toBeDefined();
      expect((info as any).client_id).toBe("env-client-id");
      expect((info as any).client_secret).toBe("env-client-secret");
    } finally {
      if (origId === undefined) delete process.env.MCP_GITHUB_CLIENT_ID;
      else process.env.MCP_GITHUB_CLIENT_ID = origId;
      if (origSecret === undefined) delete process.env.MCP_GITHUB_CLIENT_SECRET;
      else process.env.MCP_GITHUB_CLIENT_SECRET = origSecret;
    }
  });

  it("should prefer config values over env vars", async () => {
    const origId = process.env.MCP_GITHUB_CLIENT_ID;
    process.env.MCP_GITHUB_CLIENT_ID = "env-id";
    try {
      const provider = new AgencyOAuthProvider("github", store, {
        clientId: "config-id",
      });
      const info = await provider.clientInformation();
      expect((info as any).client_id).toBe("config-id");
    } finally {
      if (origId === undefined) delete process.env.MCP_GITHUB_CLIENT_ID;
      else process.env.MCP_GITHUB_CLIENT_ID = origId;
    }
  });

  it("should return undefined from clientInformation when no config or env vars", async () => {
    // Make sure the env vars are not set
    const origId = process.env.MCP_GITHUB_CLIENT_ID;
    delete process.env.MCP_GITHUB_CLIENT_ID;
    try {
      const provider = new AgencyOAuthProvider("github", store);
      const info = await provider.clientInformation();
      expect(info).toBeUndefined();
    } finally {
      if (origId !== undefined) process.env.MCP_GITHUB_CLIENT_ID = origId;
    }
  });

  it("should throw from codeVerifier when no verifier is saved", async () => {
    const provider = new AgencyOAuthProvider("github", store);
    await expect(provider.codeVerifier()).rejects.toThrow(/No PKCE code verifier/);
  });

  it("should have correct client metadata after prepare()", async () => {
    const provider = new AgencyOAuthProvider("github", store, { port: 0 });
    await provider.prepare();
    const meta = provider.clientMetadata;
    expect(meta.client_name).toBe("agency-github");
    expect(meta.redirect_uris).toBeDefined();
    expect(meta.redirect_uris.length).toBe(1);
    await provider.cleanup();
  });

  it("should throw from redirectUrl before prepare()", () => {
    const provider = new AgencyOAuthProvider("github", store);
    expect(() => provider.redirectUrl).toThrow(/call prepare/);
  });

  it("should have a real redirectUrl after prepare()", async () => {
    const provider = new AgencyOAuthProvider("github", store, { port: 0 });
    await provider.prepare();
    expect(provider.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(provider.redirectUrl).not.toContain(":0/");
    await provider.cleanup();
  });

  it("should call onOAuthRequired callback instead of opening browser when provided", async () => {
    const onOAuthRequired = vi.fn();
    const provider = new AgencyOAuthProvider("github", store, {
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
    const provider = new AgencyOAuthProvider("github", store, { port: 0 });
    await provider.prepare();

    const callbackUrl = provider.redirectUrl;
    const state = provider.state();
    const codePromise = provider.waitForAuthCode();
    await fetch(`${callbackUrl}?code=test-code&state=${state}`);
    const code = await codePromise;
    expect(code).toBe("test-code");

    await provider.cleanup();
  });
});
