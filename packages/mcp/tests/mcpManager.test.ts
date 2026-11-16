import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { McpManager } from "../src/mcpManager.js";
import { NeedsLoginError } from "../src/needsLogin.js";
import { callbackUrlFor } from "../src/callbackServer.js";
import type { McpServerConfig } from "../src/types.js";
import {
  startFakeOAuthServer,
  freePort,
  completeLogin,
  oauthConfig,
  type FakeOAuthServer,
} from "./fakeOAuthServer.js";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.mjs");

describe("McpManager", () => {
  let manager: McpManager;

  afterEach(async () => {
    if (manager) {
      await manager.disconnectAll();
    }
  });

  it("should connect to a server and return tools as a success Result", async () => {
    manager = new McpManager({
      test: {
        command: "node",
        args: [TEST_SERVER_PATH],
      },
    });

    const result = await manager.getTools("test");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value[0].name).toBe("test__add");
    }
  });

  it("should return the same array reference on second call (cached)", async () => {
    manager = new McpManager({
      test: {
        command: "node",
        args: [TEST_SERVER_PATH],
      },
    });

    const result1 = await manager.getTools("test");
    const result2 = await manager.getTools("test");
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    if (result1.success && result2.success) {
      // Same reference means the cached array was reused, not a new connection
      expect(result1.value).toBe(result2.value);
    }
  });

  it("should throw when server name is not in config", async () => {
    manager = new McpManager({});
    await expect(manager.getTools("nonexistent")).rejects.toThrow(
      /not found in agency.json/,
    );
  });

  it("should return a failure Result when connection fails", async () => {
    manager = new McpManager({
      bad: { command: "nonexistent-command-xyz" },
    });

    const result = await manager.getTools("bad");
    expect(result.success).toBe(false);
  });

  it("should lazily reconnect when calling a tool after disconnectAll", async () => {
    manager = new McpManager({
      test: {
        command: "node",
        args: [TEST_SERVER_PATH],
      },
    });

    // Connect and verify
    await manager.getTools("test");

    // Disconnect all — simulates checkpoint restore where connections are cleared
    await manager.disconnectAll();

    // callTool should lazily reconnect and succeed
    const result = await manager.callTool("test", "add", { a: 10, b: 20 });
    expect(result).toContain("30");
  });
});

describe("McpManager records, login modes, and logins", () => {
  let dir: string;
  let server: FakeOAuthServer;
  let port: number;
  let manager: McpManager;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-mgr-login-"));
    server = await startFakeOAuthServer();
    port = await freePort();
  });

  afterEach(async () => {
    await manager?.disconnectAll();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function managerFor(
    config: Record<string, McpServerConfig>,
    onOAuthRequired?: (data?: unknown) => void,
  ): McpManager {
    manager = new McpManager(config, { tokenStoreDir: dir, callbackPort: port, onOAuthRequired });
    return manager;
  }

  async function logIn(name: string): Promise<void> {
    const url = await manager.startLogin(name);
    const finished = manager.finishLogin(name);
    await completeLogin(url);
    expect((await finished).status).toBe("connected");
  }

  it("connectServer on a server with no saved login returns needsLogin", async () => {
    managerFor({ linear: oauthConfig(server) });
    expect(await manager.connectServer("linear")).toEqual({ status: "needsLogin" });
  });

  it("connectServer on a stdio server returns connected with its tools", async () => {
    managerFor({ test: { command: "node", args: [TEST_SERVER_PATH] } });
    const record = await manager.connectServer("test");
    expect(record.status).toBe("connected");
    expect(record.status === "connected" && record.tools[0].name).toBe("test__add");
  });

  it("connectServer on a command that does not exist returns failed with the reason", async () => {
    managerFor({ bad: { command: "nonexistent-command-xyz" } });
    const record = await manager.connectServer("bad");
    expect(record.status).toBe("failed");
    expect(record.status === "failed" && record.message).toContain("ENOENT");
  });

  it("connectServer on a name that is not in the config returns failed", async () => {
    managerFor({});
    expect(await manager.connectServer("missing")).toEqual({
      status: "failed",
      message: 'MCP server "missing" is not in the config',
    });
  });

  it("records returns every server's record and connects nothing", async () => {
    managerFor({ linear: oauthConfig(server), test: { command: "node", args: [TEST_SERVER_PATH] } });
    expect(manager.records()).toEqual({});
    await manager.connectServer("linear");
    expect(manager.records()).toEqual({ linear: { status: "needsLogin" } });
  });

  it("startLogin then finishLogin returns connected and records it", async () => {
    managerFor({ linear: oauthConfig(server) });
    await logIn("linear");
    expect(manager.records().linear.status).toBe("connected");
  });

  it("a second login cancels the first", async () => {
    managerFor({ a: oauthConfig(server), b: oauthConfig(server) });
    await manager.startLogin("a");
    const urlB = await manager.startLogin("b"); // same callback port
    expect(urlB).toContain("state=");
    await expect(manager.finishLogin("a")).rejects.toThrow("no login in progress for a");
    const finished = manager.finishLogin("b");
    await completeLogin(urlB);
    expect((await finished).status).toBe("connected");
  });

  it("finishLogin with no login in progress throws", async () => {
    managerFor({ linear: oauthConfig(server) });
    await expect(manager.finishLogin("linear")).rejects.toThrow("no login in progress for linear");
  });

  it("startLogin on a server that does not use OAuth throws", async () => {
    managerFor({ test: { command: "node", args: [TEST_SERVER_PATH] } });
    await expect(manager.startLogin("test")).rejects.toThrow('MCP server "test" is not an OAuth server');
  });

  it("log in again, cancelled: the server stays connected and its login stays saved", async () => {
    managerFor({ linear: oauthConfig(server) });
    await logIn("linear");
    const saved = fs.readFileSync(path.join(dir, "linear.json"), "utf-8");
    await manager.startLogin("linear");
    const finished = manager.finishLogin("linear");
    await manager.cancelLogin("linear");
    await expect(finished).rejects.toThrow("login cancelled");
    expect(manager.records().linear.status).toBe("connected");
    expect(fs.readFileSync(path.join(dir, "linear.json"), "utf-8")).toBe(saved);
    expect(await manager.callTool("linear", "add", { a: 1, b: 2 })).toContain("3");
  });

  it("logout keeps the registration, and a call after logout needs a login", async () => {
    managerFor({ linear: oauthConfig(server) });
    await logIn("linear");
    await manager.logout("linear");
    expect(fs.existsSync(path.join(dir, "linear.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "linear.client.json"))).toBe(true);
    await expect(manager.callTool("linear", "add", { a: 1, b: 2 })).rejects.toBeInstanceOf(NeedsLoginError);
    expect(manager.records().linear).toEqual({ status: "needsLogin" });
  });

  it("a call after logout of a server getTools connected starts no login", async () => {
    let asked = 0;
    let loginUrl = "";
    managerFor({ linear: oauthConfig(server) }, (data?: unknown) => {
      asked += 1;
      loginUrl = (data as { authUrl: string }).authUrl;
    });
    const tools = manager.getTools("linear");
    await vi.waitFor(() => expect(loginUrl).not.toBe(""));
    await completeLogin(loginUrl);
    expect((await tools).success).toBe(true);
    await manager.logout("linear");
    await expect(manager.callTool("linear", "add", { a: 1, b: 2 })).rejects.toBeInstanceOf(NeedsLoginError);
    expect(asked).toBe(1);
  });

  it("expiry on a live connection: the call fails and the record becomes needsLogin", async () => {
    managerFor({ linear: oauthConfig(server) });
    await logIn("linear");
    server.expireAccessTokens();
    server.rejectRefreshTokens();
    await expect(manager.callTool("linear", "add", { a: 1, b: 2 })).rejects.toThrow(
      'MCP server "linear" needs a new login.',
    );
    expect(manager.records().linear).toEqual({ status: "needsLogin" });
  });

  it("a call after the access token expires refreshes and succeeds", async () => {
    managerFor({ linear: oauthConfig(server) });
    await logIn("linear");
    server.expireAccessTokens();
    expect(await manager.callTool("linear", "add", { a: 2, b: 2 })).toContain("4");
  });

  it("setConfig with a changed entry is used by the next connectServer", async () => {
    managerFor({ test: { command: "nonexistent-command-xyz" } });
    expect((await manager.connectServer("test")).status).toBe("failed");
    manager.setConfig({ test: { command: "node", args: [TEST_SERVER_PATH] } });
    expect((await manager.connectServer("test")).status).toBe("connected");
  });

  it("getTools on an untouched OAuth server still asks first", async () => {
    const asked: string[] = [];
    managerFor({ linear: oauthConfig(server, 100) }, () => {
      asked.push("linear");
    });
    const tools = manager.getTools("linear");
    await vi.waitFor(() => expect(asked).toEqual(["linear"]));
    // Nobody logs in, so the wait times out after authTimeout.
    expect((await tools).success).toBe(false);
  });

  it("getTools after connectServer for the same server does not start a login", async () => {
    const asked: string[] = [];
    managerFor({ linear: oauthConfig(server) }, () => {
      asked.push("linear");
    });
    await manager.connectServer("linear");
    const result = await manager.getTools("linear");
    expect(result.success).toBe(false);
    expect(asked).toEqual([]);
  });

  it("disconnectAll cancels a login in progress", async () => {
    managerFor({ linear: oauthConfig(server) });
    await manager.startLogin("linear");
    await manager.disconnectAll();
    await expect(fetch(callbackUrlFor(port))).rejects.toThrow();
  });
});

describe("McpManager OAuth config", () => {
  it("should accept onOAuthRequired callback", () => {
    const manager = new McpManager(
      {
        github: { type: "http" as const, url: "https://example.com/mcp", auth: "oauth" as const },
      },
      { onOAuthRequired: () => { } },
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
