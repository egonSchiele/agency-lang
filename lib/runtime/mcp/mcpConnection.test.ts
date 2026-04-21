import { describe, it, expect } from "vitest";
import { McpConnection } from "./mcpConnection.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.ts");

describe("McpConnection", () => {
  it("should connect to a stdio server, list tools, and call a tool", async () => {
    const conn = new McpConnection("test", {
      command: "npx",
      args: ["tsx", TEST_SERVER_PATH],
    });

    await conn.connect();

    const tools = conn.getTools();
    expect(tools.length).toBeGreaterThan(0);

    const addTool = tools.find((t) => t.name === "test__add");
    expect(addTool).toBeDefined();
    expect(addTool!.serverName).toBe("test");
    expect(addTool!.__mcpTool).toBe(true);

    const result = await conn.callTool("add", { a: 3, b: 4 });
    expect(result).toContain("7");

    await conn.disconnect();
  });

  it("should return a failure when connecting to a nonexistent server", async () => {
    const conn = new McpConnection("bad", {
      command: "nonexistent-command-that-does-not-exist",
    });

    await expect(conn.connect()).rejects.toThrow();
  });
});
