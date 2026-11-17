import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OAuthConnector } from "../src/oauthConnector.js";
import { TokenStore } from "../src/tokenStore.js";
import { NeedsLoginError } from "../src/needsLogin.js";
import { callbackUrlFor } from "../src/callbackServer.js";
import { startFakeOAuthServer, freePort, completeLogin, type FakeOAuthServer } from "./fakeOAuthServer.js";
import type { OAuthProviderOptions } from "../src/oauthProvider.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("OAuthConnector", () => {
  let tmpDir: string;
  let store: TokenStore;
  let server: FakeOAuthServer;
  let port: number;
  const openClients: Client[] = [];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-connector-test-"));
    store = new TokenStore(tmpDir);
    server = await startFakeOAuthServer();
    port = await freePort();
  });

  afterEach(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close().catch(() => {})));
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function connectorFor(name: string, options: OAuthProviderOptions = {}, url = server.mcpUrl): OAuthConnector {
    return new OAuthConnector(name, url, store, { port, loginMode: "never", ...options });
  }

  /** Log in once through startLogin and finishLogin, and keep the client open. */
  async function logIn(connector: OAuthConnector): Promise<Client> {
    const url = await connector.startLogin();
    const finished = connector.finishLogin();
    await completeLogin(url);
    const { client } = await finished;
    openClients.push(client);
    return client;
  }

  it("throws when the server is unreachable", async () => {
    const connector = connectorFor("test", {}, "http://127.0.0.1:1/nonexistent");
    await expect(connector.connect()).rejects.toThrow();
  });

  it("never mode: connect rejects with NeedsLoginError and starts no page", async () => {
    await expect(connectorFor("linear").connect()).rejects.toBeInstanceOf(NeedsLoginError);
    await expect(fetch(callbackUrlFor(port))).rejects.toThrow();
  });

  it("two never-mode connects at once both need a login", async () => {
    const results = await Promise.allSettled([connectorFor("a").connect(), connectorFor("b").connect()]);
    expect(results.map((r) => r.status === "rejected" && r.reason instanceof NeedsLoginError)).toEqual([true, true]);
  });

  it("startLogin then finishLogin connects and saves the login", async () => {
    const client = await logIn(connectorFor("linear"));
    expect((await client.listTools()).tools[0].name).toBe("add");
    expect(await store.loadTokens("linear")).toBeDefined();
  });

  it("a saved login connects with no page and no unhandled rejection", async () => {
    await logIn(connectorFor("linear"));
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onRejection);
    const { client } = await connectorFor("linear").connect();
    openClients.push(client);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onRejection);
    expect(seen).toEqual([]);
    await expect(fetch(callbackUrlFor(port))).rejects.toThrow();
  });

  it("startLogin ignores a working saved login, and cancel keeps it", async () => {
    const connector = connectorFor("linear");
    await logIn(connector);
    const before = await store.loadTokens("linear");
    const url = await connector.startLogin();
    expect(url).toContain("code_challenge");
    await connector.cancelLogin();
    expect(await store.loadTokens("linear")).toEqual(before);
  });

  it("cancelLogin makes a waiting finishLogin reject, and the port is free again", async () => {
    const connector = connectorFor("linear");
    await connector.startLogin();
    const finished = connector.finishLogin();
    await connector.cancelLogin();
    await expect(finished).rejects.toThrow("login cancelled");
    await connector.startLogin(); // binds the same port
    await connector.cancelLogin();
  });

  it("two logins in a row use different state values", async () => {
    const connector = connectorFor("linear");
    const first = new URL(await connector.startLogin()).searchParams.get("state");
    await connector.cancelLogin();
    const second = new URL(await connector.startLogin()).searchParams.get("state");
    await connector.cancelLogin();
    expect(second).not.toBe(first);
  });

  it("finishLogin counts its timeout from its own call", async () => {
    const connector = connectorFor("linear", { timeoutMs: 60 });
    await connector.startLogin();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    await expect(connector.finishLogin()).rejects.toThrow("OAuth callback timed out");
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("a rejected refresh token deletes the login and needs a login", async () => {
    await logIn(connectorFor("linear"));
    server.expireAccessTokens();
    server.rejectRefreshTokens();
    await expect(connectorFor("linear").connect()).rejects.toBeInstanceOf(NeedsLoginError);
    expect(await store.loadTokens("linear")).toBeUndefined();
    expect(await store.loadClientInfo("linear")).toBeDefined();
  });

  it("a call after the access token expires refreshes and succeeds", async () => {
    const client = await logIn(connectorFor("linear"));
    server.expireAccessTokens();
    const result = await client.callTool({ name: "add", arguments: { a: 1, b: 2 } });
    expect(result.isError).toBeFalsy();
    expect(server.refreshCount()).toBe(1);
  });

  it("two calls at expiry both succeed and the login survives", async () => {
    await server.close();
    server = await startFakeOAuthServer({ rotateRefreshTokens: true, refreshDelayMs: 50 });
    const client = await logIn(connectorFor("linear"));
    server.expireAccessTokens();
    const [a, b] = await Promise.all([
      client.callTool({ name: "add", arguments: { a: 1, b: 2 } }),
      client.callTool({ name: "add", arguments: { a: 3, b: 4 } }),
    ]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(await store.loadTokens("linear")).toBeDefined();
    expect(server.refreshCount()).toBeGreaterThanOrEqual(2);
  });

  for (const calls of [3, 4]) {
    it(`${calls} calls at expiry all succeed and the login survives`, async () => {
      await server.close();
      server = await startFakeOAuthServer({ rotateRefreshTokens: true, refreshDelayMs: 50 });
      const client = await logIn(connectorFor("linear"));
      server.expireAccessTokens();
      const results = await Promise.all(
        Array.from({ length: calls }, (_, i) => client.callTool({ name: "add", arguments: { a: i, b: 1 } })),
      );
      expect(results.map((result) => Boolean(result.isError))).toEqual(Array(calls).fill(false));
      expect(await store.loadTokens("linear")).toBeDefined();
    });
  }

  it("ask first still logs in", async () => {
    let url = "";
    const connector = connectorFor("linear", {
      loginMode: "askFirst",
      onOAuthRequired: (data) => {
        url = data.authUrl;
      },
    });
    const connected = connector.connect();
    await vi.waitFor(() => expect(url).not.toBe(""));
    await completeLogin(url);
    const { client } = await connected;
    openClients.push(client);
    expect((await client.listTools()).tools.length).toBe(1);
  });
});
