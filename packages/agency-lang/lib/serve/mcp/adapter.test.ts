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
      interruptKinds: [],
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
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("add");
    expect(tools[0].description).toBe("Add two numbers");
    expect(tools[0].inputSchema).toBeTruthy();
    expect(tools[0].annotations.readOnlyHint).toBe(true);
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

  it("returns method not found for unknown methods", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "unknown/method",
    });
    expect(response).toBeTruthy();
    expect(response!.error.code).toBe(-32601);
  });

  it("appends interrupt kinds to tool description", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const deployFn = AgencyFunction.create(
      {
        name: "deploy",
        module: "test",
        fn: async () => {},
        params: [],
        toolDefinition: { name: "deploy", description: "Deploy app", schema: null },
        exported: true,
        safe: false,
      },
      registry,
    );
    const interruptHandler = createMcpHandler({
      serverName: "test",
      serverVersion: "1.0.0",
      exports: [
        {
          kind: "function",
          name: "deploy",
          description: "Deploy app",
          agencyFunction: deployFn,
          interruptKinds: [{ kind: "myapp::deploy" }, { kind: "myapp::approve" }],
        },
      ],
    });
    const response = await interruptHandler({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
    });
    const tools = response!.result.tools;
    expect(tools[0].description).toBe(
      "Deploy app\n\nInterrupt kinds: myapp::deploy, myapp::approve",
    );
  });
});
