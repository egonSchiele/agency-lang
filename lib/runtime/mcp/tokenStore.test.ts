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

  it("should reject server names with path traversal characters", async () => {
    await expect(store.saveTokens("../evil", { access_token: "x", token_type: "bearer" }))
      .rejects.toThrow(/Invalid MCP server name/);
    await expect(store.saveTokens("foo/bar", { access_token: "x", token_type: "bearer" }))
      .rejects.toThrow(/Invalid MCP server name/);
    await expect(store.saveTokens("foo bar", { access_token: "x", token_type: "bearer" }))
      .rejects.toThrow(/Invalid MCP server name/);
  });

  it("should allow valid server names with hyphens and underscores", async () => {
    await store.saveTokens("my-server_1", { access_token: "x", token_type: "bearer" });
    const loaded = await store.loadTokens("my-server_1");
    expect(loaded?.access_token).toBe("x");
  });

  it("should set file permissions to 0600", async () => {
    await store.saveTokens("github", { access_token: "abc", token_type: "bearer" });
    const filePath = path.join(tmpDir, "github.json");
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
