import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  _authorize,
  _getAccessToken,
  _isAuthorized,
  _revokeAuth,
} from "../oauth.js";

// Mock child_process (for openBrowser)
vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd, _args, _cb) => {}),
}));

// Mock http server and fetch
const mockServerInstance = {
  listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
  close: vi.fn(),
};

vi.mock("http", () => ({
  default: {
    createServer: vi.fn((handler: (req: unknown, res: unknown) => void) => {
      // Store handler so we can trigger it in tests
      (mockServerInstance as unknown as { _handler: typeof handler })._handler =
        handler;
      return mockServerInstance;
    }),
  },
}));

const TOKEN_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".agency",
  "oauth"
);

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe("_isAuthorized", () => {
  const testTokenPath = path.join(TOKEN_DIR, "test-provider.json");

  afterEach(() => {
    if (fs.existsSync(testTokenPath)) {
      fs.unlinkSync(testTokenPath);
    }
  });

  it("returns false when no token file exists", () => {
    expect(_isAuthorized("nonexistent-provider")).toBe(false);
  });

  it("returns true when token file exists", () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(
      testTokenPath,
      JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: 0 })
    );
    expect(_isAuthorized("test-provider")).toBe(true);
  });
});

describe("_revokeAuth", () => {
  const testTokenPath = path.join(TOKEN_DIR, "revoke-test.json");

  afterEach(() => {
    if (fs.existsSync(testTokenPath)) {
      fs.unlinkSync(testTokenPath);
    }
  });

  it("returns revoked:false when no tokens exist", () => {
    expect(_revokeAuth("revoke-test")).toEqual({ revoked: false });
  });

  it("deletes token file and returns revoked:true", () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(testTokenPath, JSON.stringify({ access_token: "x" }));
    expect(_revokeAuth("revoke-test")).toEqual({ revoked: true });
    expect(fs.existsSync(testTokenPath)).toBe(false);
  });
});

describe("_getAccessToken", () => {
  const testTokenPath = path.join(TOKEN_DIR, "token-test.json");
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (fs.existsSync(testTokenPath)) {
      fs.unlinkSync(testTokenPath);
    }
  });

  it("throws when no tokens exist", async () => {
    await expect(_getAccessToken("no-such-provider")).rejects.toThrow(
      "No OAuth tokens found"
    );
  });

  it("returns access token when not expired", async () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(
      testTokenPath,
      JSON.stringify({
        access_token: "valid-token",
        refresh_token: "refresh-123",
        expires_at: Date.now() + 3600000, // 1 hour from now
        token_url: "https://example.com/token",
        client_id: "id",
        client_secret: "secret",
      })
    );

    const token = await _getAccessToken("token-test");
    expect(token).toBe("valid-token");
  });

  it("refreshes token when expired", async () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(
      testTokenPath,
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-456",
        expires_at: Date.now() - 1000, // already expired
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

    const token = await _getAccessToken("token-test");
    expect(token).toBe("new-token");

    // Verify it was saved
    const saved = JSON.parse(fs.readFileSync(testTokenPath, "utf-8"));
    expect(saved.access_token).toBe("new-token");
    expect(saved.refresh_token).toBe("new-refresh");
  });

  it("keeps old refresh token when new one not provided", async () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(
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
      // No refresh_token in response
    });

    await _getAccessToken("token-test");

    const saved = JSON.parse(fs.readFileSync(testTokenPath, "utf-8"));
    expect(saved.refresh_token).toBe("keep-this-refresh");
  });

  it("sends correct refresh request", async () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(
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

    await _getAccessToken("token-test");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://auth.example.com/token");
    const params = new URLSearchParams(init.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("my-refresh");
    expect(params.get("client_id")).toBe("my-client");
    expect(params.get("client_secret")).toBe("my-secret");
  });

  it("throws when refresh fails", async () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(
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

    await expect(_getAccessToken("token-test")).rejects.toThrow(
      "OAuth token exchange failed (400)"
    );
  });

  it("throws when no refresh token available", async () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(
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

    await expect(_getAccessToken("token-test")).rejects.toThrow(
      "no refresh token"
    );
  });
});

describe("input validation", () => {
  it("rejects provider names with path separators", () => {
    expect(() => _isAuthorized("../evil")).toThrow("Invalid OAuth provider name");
    expect(() => _isAuthorized("foo/bar")).toThrow("Invalid OAuth provider name");
    expect(() => _isAuthorized("foo\\bar")).toThrow("Invalid OAuth provider name");
  });
});
