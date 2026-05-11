import { describe, expect, it } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import { startMcpHttpServer } from "./httpTransport.js";
import { createMcpHandler } from "./adapter.js";
import { AgencyFunction } from "../../runtime/agencyFunction.js";
import type { ExportedItem } from "../types.js";
import { createLogger } from "../../logger.js";

function makeHandler() {
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
      toolDefinition: { name: "add", description: "Add two numbers", schema: null },
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
  ];
  return createMcpHandler({
    serverName: "test-mcp-http",
    serverVersion: "0.0.0",
    exports,
  });
}

async function withServer<T>(
  config: Parameters<typeof startMcpHttpServer>[0],
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = startMcpHttpServer({ ...config, port: 0 });
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
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/mcp",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          // Normalize header values to strings (node may give us string[]).
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) headers[k] = v.join(", ");
            else if (v !== undefined) headers[k] = v;
          }
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function baseConfig(overrides: Partial<Parameters<typeof startMcpHttpServer>[0]> = {}) {
  return {
    handler: makeHandler(),
    port: 0,
    logger: createLogger("error"),
    ...overrides,
  };
}

describe("MCP HTTP transport", () => {
  it("POST /mcp initialize returns serverInfo", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.result.serverInfo.name).toBe("test-mcp-http");
    });
  });

  it("POST /mcp tools/list lists exported tools", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.result.tools.map((t: any) => t.name)).toContain("add");
    });
  });

  it("POST /mcp tools/call invokes the function", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "add", arguments: { a: 2, b: 5 } },
        }),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.result.content[0].text).toBe("7");
    });
  });

  it("POST {custom path} works when --path is set", async () => {
    await withServer(baseConfig({ path: "/jsonrpc" }), async (port) => {
      const res = await request(port, {
        path: "/jsonrpc",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
      });
      expect(res.status).toBe(200);
    });
  });

  it("default path returns 404 when --path overrides it", async () => {
    await withServer(baseConfig({ path: "/jsonrpc" }), async (port) => {
      const res = await request(port, {
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }),
      });
      expect(res.status).toBe(404);
    });
  });

  it("GET on the MCP endpoint returns 405 with Allow: POST and an empty body", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, { method: "GET" });
      expect(res.status).toBe(405);
      expect(res.body).toBe("");
      expect(res.headers["allow"]).toBe("POST");
    });
  });

  it("non-JSON-object body returns 400", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { "content-type": "application/json" },
        body: "[1,2,3]",
      });
      expect(res.status).toBe(400);
    });
  });

  it("notification (no id) returns 202 with an empty body", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      expect(res.status).toBe(202);
      expect(res.body).toBe("");
    });
  });

  it("rejects unauthorized request (no Authorization header) when API key is configured", async () => {
    await withServer(baseConfig({ apiKey: "shh" }), async (port) => {
      const res = await request(port, {
        body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("rejects request with the wrong Bearer token", async () => {
    await withServer(baseConfig({ apiKey: "shh" }), async (port) => {
      const res = await request(port, {
        headers: { authorization: "Bearer wrong" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("accepts authorized request with correct key", async () => {
    await withServer(baseConfig({ apiKey: "shh" }), async (port) => {
      const res = await request(port, {
        headers: { authorization: "Bearer shh" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }),
      });
      expect(res.status).toBe(200);
    });
  });

  it("processes a JSON-RPC batch and returns an array of responses", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: "a", method: "ping" },
          {
            jsonrpc: "2.0",
            id: "b",
            method: "tools/call",
            params: { name: "add", arguments: { a: 10, b: 5 } },
          },
        ]),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      const byId = Object.fromEntries(body.map((r: any) => [r.id, r]));
      expect(byId.a.result).toEqual({});
      expect(byId.b.result.content[0].text).toBe("15");
    });
  });

  it("returns 202 with an empty body for a batch of only notifications", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", method: "notifications/initialized" },
        ]),
      });
      expect(res.status).toBe(202);
      expect(res.body).toBe("");
    });
  });

  it("rejects an empty batch with 400", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { "content-type": "application/json" },
        body: "[]",
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects a batch containing a non-object entry with 400", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, 7]),
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects forbidden Host header (DNS-rebinding defense)", async () => {
    await withServer(baseConfig(), async (port) => {
      const res = await request(port, {
        headers: { host: "evil.example.com" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }),
      });
      expect(res.status).toBe(403);
    });
  });

  it("refuses to start without API key on non-loopback host", () => {
    expect(() =>
      startMcpHttpServer({
        handler: makeHandler(),
        port: 0,
        host: "0.0.0.0",
        logger: createLogger("error"),
      }),
    ).toThrow(/Refusing to start.*non-loopback/);
  });
});
