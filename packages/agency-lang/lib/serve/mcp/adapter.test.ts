import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createMcpHandler } from "./adapter.js";
import { AgencyFunction } from "../../runtime/agencyFunction.js";
import type { ExportedItem } from "../types.js";
import { PolicyStore } from "../policyStore.js";
import { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";

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

  it("appends interrupt kinds to tool description (no policy)", async () => {
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

describe("MCP adapter — policy tools", () => {
  let tmpDir: string;
  let handler: (msg: any) => Promise<any>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "mcp-policy-test-"));
    handler = createMcpHandler({
      serverName: "test-server",
      serverVersion: "1.0.0",
      exports: makeTestExports(),
      policyConfig: {
        policyStore: new PolicyStore("test-server", tmpDir),
        interruptHandlers: { hasInterrupts: () => false, respondToInterrupts: async () => "done" },
      },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists policy tools alongside agent tools", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = response!.result.tools.map((t: any) => t.name);
    expect(names).toContain("agencyGetPolicy");
    expect(names).toContain("agencyAddRule");
    expect(names).toContain("agencyRemoveRule");
    expect(names).toContain("agencyClearPolicy");
    expect(names).toContain("add");
  });

  it("agencyGetPolicy returns empty policy by default", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "agencyGetPolicy", arguments: {} },
    });
    expect(response!.result.isError).toBe(false);
    expect(JSON.parse(response!.result.content[0].text)).toEqual({});
  });

  it("agencyAddRule adds a rule and agencyGetPolicy returns it", async () => {
    const addResponse = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "agencyAddRule", arguments: { kind: "email::send", action: "approve", match: { recipient: "*@co.com" } } },
    });
    expect(addResponse!.result.isError).toBe(false);

    const getResponse = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "agencyGetPolicy", arguments: {} },
    });
    expect(JSON.parse(getResponse!.result.content[0].text)).toEqual({
      "email::send": [{ match: { recipient: "*@co.com" }, action: "approve" }],
    });
  });

  it("agencyRemoveRule removes a rule by index", async () => {
    await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "agencyAddRule", arguments: { kind: "x::y", action: "approve" } },
    });
    await handler({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "agencyAddRule", arguments: { kind: "x::y", action: "reject" } },
    });

    const removeResponse = await handler({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "agencyRemoveRule", arguments: { kind: "x::y", ruleIndex: 0 } },
    });
    expect(removeResponse!.result.isError).toBe(false);

    const getResponse = await handler({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "agencyGetPolicy", arguments: {} },
    });
    expect(JSON.parse(getResponse!.result.content[0].text)).toEqual({
      "x::y": [{ action: "reject" }],
    });
  });

  it("agencyRemoveRule returns error for invalid index", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "agencyRemoveRule", arguments: { kind: "x::y", ruleIndex: 0 } },
    });
    expect(response!.result.isError).toBe(true);
  });

  it("agencyClearPolicy resets to empty", async () => {
    await handler({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "agencyAddRule", arguments: { kind: "x::y", action: "approve" } },
    });

    const clearResponse = await handler({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "agencyClearPolicy", arguments: {} },
    });
    expect(clearResponse!.result.isError).toBe(false);

    const getResponse = await handler({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "agencyGetPolicy", arguments: {} },
    });
    expect(JSON.parse(getResponse!.result.content[0].text)).toEqual({});
  });

  it("agent tools still work when policyConfig is set", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "add", arguments: { a: 10, b: 20 } },
    });
    expect(response!.result.isError).toBe(false);
    expect(JSON.parse(response!.result.content[0].text)).toBe(30);
  });

  it("automatically rejects interrupts when no policy is set", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const greetFn = AgencyFunction.create(
      {
        name: "greet",
        module: "test",
        fn: async () => [
          { type: "interrupt", kind: "test::greet", message: "Greet?", data: {}, origin: "test", interruptId: "i1", runId: "r1" },
        ],
        params: [{ name: "name", hasDefault: false, defaultValue: undefined, variadic: false }],
        toolDefinition: { name: "greet", description: "Greet someone", schema: z.object({ name: z.string() }) },
        exported: true,
        safe: false,
      },
      registry,
    );

    let respondCalled = false;
    const policyHandler = createMcpHandler({
      serverName: "test",
      serverVersion: "1.0.0",
      exports: [
        { kind: "function", name: "greet", description: "Greet someone", agencyFunction: greetFn, interruptKinds: [{ kind: "test::greet" }] },
      ],
      policyConfig: {
        policyStore: new PolicyStore("test", tmpDir),
        interruptHandlers: {
          hasInterrupts: (data) => Array.isArray(data) && data.length > 0 && data[0]?.type === "interrupt",
          respondToInterrupts: async (_interrupts, responses) => {
            respondCalled = true;
            expect((responses[0] as any).type).toBe("reject");
            return "rejected";
          },
        },
      },
    });

    const response = await policyHandler({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "greet", arguments: { name: "Alice" } },
    });

    expect(respondCalled).toBe(true);
    expect(response!.result.isError).toBe(false);
    expect(JSON.parse(response!.result.content[0].text)).toBe("rejected");
  });

  it("approves interrupts when policy matches", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const sendFn = AgencyFunction.create(
      {
        name: "sendEmail",
        module: "test",
        fn: async () => [
          { type: "interrupt", kind: "email::send", message: "Send?", data: { recipient: "alice@company.com" }, origin: "test", interruptId: "i2", runId: "r2" },
        ],
        params: [],
        toolDefinition: { name: "sendEmail", description: "Send an email", schema: z.object({}) },
        exported: true,
        safe: false,
      },
      registry,
    );

    const store = new PolicyStore("test", tmpDir);
    store.set({ "email::send": [{ match: { recipient: "*@company.com" }, action: "approve" }] });

    const policyHandler = createMcpHandler({
      serverName: "test",
      serverVersion: "1.0.0",
      exports: [
        { kind: "function", name: "sendEmail", description: "Send an email", agencyFunction: sendFn, interruptKinds: [{ kind: "email::send" }] },
      ],
      policyConfig: {
        policyStore: store,
        interruptHandlers: {
          hasInterrupts: (data) => Array.isArray(data) && data.length > 0 && data[0]?.type === "interrupt",
          respondToInterrupts: async (_interrupts, responses) => {
            expect((responses[0] as any).type).toBe("approve");
            return "sent";
          },
        },
      },
    });

    const response = await policyHandler({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "sendEmail", arguments: {} },
    });

    expect(JSON.parse(response!.result.content[0].text)).toBe("sent");
  });
});
