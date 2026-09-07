import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { startFrontDoor, type FrontDoor } from "./mlxFrontDoor.js";

type Hit = { url: string; model: unknown; contentLength: number };
type Fake = { server: http.Server; port: number; hits: Hit[] };

/** Stands in for one mlx_lm.server: records what it receives and answers
 *  with a canned completion naming itself. */
async function fakeServer(model: string): Promise<Fake> {
  const fake: Fake = { server: undefined as unknown as http.Server, port: 0, hits: [] };
  fake.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      fake.hits.push({
        url: req.url ?? "",
        model: JSON.parse(raw).model,
        contentLength: Number(req.headers["content-length"]),
      });
      if (req.headers["x-stream"] === "1") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => {
          res.write("data: two\n\n");
          res.end();
        }, 20);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ model, choices: [{ message: { role: "assistant", content: "ok" } }] }),
      );
    });
  });
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
  fake.port = (fake.server.address() as { port: number }).port;
  return fake;
}

let a: Fake;
let b: Fake;
let door: FrontDoor;

beforeAll(async () => {
  a = await fakeServer("org/a");
  b = await fakeServer("org/b");
  door = await startFrontDoor(0, [
    { model: "org/a", upstreamModel: "/models/mlx/org--a", port: a.port },
    { model: "org/b", upstreamModel: "/models/mlx/org--b", port: b.port },
  ]);
});

afterAll(async () => {
  await door.close();
  a.server.close();
  b.server.close();
});

async function post(model: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${door.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [] }),
  });
}

describe("front door", () => {
  it("forwards to the process whose model matches, naming the model it was started with", async () => {
    const res = await post("org/b");
    expect(res.status).toBe(200);
    expect((await res.json()).model).toBe("org/b");
    expect(b.hits.length).toBe(1);
    expect(b.hits[0].url).toBe("/v1/chat/completions");
    expect(b.hits[0].model).toBe("/models/mlx/org--b");
    expect(b.hits[0].contentLength).toBe(
      Buffer.byteLength(JSON.stringify({ model: "/models/mlx/org--b", messages: [] })),
    );
    expect(a.hits).toEqual([]);
  });

  it("streams a reply through unchanged", async () => {
    const res = await post("org/a", { "x-stream": "1" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("refuses a model it does not serve, and no process sees it", async () => {
    const before = a.hits.length + b.hits.length;
    const res = await post("org/c");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toBe(
      "This server is serving org/a and org/b. It is not serving org/c. Start it with: agency local serve mlx:org/c",
    );
    expect(a.hits.length + b.hits.length).toBe(before);
  });

  it("refuses a request with no model field", async () => {
    const res = await fetch(`http://127.0.0.1:${door.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(
      "The request names no model. Set the model field to one of: org/a, org/b.",
    );
  });

  it("refuses a body that is not JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${door.port}/v1/chat/completions`, {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("lists the served models on GET /v1/models", async () => {
    const res = await fetch(`http://127.0.0.1:${door.port}/v1/models`);
    expect((await res.json()).data.map((m: { id: string }) => m.id)).toEqual(["org/a", "org/b"]);
  });

  it("answers 502 when the process is gone", async () => {
    const dead = await fakeServer("org/d");
    await new Promise<void>((r) => dead.server.close(() => r()));
    const other = await startFrontDoor(0, [
      { model: "org/d", upstreamModel: "/d", port: dead.port },
    ]);
    const res = await fetch(`http://127.0.0.1:${other.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "org/d" }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/^mlx_lm.server for org\/d: /);
    await other.close();
  });
});
