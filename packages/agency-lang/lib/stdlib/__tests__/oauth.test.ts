import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";

// Set temp dir BEFORE importing oauth (getTokenDir() reads env at call time)
const TOKEN_DIR = path.join(os.tmpdir(), "agency-oauth-test-" + process.pid);
const originalTokenDir = process.env.AGENCY_OAUTH_TOKEN_DIR;
process.env.AGENCY_OAUTH_TOKEN_DIR = TOKEN_DIR;

afterAll(() => {
  if (originalTokenDir !== undefined) {
    process.env.AGENCY_OAUTH_TOKEN_DIR = originalTokenDir;
  } else {
    delete process.env.AGENCY_OAUTH_TOKEN_DIR;
  }
});

// Mock encryption to return null key (plaintext mode) so tests don't hit real keyring
vi.mock("../oauthEncryption.js", () => ({
  getEncryptionKey: vi.fn().mockResolvedValue(null),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

// Mock child_process (for openBrowser)
vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd: unknown, _args: unknown, _cb: unknown) => {}),
}));

// Mock http server
const mockServerInstance = {
  listen: vi.fn((_port: number, _host: string) => {}),
  close: vi.fn(),
  on: vi.fn(),
};

vi.mock("http", () => ({
  default: {
    createServer: vi.fn((handler: (req: unknown, res: unknown) => void) => {
      (mockServerInstance as unknown as { _handler: typeof handler })._handler =
        handler;
      return mockServerInstance;
    }),
  },
}));

import {
  _getAccessToken,
  _isAuthorized,
  _revokeAuth,
} from "../oauth.js";
import { runInTestContext } from "../../runtime/asyncContext.js";
import { RuntimeContext } from "../../runtime/state/context.js";
import { StateStack } from "../../runtime/state/stateStack.js";
import { ThreadStore } from "../../runtime/state/threadStore.js";

// Wrap calls into ALS-reading stdlib helpers so getRuntimeContext()
// finds a frame. Each call gets its own fresh ctx/stack/threads —
// these tests don't exercise checkpoint or guard state, so a minimal
// context suffices.
function withCtx<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
  return runInTestContext(ctx, new StateStack(), new ThreadStore(), fn);
}

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

// Cleanup after each test
afterEach(async () => {
  try {
    await fs.rm(TOKEN_DIR, { recursive: true, force: true });
  } catch {}
});

describe("_isAuthorized", () => {
  const testTokenPath = path.join(TOKEN_DIR, "test-provider.json");

  it("returns false when no token file exists", async () => {
    expect(await _isAuthorized("nonexistent-provider")).toBe(false);
  });

  it("returns true when token file exists with required fields", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(
      testTokenPath,
      JSON.stringify({
        access_token: "test",
        refresh_token: "test",
        expires_at: 0,
        token_url: "https://example.com/token",
        client_id: "id",
        client_secret: "secret",
      })
    );
    expect(await _isAuthorized("test-provider")).toBe(true);
  });
});

describe("_revokeAuth", () => {
  const testTokenPath = path.join(TOKEN_DIR, "revoke-test.json");

  it("returns revoked:false when no tokens exist", async () => {
    expect(await _revokeAuth("revoke-test")).toEqual({ revoked: false });
  });

  it("deletes token file and returns revoked:true", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(testTokenPath, JSON.stringify({
      access_token: "x",
      token_url: "https://example.com/token",
      client_id: "id",
    }));
    expect(await _revokeAuth("revoke-test")).toEqual({ revoked: true });
    expect(fsSync.existsSync(testTokenPath)).toBe(false);
  });
});

describe("_getAccessToken", () => {
  const testTokenPath = path.join(TOKEN_DIR, "token-test.json");
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws when no tokens exist", async () => {
    await expect(withCtx(() => _getAccessToken("no-such-provider"))).rejects.toThrow(
      "No OAuth tokens found"
    );
  });

  it("returns access token when not expired", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(
      testTokenPath,
      JSON.stringify({
        access_token: "valid-token",
        refresh_token: "refresh-123",
        expires_at: Date.now() + 3600000,
        token_url: "https://example.com/token",
        client_id: "id",
        client_secret: "secret",
      })
    );

    const token = await withCtx(() => _getAccessToken("token-test"));
    expect(token).toBe("valid-token");
  });

  it("refreshes token when expired", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(
      testTokenPath,
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-456",
        expires_at: Date.now() - 1000,
        token_url: "https://example.com/token",
        client_id: "id",
        client_secret: "secret",
      })
    );

    globalThis.fetch = mockFetchResponse({
      access_token: "new-token",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    const token = await withCtx(() => _getAccessToken("token-test"));
    expect(token).toBe("new-token");

    const saved = JSON.parse(await fs.readFile(testTokenPath, "utf-8"));
    expect(saved.access_token).toBe("new-token");
    expect(saved.refresh_token).toBe("new-refresh");
  });

  it("keeps old refresh token when new one not provided", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(
      testTokenPath,
      JSON.stringify({
        access_token: "expired",
        refresh_token: "keep-this-refresh",
        expires_at: Date.now() - 1000,
        token_url: "https://example.com/token",
        client_id: "id",
        client_secret: "secret",
      })
    );

    globalThis.fetch = mockFetchResponse({
      access_token: "refreshed",
      expires_in: 3600,
    });

    await withCtx(() => _getAccessToken("token-test"));

    const saved = JSON.parse(await fs.readFile(testTokenPath, "utf-8"));
    expect(saved.refresh_token).toBe("keep-this-refresh");
  });

  it("sends correct refresh request", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(
      testTokenPath,
      JSON.stringify({
        access_token: "expired",
        refresh_token: "my-refresh",
        expires_at: Date.now() - 1000,
        token_url: "https://auth.example.com/token",
        client_id: "my-client",
        client_secret: "my-secret",
      })
    );

    const mockFetch = mockFetchResponse({
      access_token: "new",
      expires_in: 3600,
    });
    globalThis.fetch = mockFetch;

    await withCtx(() => _getAccessToken("token-test"));

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://auth.example.com/token");
    const params = new URLSearchParams(init.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("my-refresh");
    expect(params.get("client_id")).toBe("my-client");
    expect(params.get("client_secret")).toBe("my-secret");
  });

  it("throws when refresh fails", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(
      testTokenPath,
      JSON.stringify({
        access_token: "expired",
        refresh_token: "bad-refresh",
        expires_at: Date.now() - 1000,
        token_url: "https://example.com/token",
        client_id: "id",
        client_secret: "secret",
      })
    );

    globalThis.fetch = mockFetchResponse({ error: "invalid_grant" }, 400);

    await expect(withCtx(() => _getAccessToken("token-test"))).rejects.toThrow(
      "OAuth token exchange failed (400)"
    );
  });

  it("throws when no refresh token available", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(
      testTokenPath,
      JSON.stringify({
        access_token: "expired",
        refresh_token: "",
        expires_at: Date.now() - 1000,
        token_url: "https://example.com/token",
        client_id: "id",
        client_secret: "secret",
      })
    );

    await expect(withCtx(() => _getAccessToken("token-test"))).rejects.toThrow(
      "no refresh token"
    );
  });

  it("deduplicates concurrent refresh requests", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(
      testTokenPath,
      JSON.stringify({
        access_token: "expired",
        refresh_token: "refresh",
        expires_at: Date.now() - 1000,
        token_url: "https://example.com/token",
        client_id: "id",
        client_secret: "secret",
      })
    );

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        ok: true,
        json: async () => ({ access_token: "refreshed", expires_in: 3600 }),
      };
    });

    const [token1, token2] = await Promise.all([
      withCtx(() => _getAccessToken("token-test")),
      withCtx(() => _getAccessToken("token-test")),
    ]);

    expect(token1).toBe("refreshed");
    expect(token2).toBe("refreshed");
    expect(fetchCallCount).toBe(1);
  });
});

describe("input validation", () => {
  it("rejects provider names with path separators", async () => {
    await expect(_isAuthorized("../evil")).rejects.toThrow("Invalid OAuth provider name");
    await expect(_isAuthorized("foo/bar")).rejects.toThrow("Invalid OAuth provider name");
    await expect(_isAuthorized("foo\\bar")).rejects.toThrow("Invalid OAuth provider name");
  });

  it("rejects provider names with invalid characters", async () => {
    await expect(_isAuthorized("foo bar")).rejects.toThrow("Invalid OAuth provider name");
    await expect(_isAuthorized("")).rejects.toThrow("Invalid OAuth provider name");
  });

  it("accepts valid provider names", async () => {
    expect(await _isAuthorized("google-calendar")).toBe(false);
    expect(await _isAuthorized("my_provider.v2")).toBe(false);
    expect(await _isAuthorized("GitHub")).toBe(false);
  });
});
