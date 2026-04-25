import { describe, it, expect, afterEach } from "vitest";
import { McpManager } from "../src/mcpManager.js";
import { mcpToolToAgencyFunction } from "../src/toolAdapter.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.ts");

describe.skip("MCP integration", () => {
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

    // After deserialization, we can still build a working AgencyFunction
    const fn = mcpToolToAgencyFunction(deserialized[0], (serverName, toolName, args) =>
      manager.callTool(serverName, toolName, args),
    );
    const toolResult = await fn.invoke(
      { type: "named", positionalArgs: [], namedArgs: { a: 3, b: 4 } },
      { ctx: null },
    );
    expect(toolResult).toContain("7");
  });
});
