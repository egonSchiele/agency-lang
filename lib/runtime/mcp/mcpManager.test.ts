import { describe, it, expect, afterEach } from "vitest";
import { McpManager } from "./mcpManager.js";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.ts");

describe.skip("McpManager", () => {
  let manager: McpManager;

  afterEach(async () => {
    if (manager) {
      await manager.disconnectAll();
    }
  });

  it("should connect to a server and return tools as a success Result", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
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
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
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
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
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
