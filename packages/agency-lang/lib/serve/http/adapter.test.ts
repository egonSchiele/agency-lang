import { describe, expect, it } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import { createHttpHandler, startHttpServer } from "./adapter.js";
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

function makeHandler() {
  const { exports } = makeExports();
  return createHttpHandler({
    exports,
    port: 3545,
    logger: createLogger("error"),
    hasInterrupts: () => false,
    respondToInterrupts: async () => ({ data: "resumed" }),
  });
}

async function withServer<T>(
  config: Parameters<typeof startHttpServer>[0],
  fn: (port: number) => Promise<T>,
): Promise<T> {
  // Use port 0 to let the OS assign a free port for the test.
  const server = startHttpServer({ ...config, port: 0 });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function request(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/list",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
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

describe("startHttpServer auth and host validation", () => {
  function baseConfig(overrides: Partial<Parameters<typeof startHttpServer>[0]> = {}) {
    const { exports } = makeExports();
    return {
      exports,
      port: 0,
      logger: createLogger("error"),
      hasInterrupts: () => false,
      respondToInterrupts: async () => ({ data: "resumed" }),
      ...overrides,
    };
  }

  it("rejects requests without auth header when key is configured", async () => {
    await withServer(baseConfig({ apiKey: "my-secret" }), async (port) => {
      const res = await request(port);
      expect(res.status).toBe(401);
    });
  });

  it("rejects requests with wrong key", async () => {
    await withServer(baseConfig({ apiKey: "my-secret" }), async (port) => {
      const res = await request(port, { headers: { authorization: "Bearer wrong" } });
      expect(res.status).toBe(401);
    });
  });

  it("accepts requests with correct key", async () => {
    await withServer(baseConfig({ apiKey: "my-secret" }), async (port) => {
      const res = await request(port, { headers: { authorization: "Bearer my-secret" } });
      expect(res.status).toBe(200);
    });
  });

  it("rejects requests with disallowed Host header (DNS-rebinding defense)", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, { headers: { host: "evil.example.com" } });
      expect(res.status).toBe(403);
    });
  });

  it("allows requests with localhost Host header by default", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, { headers: { host: `localhost:${port}` } });
      expect(res.status).toBe(200);
    });
  });

  it("Host validation runs before auth (forbidden host gets 403, not 401)", async () => {
    await withServer(baseConfig({ apiKey: "my-secret" }), async (port) => {
      // Wrong host AND missing auth — should return 403, not 401.
      const res = await request(port, { headers: { host: "evil.example.com" } });
      expect(res.status).toBe(403);
    });
  });

  it("auth runs before body parsing (POST without auth returns 401)", async () => {
    await withServer(baseConfig({ apiKey: "my-secret" }), async (port) => {
      const res = await request(port, {
        method: "POST",
        path: "/function/add",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1, b: 2 }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("refuses to start without API key on non-loopback host", () => {
    const { exports } = makeExports();
    expect(() =>
      startHttpServer({
        exports,
        port: 0,
        host: "0.0.0.0",
        logger: createLogger("error"),
        hasInterrupts: () => false,
        respondToInterrupts: async () => ({ data: "x" }),
      }),
    ).toThrow(/Refusing to start.*non-loopback/);
  });

  it("function errors are sanitized in the response body", async () => {
    const { exports } = makeExports();
    const registry: Record<string, AgencyFunction> = {};
    const failFn = AgencyFunction.create(
      {
        name: "fail",
        module: "test",
        fn: async () => {
          throw new Error("internal secret: sk-abc123");
        },
        params: [],
        toolDefinition: { name: "fail", description: "", schema: null },
        exported: true,
        safe: true,
      },
      registry,
    );
    const exportsWithFail: ExportedItem[] = [
      ...exports,
      {
        kind: "function",
        name: "fail",
        description: "",
        agencyFunction: failFn,
        interruptKinds: [],
      },
    ];
    await withServer(baseConfig({ exports: exportsWithFail }), async (port) => {
      const res = await request(port, {
        method: "POST",
        path: "/function/fail",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).not.toContain("sk-abc123");
      expect(body.error).not.toContain("internal secret");
    });
  });
});
