import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import http from "http";

// Intercept openBrowser (which calls execFile) to capture the auth URL.
// We let http remain real so the callback server actually starts.
let capturedAuthUrl: string | null = null;

vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd: unknown, args: unknown, cb: unknown) => {
    const argList = args as string[];
    if (argList?.[0]) capturedAuthUrl = argList[0];
    if (typeof cb === "function") (cb as Function)(null, "", "");
  }),
}));

// Skip encryption — no system keyring on CI
vi.mock("../oauthEncryption.js", () => ({
  getEncryptionKey: vi.fn().mockResolvedValue(null),
  encrypt: vi.fn((json: string) => json),
  decrypt: vi.fn((json: string) => json),
}));

import { _authorize, _isAuthorized, _getAccessToken } from "../oauth.js";

describe("_authorize", () => {
  let tokenDir: string;
  const originalFetch = globalThis.fetch;
  const originalTokenDir = process.env.AGENCY_OAUTH_TOKEN_DIR;
  const TEST_PORT = 18915;

  beforeEach(() => {
    tokenDir = mkdtempSync(join(tmpdir(), "agency-oauth-auth-test-"));
    process.env.AGENCY_OAUTH_TOKEN_DIR = tokenDir;
    capturedAuthUrl = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tokenDir, { recursive: true, force: true });
    if (originalTokenDir !== undefined) {
      process.env.AGENCY_OAUTH_TOKEN_DIR = originalTokenDir;
    } else {
      delete process.env.AGENCY_OAUTH_TOKEN_DIR;
    }
  });

  it("full authorize flow: callback server → code exchange → token storage", async () => {
    // Mock fetch for the token exchange endpoint
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "mock-access-token",
        refresh_token: "mock-refresh-token",
        expires_in: 3600,
      }),
    }) as any;

    // Start authorize (it listens for the callback, then exchanges the code)
    const authorizePromise = _authorize("test-provider", {
      authUrl: "https://localhost/auth",
      tokenUrl: "https://localhost/token",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      scopes: "read write",
      port: TEST_PORT,
    });

    // Wait for the callback server to start
    await new Promise((r) => setTimeout(r, 200));

    // Extract state from the captured auth URL
    expect(capturedAuthUrl).toBeTruthy();
    const authParams = new URL(capturedAuthUrl!).searchParams;
    const state = authParams.get("state");
    expect(state).toBeTruthy();

    // Verify the auth URL was constructed correctly
    expect(authParams.get("client_id")).toBe("test-client-id");
    expect(authParams.get("response_type")).toBe("code");
    expect(authParams.get("scope")).toBe("read write");
    expect(authParams.get("code_challenge_method")).toBe("S256");
    expect(authParams.get("code_challenge")).toBeTruthy();
    expect(authParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${TEST_PORT}/oauth/callback`
    );

    // Simulate the browser callback
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${TEST_PORT}/oauth/callback?code=test-auth-code&state=${state}`,
        (res) => {
          expect(res.statusCode).toBe(200);
          resolve();
        }
      );
      req.on("error", reject);
    });

    // authorize should complete successfully
    const result = await authorizePromise;
    expect(result).toEqual({ success: true });

    // Verify the token exchange request
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [fetchUrl, fetchOpts] = (globalThis.fetch as any).mock.calls[0];
    expect(fetchUrl).toBe("https://localhost/token");
    expect(fetchOpts.method).toBe("POST");
    expect(fetchOpts.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    // Verify token exchange body has all required fields
    const body = new URLSearchParams(fetchOpts.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("test-auth-code");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("redirect_uri")).toBe(
      `http://127.0.0.1:${TEST_PORT}/oauth/callback`
    );

    // Tokens should be stored and retrievable
    expect(await _isAuthorized("test-provider")).toBe(true);
    expect(await _getAccessToken("test-provider")).toBe("mock-access-token");
  });

  it("rejects non-HTTPS token URL (except localhost)", async () => {
    await expect(
      _authorize("http-token-test", {
        authUrl: "https://localhost/auth",
        tokenUrl: "http://evil.com/token",
        clientId: "id",
        clientSecret: "secret",
        scopes: "read",
      })
    ).rejects.toThrow("must use HTTPS");
  });

  it("rejects non-HTTPS auth URL (except localhost)", async () => {
    await expect(
      _authorize("http-test", {
        authUrl: "http://evil.com/auth",
        tokenUrl: "https://localhost/token",
        clientId: "id",
        clientSecret: "secret",
        scopes: "read",
      })
    ).rejects.toThrow("must use HTTPS");
  });
});
