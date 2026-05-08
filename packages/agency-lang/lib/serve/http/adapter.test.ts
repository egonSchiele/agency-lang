import { describe, expect, it } from "vitest";
import { createHttpHandler } from "./adapter.js";
import { AgencyFunction } from "../../runtime/agencyFunction.js";
import type { ExportedItem } from "../types.js";
import { createLogger } from "../../logger.js";

function makeExports(): {
  exports: ExportedItem[];
} {
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
        schema: null,
      },
      exported: true,
      safe: true,
    },
    registry,
  );

  const exports: ExportedItem[] = [
    {
      kind: "function",
      name: "add",
      description: "Add two numbers",
      agencyFunction: addFn,
    },
    {
      kind: "node",
      name: "main",
      parameters: [{ name: "message" }],
      invoke: async (args: Record<string, unknown>) => ({
        data: { echo: args.message },
        messages: {},
      }),
    },
  ];

  return { exports };
}

function makeHandler(apiKey?: string) {
  const { exports } = makeExports();
  return createHttpHandler({
    exports,
    port: 3000,
    apiKey,
    logger: createLogger("error"),
    hasInterrupts: () => false,
    respondToInterrupts: async () => ({ data: "resumed" }),
  });
}

describe("HTTP adapter", () => {
  const handler = makeHandler();

  it("GET /list returns manifest", async () => {
    const result = await handler("GET", "/list", undefined);
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.functions).toHaveLength(1);
    expect(body.functions[0].name).toBe("add");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].name).toBe("main");
  });

  it("POST /functions/:name calls function", async () => {
    const result = await handler("POST", "/functions/add", { a: 3, b: 4 });
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.success).toBe(true);
    expect(body.value).toBe(7);
  });

  it("POST /functions/:name returns 404 for unknown", async () => {
    const result = await handler("POST", "/functions/nope", {});
    expect(result.status).toBe(404);
  });

  it("POST /nodes/:name calls node", async () => {
    const result = await handler("POST", "/nodes/main", { message: "hello" });
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.success).toBe(true);
    expect(body.value).toEqual({ echo: "hello" });
  });

  it("POST /nodes/:name returns 404 for unknown", async () => {
    const result = await handler("POST", "/nodes/nope", {});
    expect(result.status).toBe(404);
  });

  it("POST /resume calls respondToInterrupts", async () => {
    const result = await handler("POST", "/resume", {
      interrupts: [{ id: "1" }],
      responses: [{ type: "approve" }],
    });
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.success).toBe(true);
  });

  it("POST /resume rejects non-array inputs", async () => {
    const result = await handler("POST", "/resume", {
      interrupts: "not-array",
      responses: "not-array",
    });
    expect(result.status).toBe(400);
  });

  it("returns 404 for unknown routes", async () => {
    const result = await handler("GET", "/unknown", undefined);
    expect(result.status).toBe(404);
  });
});

describe("HTTP auth", () => {
  const handler = makeHandler("my-secret");

  it("rejects requests without auth header", async () => {
    const result = await handler("GET", "/list", undefined);
    expect(result.status).toBe(401);
  });

  it("rejects requests with wrong key", async () => {
    const result = await handler("GET", "/list", undefined, "Bearer wrong");
    expect(result.status).toBe(401);
  });

  it("allows requests with correct key", async () => {
    const result = await handler("GET", "/list", undefined, "Bearer my-secret");
    expect(result.status).toBe(200);
  });
});
