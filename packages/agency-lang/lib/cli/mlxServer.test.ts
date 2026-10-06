import { MLX_VLM_RULES } from "./vlmChat.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { servedModelFor, startFrontDoor, type DoorLogging, type FrontDoor } from "./mlxServer.js";
import { createModelPool, type ModelPool } from "./modelPool.js";
import type { RequestRules } from "./requestRules.js";
import type { Child } from "./localServe.js";
import { plainColor } from "../utils/termcolors.js";
import { localBodyBytes } from "../stdlib/localImageInputs.js";
import { visionBodyBytes } from "../stdlib/vision.js";

type Hit = {
  url: string;
  model: unknown;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
  clientGone: boolean;
};
type Fake = { server: http.Server; port: number; hits: Hit[] };

/** Stands in for one mlx_lm.server: records what it receives and answers
 *  with a canned completion naming itself. */
async function fakeServer(model: string): Promise<Fake> {
  const fake: Fake = { server: undefined as unknown as http.Server, port: 0, hits: [] };
  fake.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const hit: Hit = {
        url: req.url ?? "",
        model: body.model,
        body,
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

/** One process a test door forwards to, already listening on `port`. */
type Route = {
  model: string;
  upstreamModel: string;
  port: number;
  label: string;
  rules?: RequestRules | null;
};

/** A stand-in for a model process: it exits when it is told to stop. */
function exitsWhenKilled(): Child {
  const listeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  return {
    on: (_event, listener) => listeners.push(listener),
    kill: () => listeners.forEach((listener) => listener(null, "SIGTERM")),
  };
}

/** A pool whose models are all loaded, each on the port a test server is
 *  already listening on. Nothing is spawned. */
async function readyPool(routes: Route[]): Promise<ModelPool> {
  const pool = createModelPool(
    routes.map((route) => ({
      model: route.model,
      upstreamModel: route.upstreamModel,
      label: route.label,
      kind: "chat" as const,
      rules: route.rules ?? null,
      lazy: false,
      needBytes: 0,
    })),
    {
      now: Date.now,
      spawn: async (plan) => ({
        child: exitsWhenKilled(),
        port: routes.find((route) => route.model === plan.model)!.port,
      }),
      waitReady: async () => {},
      availableMemory: async () => ({ available: 1e12, total: 1e12 }),
      allowOvercommit: false,
      log: () => {},
    },
  );
  for (const route of routes) {
    await pool.load(route.model);
  }
  return pool;
}

/** A front door over `routes`, as a test wants one. */
async function startDoor(
  port: number,
  routes: Route[],
  logging?: DoorLogging,
  maxTokens?: number,
): Promise<FrontDoor> {
  return startFrontDoor(port, await readyPool(routes), logging, maxTokens);
}

let a: Fake;
let b: Fake;
let door: FrontDoor;

beforeAll(async () => {
  a = await fakeServer("org/a");
  b = await fakeServer("org/b");
  door = await startDoor(0, [
    {
      model: "org/a",
      upstreamModel: "/models/mlx/org--a",
      port: a.port,
      label: "mlx_lm.server for org/a",
    },
    {
      model: "org/b",
      upstreamModel: "/models/mlx/org--b",
      port: b.port,
      label: "mlx_lm.server for org/b",
    },
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

  it("forwards /v1/embeddings the same way, so an embedding process needs no route of its own", async () => {
    const res = await fetch(`http://127.0.0.1:${door.port}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "org/a", input: ["hi"] }),
    });
    expect(res.status).toBe(200);
    const hit = a.hits[a.hits.length - 1];
    expect(hit.url).toBe("/v1/embeddings");
    expect(hit.model).toBe("/models/mlx/org--a");
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

  it("holds a request's reply length to the server's --max-tokens", async () => {
    const capped = await startDoor(
      0,
      [{ model: "org/a", upstreamModel: "/models/mlx/org--a", port: a.port, label: "a" }],
      undefined,
      100,
    );
    const send = async (body: Record<string, unknown>) => {
      const res = await fetch(`http://127.0.0.1:${capped.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "org/a", ...body }),
      });
      expect(res.status).toBe(200);
      return a.hits[a.hits.length - 1].body;
    };
    expect((await send({ max_tokens: 30000 })).max_tokens).toBe(100);
    expect((await send({ max_completion_tokens: 30000 })).max_completion_tokens).toBe(100);
    expect((await send({ max_tokens: 50 })).max_tokens).toBe(50);
    expect((await send({})).max_tokens).toBeUndefined();
    await capped.close();
  });

  it("leaves the reply length alone when the door has no limit", async () => {
    const res = await fetch(`http://127.0.0.1:${door.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "org/a", max_tokens: 30000 }),
    });
    expect(res.status).toBe(200);
    expect(a.hits[a.hits.length - 1].body.max_tokens).toBe(30000);
  });

  it("close() finishes while a reply is still streaming", async () => {
    const slow = await fakeServer("org/s");
    const other = await startDoor(0, [
      { model: "org/s", upstreamModel: "/s", port: slow.port, label: "mlx_lm.server for org/s" },
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

  it("routes default_model to the one model served, and refuses it among several", async () => {
    expect(servedModelFor(["org/a"], "default_model")).toBe("org/a");
    expect(servedModelFor(["org/a"], "org/b")).toBeUndefined();
    expect(servedModelFor(["org/a", "org/b"], "org/b")).toBe("org/b");
    // This door serves org/a and org/b, so the alias names neither.
    const res = await post("default_model");
    expect(res.status).toBe(404);
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
    const other = await startDoor(0, [
      {
        model: "org/d",
        upstreamModel: "/d",
        port: dead.port,
        label: "the speech server for org/d",
      },
    ]);
    const res = await fetch(`http://127.0.0.1:${other.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "org/d" }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/^the speech server for org\/d: /);
    await other.close();
  });

  describe("body limits", () => {
    /** A request to `route` whose body is about `bytes` long: a model and
     *  one long field. */
    function bigPost(route: string, bytes: number) {
      return fetch(`http://127.0.0.1:${door.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "org/a", prompt: "a cat", control_image: "A".repeat(bytes) }),
      });
    }

    it("forwards a 20 MB image request whole", async () => {
      const res = await bigPost("/v1/images/generations", 20_000_000);
      expect(res.status).toBe(200);
      const hit = a.hits[a.hits.length - 1];
      expect(hit.url).toBe("/v1/images/generations");
      expect(hit.body).toEqual({
        model: "/models/mlx/org--a",
        prompt: "a cat",
        control_image: "A".repeat(20_000_000),
      });
    });

    it("forwards a 20 MB chat request", async () => {
      const before = a.hits.length;
      const res = await bigPost("/v1/chat/completions", 20_000_000);
      expect(res.status).toBe(200);
      expect(a.hits.length).toBe(before + 1);
    });

    it("forwards a 20 MB vision request whole, which the default limit refused", async () => {
      const res = await bigPost("/v1/vision/detections", 20_000_000);
      expect(res.status).toBe(200);
      expect(a.hits[a.hits.length - 1].url).toBe("/v1/vision/detections");
    });

    it("refuses a vision request over the vision server's limit with a 413", async () => {
      const before = a.hits.length;
      const res = await bigPost("/v1/vision/detections", visionBodyBytes());
      expect(res.status).toBe(413);
      expect(a.hits.length).toBe(before);
    });

    it("refuses an image request over the image server's limit with a 413", async () => {
      const before = a.hits.length;
      const res = await bigPost("/v1/images/generations", localBodyBytes());
      expect(res.status).toBe(413);
      expect(a.hits.length).toBe(before);
    });
  });
});

describe("front door logging", () => {
  async function withLog(
    verbose: boolean,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<string[]> {
    const lines: string[] = [];
    const logged = await startDoor(
      0,
      [{ model: "org/a", upstreamModel: "/a", port: a.port, label: "mlx_lm.server for org/a" }],
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

  it("logs the error body it sent for a body that is not JSON", async () => {
    const lines: string[] = [];
    const logged = await startDoor(
      0,
      [{ model: "org/a", upstreamModel: "/a", port: a.port, label: "mlx_lm.server for org/a" }],
      {
        log: (line) => lines.push(line),
        verbose: true,
        color: plainColor,
      },
    );
    const res = await fetch(`http://127.0.0.1:${logged.port}/v1/chat/completions`, {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
    await res.text();
    await logged.close();
    expect(lines[0]).toMatch(/^POST \/v1\/chat\/completions {2}400/);
    expect(lines.join("\n")).toContain("Invalid JSON body.");
  });

  it("logs GET /v1/models", async () => {
    const lines: string[] = [];
    const logged = await startDoor(
      0,
      [{ model: "org/a", upstreamModel: "/a", port: a.port, label: "mlx_lm.server for org/a" }],
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

describe("front door request rules", () => {
  let upstream: Fake;
  let guarded: FrontDoor;
  const lines: string[] = [];
  beforeAll(async () => {
    upstream = await fakeServer("vision");
    guarded = await startDoor(
      0,
      [
        {
          model: "vision",
          upstreamModel: "/models/vision",
          port: upstream.port,
          label: "mlx_vlm.server",
          rules: MLX_VLM_RULES,
        },
      ],
      { verbose: false, color: plainColor, log: (line) => lines.push(line) },
      20,
    );
  });
  afterAll(async () => {
    await guarded.close();
    upstream.server.close();
  });
  const send = (
    body: Record<string, unknown>,
    route = "/v1/chat/completions",
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${guarded.port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "vision", ...body }),
    });

  it("translates thinking, caps tokens, and rewrites the model", async () => {
    const response = await send({
      messages: [{ content: "hi" }],
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 100,
    });
    expect(response.status).toBe(200);
    expect(upstream.hits.at(-1)?.body).toEqual({
      model: "/models/vision",
      messages: [{ content: "hi" }],
      enable_thinking: false,
      max_tokens: 20,
    });
  });
  it.each(["/some/local/adapter", null])(
    "refuses adapter_path %j without contacting upstream",
    async (adapter_path) => {
      const before = upstream.hits.length;
      const response = await send({ messages: [{ content: "hi" }], adapter_path });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: "The field adapter_path is not supported by the server for this model." },
      });
      expect(upstream.hits.length).toBe(before);
    },
  );
  it.each([
    [10, 10],
    [100, 20],
  ])("normalizes max_completion_tokens %s and caps it at %s", async (requested, expected) => {
    const response = await send({
      messages: [{ content: "hi" }],
      max_completion_tokens: requested,
    });
    expect(response.status).toBe(200);
    expect(upstream.hits.at(-1)?.body).toEqual({
      model: "/models/vision",
      messages: [{ content: "hi" }],
      max_tokens: expected,
    });
  });
  it("refuses conflicting token limits before capping or forwarding", async () => {
    const before = upstream.hits.length;
    const response = await send({ max_completion_tokens: 100, max_tokens: 200 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "Conflicting fields max_completion_tokens and max_tokens." },
    });
    expect(upstream.hits.length).toBe(before);
  });
  it("logs refusals without contacting the upstream", async () => {
    const before = upstream.hits.length;
    const response = await send({}, "/unload");
    expect(response.status).toBe(404);
    expect(upstream.hits.length).toBe(before);
    expect(lines.at(-1)).toContain("404");
  });
  it("forwards a stream through rules", async () => {
    const response = await send({ messages: [] }, undefined, { "x-stream": "1" });
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  });
  it("closes upstream when the stream client disconnects", async () => {
    const response = await send({ messages: [] }, undefined, { "x-slow": "1" });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(upstream.hits.at(-1)?.clientGone).toBe(true);
  });
  it("refuses an oversized chat body", async () => {
    const before = upstream.hits.length;
    const response = await send({ messages: [], padding: "a".repeat(localBodyBytes()) });
    expect(response.status).toBe(413);
    expect(upstream.hits.length).toBe(before);
  });
});

describe("front door over a pool", () => {
  let upstream: Fake;
  let pool: ModelPool;
  let pooled: FrontDoor;

  beforeAll(async () => {
    upstream = await fakeServer("org/a");
    pool = await readyPool([
      {
        model: "org/a",
        upstreamModel: "/models/mlx/org--a",
        port: upstream.port,
        label: "mlx_lm.server for org/a",
        rules: MLX_VLM_RULES,
      },
      // Nothing listens on port 1, so a request for this model is refused
      // by the operating system.
      { model: "org/dead", upstreamModel: "/models/dead", port: 1, label: "the dead server" },
    ]);
    pooled = await startFrontDoor(0, pool);
  });

  afterAll(async () => {
    await pooled.close();
    upstream.server.close();
  });

  const url = (path: string) => `http://127.0.0.1:${pooled.port}${path}`;
  const inProgress = (model: string) =>
    pool.status().find((row) => row.model === model)?.requestsInProgress;

  function chat(model: string, extra: Record<string, unknown> = {}, headers = {}) {
    return fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, messages: [], ...extra }),
    });
  }

  /** Waits until no request is in progress on `model`, or fails. */
  async function expectIdle(model: string): Promise<void> {
    await expect.poll(() => inProgress(model), { timeout: 2000 }).toBe(0);
  }

  it("reports each model's state on GET /v1/agency/status", async () => {
    const res = await fetch(url("/v1/agency/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Record<string, unknown>[] };
    expect(body.models.map((row) => [row.model, row.state])).toEqual([
      ["org/a", "ready"],
      ["org/dead", "ready"],
    ]);
    expect(body.models[0]).toMatchObject({ error: null, requestsInProgress: 0 });
  });

  it("refuses the status route to a request made under another hostname", async () => {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: pooled.port,
          path: "/v1/agency/status",
          headers: { host: "evil.example" },
        },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });
    res.resume();
    expect(res.statusCode).toBe(403);
  });

  it("answers the status route to localhost as well as 127.0.0.1", async () => {
    const res = await fetch(`http://localhost:${pooled.port}/v1/agency/status`).catch(() => null);
    // A machine whose localhost is IPv6 only cannot reach the door at all.
    if (res !== null) {
      expect(res.status).toBe(200);
    }
  });

  it("counts a request while it runs, and not after it ends", async () => {
    const pending = chat("org/a", {}, { "x-slow": "1" });
    await expect.poll(() => inProgress("org/a"), { timeout: 2000 }).toBe(1);
    await (await pending).text();
    await expectIdle("org/a");
  });

  it("stops counting a request whose client left mid-reply", async () => {
    const controller = new AbortController();
    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-slow": "1" },
      body: JSON.stringify({ model: "org/a", messages: [] }),
      signal: controller.signal,
    });
    expect(inProgress("org/a")).toBe(1);
    controller.abort();
    await res.text().catch(() => "");
    await expectIdle("org/a");
  });

  it("stops counting a request whose process refused the connection", async () => {
    const res = await chat("org/dead");
    expect(res.status).toBe(502);
    await expectIdle("org/dead");
  });

  it("never holds a model for a request the rules refuse", async () => {
    const before = pool.status()[0].lastUsedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await chat("org/a", { max_tokens: 5, max_completion_tokens: 6 });
    expect(res.status).toBe(400);
    expect(pool.status()[0].lastUsedAt).toBe(before);
  });

  it("answers 503, with how to load it, for a model that was unloaded", async () => {
    await pool.unload("org/dead");
    const res = await chat("org/dead");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'org/dead was unloaded. Load it again with server.load("org/dead"), or restart the server.',
    );
    // It is still listed: a caller asks /v1/models what it may request.
    const listed = (await (await fetch(url("/v1/models"))).json()) as { data: { id: string }[] };
    expect(listed.data.map((row) => row.id)).toEqual(["org/a", "org/dead"]);
  });
});

describe("front door over a lazy model", () => {
  it("does not forward a request whose client left while the model was loading", async () => {
    const upstream = await fakeServer("org/lazy");
    let finishLoad: () => void = () => {};
    const pool = createModelPool(
      [
        {
          model: "org/lazy",
          upstreamModel: "/models/lazy",
          label: "the server for org/lazy",
          kind: "chat",
          rules: null,
          lazy: true,
          needBytes: 0,
        },
      ],
      {
        now: Date.now,
        spawn: async () => ({ child: exitsWhenKilled(), port: upstream.port }),
        waitReady: () =>
          new Promise<void>((resolve) => {
            finishLoad = resolve;
          }),
        availableMemory: async () => ({ available: 1e12, total: 1e12 }),
        allowOvercommit: false,
        log: () => {},
      },
    );
    const lazyDoor = await startFrontDoor(0, pool);
    try {
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${lazyDoor.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "org/lazy", messages: [] }),
        signal: controller.signal,
      }).catch(() => null);
      await expect.poll(() => pool.status()[0].state).toBe("loading");
      controller.abort();
      await pending;
      // The door hears the socket close a moment after the client does.
      await new Promise((resolve) => setTimeout(resolve, 20));
      finishLoad();
      await expect.poll(() => pool.status()[0].state).toBe("ready");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(upstream.hits).toHaveLength(0);
      expect(pool.status()[0].requestsInProgress).toBe(0);
    } finally {
      await lazyDoor.close();
      upstream.server.close();
    }
  });
});
