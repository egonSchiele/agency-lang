import { describe, it, expect } from "vitest";
import { mcpToolToRegistryEntry, isMcpTool } from "./toolAdapter.js";
import type { McpToolObject } from "./types.js";

describe("isMcpTool", () => {
  it("should return true for MCP tool objects", () => {
    const tool: McpToolObject = {
      name: "test__add",
      description: "Add two numbers",
      serverName: "test",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
      __mcpTool: true,
    };
    expect(isMcpTool(tool)).toBe(true);
  });

  it("should return false for non-MCP objects", () => {
    expect(isMcpTool({ name: "foo" })).toBe(false);
    expect(isMcpTool(null)).toBe(false);
    expect(isMcpTool("string")).toBe(false);
  });
});

describe("mcpToolToRegistryEntry", () => {
  it("should produce a valid { definition, handler } pair", async () => {
    const tool: McpToolObject = {
      name: "test__add",
      description: "Add two numbers",
      serverName: "test",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      __mcpTool: true,
    };

    const mockCallTool = async (
      _serverName: string,
      _toolName: string,
      _args: Record<string, unknown>,
    ) => "7";

    const entry = mcpToolToRegistryEntry(tool, mockCallTool);

    expect(entry.definition.name).toBe("test__add");
    expect(entry.definition.description).toBe("Add two numbers");
    expect(entry.handler.name).toBe("test__add");
    expect(entry.handler.isBuiltin).toBe(false);
    expect(entry.handler.params).toEqual(["a", "b"]);

    // prompt.ts appends a context object as the last arg — include it to test stripping
    const result = await entry.handler.execute(3, 4, { ctx: null, threads: null, isToolCall: true });
    expect(result).toBe("7");
  });
});
