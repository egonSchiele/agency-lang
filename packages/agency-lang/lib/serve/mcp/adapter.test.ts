import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpHandler } from "./adapter.js";
import { AgencyFunction } from "../../runtime/agencyFunction.js";
import type { ExportedItem } from "../types.js";

function makeTestExports(): ExportedItem[] {
  const registry: Record<string, AgencyFunction> = {};
  const addFn = AgencyFunction.create(
    {
      name: "add",
      module: "test",
      fn: async (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: {
        name: "add",
        description: "Add two numbers",
        schema: z.object({ a: z.number(), b: z.number() }),
      },
      exported: true,
      safe: true,
    },
    registry,
  );

  return [
    {
      kind: "function",
      name: "add",
      description: "Add two numbers",
      agencyFunction: addFn,
    },
    {
      kind: "node",
      name: "main",
      parameters: [{ name: "city" }, { name: "country" }],
      invoke: async (...args: unknown[]) => ({ data: `${args[0]}, ${args[1]}` }),
    },
  ];
}

describe("MCP adapter", () => {
  const handler = createMcpHandler({
    serverName: "test-server",
    serverVersion: "1.0.0",
    exports: makeTestExports(),
  });

  it("responds to initialize", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test" },
      },
    });
    expect(response).toBeTruthy();
    expect(response!.result.serverInfo.name).toBe("test-server");
    expect(response!.result.capabilities.tools).toBeTruthy();
  });

  it("lists tools with schema and annotations", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(response).toBeTruthy();
    const tools = response!.result.tools;
    expect(tools).toHaveLength(2);
    const addTool = tools.find((t: any) => t.name === "add");
    expect(addTool.description).toBe("Add two numbers");
    expect(addTool.inputSchema).toBeTruthy();
    expect(addTool.annotations.readOnlyHint).toBe(true);
  });

  it("calls a tool and returns result", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "add", arguments: { a: 3, b: 4 } },
    });
    expect(response).toBeTruthy();
    expect(response!.result.isError).toBe(false);
    const content = response!.result.content;
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0].text)).toBe(7);
  });

  it("returns error for unknown tool", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });
    expect(response).toBeTruthy();
    expect(response!.error).toBeTruthy();
    expect(response!.error.code).toBe(-32602);
  });

  it("returns null for notifications/initialized", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response).toBeNull();
  });

  it("lists nodes as tools", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
    });
    const tools = response!.result.tools;
    const nodeTool = tools.find((t: any) => t.name === "main");
    expect(nodeTool).toBeTruthy();
    expect(nodeTool.inputSchema).toEqual({
      type: "object",
      properties: {
        city: { type: "string" },
        country: { type: "string" },
      },
      required: ["city", "country"],
    });
  });

  it("calls a node via tools/call with positional arg mapping", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "main", arguments: { city: "Paris", country: "France" } },
    });
    expect(response!.result.isError).toBe(false);
    expect(JSON.parse(response!.result.content[0].text)).toBe("Paris, France");
  });

  it("returns method not found for unknown methods", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "unknown/method",
    });
    expect(response).toBeTruthy();
    expect(response!.error.code).toBe(-32601);
  });
});
