import { describe, it, expect } from "vitest";
import { mcpToolToAgencyFunction, isMcpTool } from "../src/toolAdapter.js";
import type { McpTool } from "../src/types.js";

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

describe("mcpToolToAgencyFunction", () => {
  it("should produce an AgencyFunction that passes correct args via invoke", async () => {
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

    const fn = mcpToolToAgencyFunction(tool, mockCallTool);

    expect(fn.name).toBe("test__add");
    expect(fn.module).toBe("mcp:test");
    expect(fn.toolDefinition!.name).toBe("test__add");
    expect(fn.toolDefinition!.description).toBe("Add two numbers");
    expect(fn.params.map(p => p.name)).toEqual(["a", "b"]);

    // Invoke with named args (as runPrompt does for tool calls)
    const result = await fn.invoke(
      { type: "named", positionalArgs: [], namedArgs: { a: 3, b: 4 } },
      { ctx: null, threads: null, isToolCall: true },
    );
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

    expect(() => mcpToolToAgencyFunction(tool, mockCallTool)).toThrow(
      /expected prefix "test__"/,
    );
  });
});
