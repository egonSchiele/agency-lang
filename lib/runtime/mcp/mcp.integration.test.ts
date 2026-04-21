import { describe, it, expect, afterEach } from "vitest";
import { McpManager } from "./mcpManager.js";
import { isMcpTool, mcpToolToRegistryEntry } from "./toolAdapter.js";
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

  it("full flow: getTools -> detect MCP tool -> convert to registry entry -> call tool", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
      },
    });

    // Step 1: Get tools (returns Result)
    const result = await manager.getTools("test");
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");

    const tools = result.value;
    expect(tools.length).toBeGreaterThan(0);

    // Step 2: Verify they're MCP tools
    const addTool = tools.find((t: any) => t.name === "test__add");
    expect(addTool).toBeDefined();
    expect(isMcpTool(addTool)).toBe(true);

    // Step 3: Convert to registry entry
    const entry = mcpToolToRegistryEntry(addTool!, (serverName, toolName, args) =>
      manager.callTool(serverName, toolName, args),
    );

    expect(entry.definition.name).toBe("test__add");
    expect(entry.handler.params).toContain("a");
    expect(entry.handler.params).toContain("b");

    // Step 4: Call the tool through the handler
    // prompt.ts appends a context object as the last arg — simulate that
    const toolResult = await entry.handler.execute(3, 4, { ctx: null, threads: null, isToolCall: true });
    expect(toolResult).toContain("7");
  });

  it("tools survive JSON serialization round-trip", async () => {
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

    // Verify shape is preserved
    expect(deserialized[0].__mcpTool).toBe(true);
    expect(deserialized[0].serverName).toBe("test");
    expect(deserialized[0].name).toBe("test__add");

    // Verify we can still create a registry entry from deserialized data
    const entry = mcpToolToRegistryEntry(deserialized[0], (serverName, toolName, args) =>
      manager.callTool(serverName, toolName, args),
    );
    const toolResult = await entry.handler.execute(3, 4, { ctx: null });
    expect(toolResult).toContain("7");
  });
});
