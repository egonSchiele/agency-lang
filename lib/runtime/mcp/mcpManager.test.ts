import { describe, it, expect, afterEach } from "vitest";
import { McpManager } from "./mcpManager.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.ts");

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

  it("should cache connections (same result on second call)", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
      },
    });

    const result1 = await manager.getTools("test");
    const result2 = await manager.getTools("test");
    expect(result1).toEqual(result2);
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

  it("should disconnect all connections", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
      },
    });

    await manager.getTools("test");
    await manager.disconnectAll();
  });
});
