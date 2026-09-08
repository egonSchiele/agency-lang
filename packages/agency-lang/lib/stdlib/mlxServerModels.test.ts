import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { _mlxServerModels, mlxBaseUrl, MLX_DEFAULT_BASE_URL } from "./mlxServerModels.js";

describe("mlxBaseUrl", () => {
  it("an explicit URL, then MLX_BASE_URL, then the default", () => {
    const saved = process.env.MLX_BASE_URL;
    delete process.env.MLX_BASE_URL;
    expect(mlxBaseUrl("http://x:1/v1")).toBe("http://x:1/v1");
    expect(mlxBaseUrl()).toBe(MLX_DEFAULT_BASE_URL);
    process.env.MLX_BASE_URL = "http://y:2/v1";
    expect(mlxBaseUrl()).toBe("http://y:2/v1");
    if (saved === undefined) delete process.env.MLX_BASE_URL;
    else process.env.MLX_BASE_URL = saved;
  });
});

describe("_mlxServerModels", () => {
  it("reads the served list from GET /v1/models, and null when nothing listens", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "org/a" }, { id: "org/b" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect(await _mlxServerModels(`http://127.0.0.1:${port}/v1`)).toEqual(["org/a", "org/b"]);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await _mlxServerModels(`http://127.0.0.1:${port}/v1`)).toBeNull();
  });
});
