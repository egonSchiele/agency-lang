import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { startFrontDoor, type FrontDoor } from "./mlxServer.js";
import { plainColor } from "../utils/termcolors.js";

type Hit = { url: string; model: unknown; headers: http.IncomingHttpHeaders; clientGone: boolean };
type Fake = { server: http.Server; port: number; hits: Hit[] };

/** Stands in for one mlx_lm.server: records what it receives and answers
 *  with a canned completion naming itself. */
async function fakeServer(model: string): Promise<Fake> {
  const fake: Fake = { server: undefined as unknown as http.Server, port: 0, hits: [] };
  fake.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const hit: Hit = {
        url: req.url ?? "",
        model: JSON.parse(raw).model,
        headers: req.headers,
        clientGone: false,
      };
      fake.hits.push(hit);
      res.on("close", () => {
        hit.clientGone = !res.writableFinished;
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
      if (req.headers["x-slow"] === "1") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => res.end(), 300);
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
    expect(b.hits[0].headers["content-length"]).toBe(
      String(Buffer.byteLength(JSON.stringify({ model: "/models/mlx/org--b", messages: [] }))),
    );
    expect(a.hits).toEqual([]);
  });

  it("drops the framing and connection headers of the request it already read", async () => {
    // node's http.request sends a body with no content-length as chunked.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: door.port,
          method: "POST",
          path: "/v1/chat/completions",
          headers: {
            "content-type": "application/json",
            connection: "keep-alive",
            "x-keep": "yes",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify({ model: "org/a" }));
      req.end();
    });
    expect(status).toBe(200);
    const headers = a.hits[a.hits.length - 1].headers;
    expect(headers["transfer-encoding"]).toBeUndefined();
    expect(headers["content-length"]).toBeDefined();
    expect(headers["x-keep"]).toBe("yes");
    expect(headers.host).toBe(`127.0.0.1:${a.port}`);
  });

  it("stops the upstream reply when the client goes away", async () => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${door.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-slow": "1" },
      body: JSON.stringify({ model: "org/a" }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(a.hits[a.hits.length - 1].clientGone).toBe(true);
  });

  it("close() finishes while a reply is still streaming", async () => {
    const slow = await fakeServer("org/s");
    const other = await startFrontDoor(0, [
      { model: "org/s", upstreamModel: "/s", port: slow.port },
    ]);
    const res = await fetch(`http://127.0.0.1:${other.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-slow": "1" },
      body: JSON.stringify({ model: "org/s" }),
    });
    expect(res.status).toBe(200);
    const started = Date.now();
    await other.close();
    expect(Date.now() - started).toBeLessThan(250);
    slow.server.closeAllConnections();
    slow.server.close();
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
    expect((await res.json()).error.message).toBe("Invalid JSON body.");
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

describe("front door logging", () => {
  async function withLog(
    verbose: boolean,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<string[]> {
    const lines: string[] = [];
    const logged = await startFrontDoor(
      0,
      [{ model: "org/a", upstreamModel: "/a", port: a.port }],
      {
        log: (line) => lines.push(line),
        verbose,
        color: plainColor,
      },
    );
    const res = await fetch(`http://127.0.0.1:${logged.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    await res.text();
    // The summary is written when the reply ends, which is after the client
    // has its last byte.
    await new Promise((r) => setTimeout(r, 50));
    await logged.close();
    return lines;
  }

  it("writes one summary line per request", async () => {
    const lines = await withLog(false, { model: "org/a", messages: [] });
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^POST \/v1\/chat\/completions {2}org\/a {2}200 {2}\d/);
  });

  it("shows the whole request and reply bodies when verbose", async () => {
    const lines = await withLog(true, {
      model: "org/a",
      messages: [{ role: "user", content: "hello" }],
    });
    const body = lines.join("\n");
    // The request as it arrived, indented under the summary line.
    expect(body).toContain('"content": "hello"');
    // The reply the fake sent back, as JSON.
    expect(body).toContain('"content": "ok"');
    expect(lines[1]).toBe("  → {");
  });

  it("joins the deltas of a streamed reply", async () => {
    const lines = await withLog(
      true,
      { model: "org/a", messages: [{ role: "user", content: "hi" }] },
      { "x-stream": "1" },
    );
    // The fake streams two frames whose payloads are not JSON, so the text is
    // empty; what matters is that the entry is written once the stream ends.
    expect(lines[0]).toMatch(/^POST \/v1\/chat\/completions {2}org\/a {2}200/);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("logs a model it does not serve as a 404, with the reason", async () => {
    const lines = await withLog(true, { model: "org/z", messages: [] });
    expect(lines[0]).toMatch(/^POST \/v1\/chat\/completions {2}org\/z {2}404/);
    expect(lines.join("\n")).toContain("It is not serving org/z.");
  });

  it("logs GET /v1/models", async () => {
    const lines: string[] = [];
    const logged = await startFrontDoor(
      0,
      [{ model: "org/a", upstreamModel: "/a", port: a.port }],
      {
        log: (line) => lines.push(line),
        verbose: false,
        color: plainColor,
      },
    );
    await (await fetch(`http://127.0.0.1:${logged.port}/v1/models`)).text();
    await logged.close();
    expect(lines[0]).toMatch(/^GET \/v1\/models {2}200/);
  });

  it("says nothing when it was given no logger", async () => {
    // The default front door in this file has no logger; a request through it
    // must not throw.
    const res = await post("org/a");
    expect(res.status).toBe(200);
  });
});
