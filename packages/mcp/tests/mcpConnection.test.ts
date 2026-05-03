import { describe, it, expect, afterEach } from "vitest";
import { McpConnection } from "../src/mcpConnection.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.mjs");

describe("McpConnection", () => {
  let conn: McpConnection;

  afterEach(async () => {
    if (conn) {
      await conn.disconnect();
    }
  });

  it("should connect to a stdio server, list tools, and call a tool", async () => {
    conn = new McpConnection("test", {
      command: "node",
      args: [TEST_SERVER_PATH],
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
  });

  it("should throw when connecting to a nonexistent server", async () => {
    conn = new McpConnection("bad", {
      command: "nonexistent-command-that-does-not-exist",
    });

    await expect(conn.connect()).rejects.toThrow();
  });
});

describe("McpConnection with connector", () => {
  it("should call the connector function when connecting", async () => {
    let connectorCalled = false;
    const conn = new McpConnection("test", {
      type: "http",
      url: "https://example.com/mcp",
      auth: "oauth",
    }, {
      connector: async () => {
        connectorCalled = true;
        throw new Error("mock connector");
      },
    });

    await expect(conn.connect()).rejects.toThrow("mock connector");
    expect(connectorCalled).toBe(true);
  });

  it("should not use connector for stdio servers without one", async () => {
    const conn = new McpConnection("bad", {
      command: "nonexistent-command",
    });
    await expect(conn.connect()).rejects.toThrow();
  });
});
