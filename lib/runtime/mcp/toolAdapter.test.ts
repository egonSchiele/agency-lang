import { describe, it, expect } from "vitest";
import { mcpToolToRegistryEntry, isMcpTool } from "./toolAdapter.js";
import type { McpTool } from "./types.js";

describe("isMcpTool", () => {
  it("should return true for MCP tool objects", () => {
    const tool: McpTool = {
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
  it("should produce a valid { definition, handler } pair that passes correct args", async () => {
    const tool: McpTool = {
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

    let capturedArgs: { serverName: string; toolName: string; args: Record<string, unknown> } | null = null;
    const mockCallTool = async (
      serverName: string,
      toolName: string,
      args: Record<string, unknown>,
    ) => {
      capturedArgs = { serverName, toolName, args };
      return "7";
    };

    const entry = mcpToolToRegistryEntry(tool, mockCallTool);

    expect(entry.definition.name).toBe("test__add");
    expect(entry.definition.description).toBe("Add two numbers");
    expect(entry.handler.name).toBe("test__add");
    expect(entry.handler.isBuiltin).toBe(false);
    expect(entry.handler.params).toEqual(["a", "b"]);

    // prompt.ts appends a context object as the last arg — include it to test stripping
    const result = await entry.handler.execute(3, 4, { ctx: null, threads: null, isToolCall: true });
    expect(result).toBe("7");

    // Verify callTool was called with the correct unprefixed tool name and args
    expect(capturedArgs).toEqual({
      serverName: "test",
      toolName: "add",
      args: { a: 3, b: 4 },
    });
  });

  it("should throw on malformed tool name without expected prefix", () => {
    const tool: McpTool = {
      name: "wrongprefix__add",
      description: "Add two numbers",
      serverName: "test",
      inputSchema: { type: "object", properties: {} },
      __mcpTool: true,
    };

    const mockCallTool = async () => "";

    expect(() => mcpToolToRegistryEntry(tool, mockCallTool)).toThrow(
      /expected prefix "test__"/,
    );
  });
});
