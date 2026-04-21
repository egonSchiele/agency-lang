import { describe, it, expect, afterEach } from "vitest";
import { McpManager } from "./mcpManager.js";
import { mcpToolToRegistryEntry } from "./toolAdapter.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.ts");

describe("MCP integration", () => {
  let manager: McpManager;

  afterEach(async () => {
    if (manager) {
      await manager.disconnectAll();
    }
  });

  it("tools survive JSON serialization round-trip and remain callable", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
      },
    });

    const result = await manager.getTools("test");
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");

    const tools = result.value;
    const serialized = JSON.stringify(tools);
    const deserialized = JSON.parse(serialized);

    expect(deserialized[0].__mcpTool).toBe(true);
    expect(deserialized[0].serverName).toBe("test");
    expect(deserialized[0].name).toBe("test__add");

    // After deserialization, we can still build a working handler
    const entry = mcpToolToRegistryEntry(deserialized[0], (serverName, toolName, args) =>
      manager.callTool(serverName, toolName, args),
    );
    const toolResult = await entry.handler.execute(3, 4, { ctx: null });
    expect(toolResult).toContain("7");
  });
});
