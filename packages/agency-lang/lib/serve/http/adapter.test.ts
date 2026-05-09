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
      interruptKinds: [],
    },
    {
      kind: "node",
      name: "main",
      parameters: [{ name: "message" }],
      invoke: async (message: unknown) => ({
        data: { echo: message },
        messages: {},
      }),
      interruptKinds: [],
    },
  ];

  return { exports };
}

function makeHandler(apiKey?: string) {
  const { exports } = makeExports();
  return createHttpHandler({
    exports,
    port: 3545,
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
    expect(body.functions[0].interruptKinds).toEqual([]);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].name).toBe("main");
    expect(body.nodes[0].interruptKinds).toEqual([]);
  });

  it("POST /function/:name calls function", async () => {
    const result = await handler("POST", "/function/add", { a: 3, b: 4 });
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.success).toBe(true);
    expect(body.value).toBe(7);
  });

  it("POST /function/:name returns 404 for unknown", async () => {
    const result = await handler("POST", "/function/nope", {});
    expect(result.status).toBe(404);
  });

  it("POST /node/:name calls node", async () => {
    const result = await handler("POST", "/node/main", { message: "hello" });
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.success).toBe(true);
    expect(body.value).toEqual({ echo: "hello" });
  });

  it("POST /node/:name returns 404 for unknown", async () => {
    const result = await handler("POST", "/node/nope", {});
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

  it("GET /list includes interruptKinds as string arrays", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const deployFn = AgencyFunction.create(
      {
        name: "deploy",
        module: "test",
        fn: async () => {},
        params: [],
        toolDefinition: { name: "deploy", description: "Deploy", schema: null },
        exported: true,
        safe: false,
      },
      registry,
    );
    const h = createHttpHandler({
      exports: [
        {
          kind: "function",
          name: "deploy",
          description: "Deploy",
          agencyFunction: deployFn,
          interruptKinds: [{ kind: "myapp::deploy" }],
        },
      ],
      port: 3545,
      logger: createLogger("error"),
      hasInterrupts: () => false,
      respondToInterrupts: async () => ({ data: "ok" }),
    });
    const result = await h("GET", "/list", undefined);
    const body = result.body as any;
    expect(body.functions[0].interruptKinds).toEqual(["myapp::deploy"]);
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
