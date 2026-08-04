import { describe, expect, it, vi } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import { createHttpHandler, startHttpServer } from "./adapter.js";
import { AgencyFunction } from "../../runtime/agencyFunction.js";
import { interrupt } from "../../runtime/interrupts.js";
import type { Interrupt } from "../../runtime/interrupts.js";
import type { ExportedItem } from "../types.js";
import { returnedOutcome, threwOutcome } from "../testOutcome.js";
import { createLogger } from "../../logger.js";
import type { Logger } from "../../logger.js";
import { GuardExceededError } from "../../runtime/guard.js";

// A fully-formed interrupt, as the runtime produces one — every identity field
// present. Resume validation now requires these, so tests build real interrupts
// instead of `{ id: "1" }` shaped partials.
function makeInterrupt(interruptId: string): Interrupt {
  return interrupt({
    effect: "delete",
    message: "delete emails?",
    data: null,
    origin: "test",
    runId: "run-1",
    interruptId,
  });
}

// A handler whose respondToInterrupts is a spy, so a malformed /resume can be
// proven to never reach the runtime.
function makeSpyHandler(): {
  handler: ReturnType<typeof createHttpHandler>;
  respondSpy: ReturnType<typeof vi.fn>;
} {
  const { exports } = makeExports();
  const respondSpy = vi.fn(async () => returnedOutcome({ data: "resumed" }));
  const handler = createHttpHandler({
    exports,
    logger: createLogger("error"),
    hasInterrupts: () => false,
    respondToInterrupts: respondSpy,
  });
  return { handler, respondSpy };
}

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
    },
    registry,
  );

  const exports: ExportedItem[] = [
    {
      kind: "function",
      name: "add",
      description: "Add two numbers",
      parameters: [{ name: "a" }, { name: "b" }],
      agencyFunction: addFn,
      interruptEffects: [],
      invoke: async (namedArgs) => returnedOutcome(await addFn.invoke({ type: "named", positionalArgs: [], namedArgs })),
    },
    {
      kind: "node",
      name: "main",
      parameters: [{ name: "message" }],
      // Serve node invoke: named args as a data object; value is the
      // caller-facing data (discovery would have unwrapped RunNodeResult.data).
      invoke: async (data) => returnedOutcome({ echo: (data as { message?: unknown }).message }),
      interruptEffects: [],
    },
  ];

  return { exports };
}

function makeHandler() {
  const { exports } = makeExports();
  return createHttpHandler({
    exports,
    logger: createLogger("error"),
    hasInterrupts: () => false,
    respondToInterrupts: async () => returnedOutcome({ data: "resumed" }),
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
    expect(body.functions[0].parameters).toEqual(["a", "b"]);
    expect(body.functions[0].interruptEffects).toEqual([]);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].name).toBe("main");
    expect(body.nodes[0].interruptEffects).toEqual([]);
  });

  it("POST /function/<inherited-prototype-name> is a 404, not a tool failure", async () => {
    // "toString" is not an exported function; a plain-object lookup table would
    // resolve it to Object.prototype.toString and bypass the 404. See the
    // null-prototype maps in createHttpHandler.
    const result = await handler("POST", "/function/toString", {});
    expect(result.status).toBe(404);
  });

  it("GET /list reports destructive/idempotent markers as booleans", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const mk = (name: string, markers?: { destructive?: boolean; idempotent?: boolean }) =>
      AgencyFunction.create(
        {
          name,
          module: "test",
          fn: async () => 1,
          params: [],
          toolDefinition: { name, description: name, schema: null },
          exported: true,
          ...(markers ? { markers } : {}),
        },
        registry,
      );
    const exports: ExportedItem[] = (
      [
        ["rm", { destructive: true }],
        ["lookup", { idempotent: true }],
        ["plainFn", undefined],
      ] as const
    ).map(([name, markers]) => ({
      kind: "function",
      name,
      description: name,
      parameters: [],
      agencyFunction: mk(name, markers),
      interruptEffects: [],
      invoke: async (namedArgs: Record<string, unknown>) =>
        returnedOutcome(await mk(name, markers).invoke({ type: "named", positionalArgs: [], namedArgs })),
    }));
    const h = createHttpHandler({
      exports,
      logger: createLogger("error"),
      hasInterrupts: () => false,
      respondToInterrupts: async () => returnedOutcome({ data: "resumed" }),
    });
    const body = (await h("GET", "/list", undefined)).body as any;
    const byName = (n: string) => body.functions.find((f: any) => f.name === n);
    expect(byName("rm")).toMatchObject({ destructive: true, idempotent: false });
    expect(byName("lookup")).toMatchObject({ destructive: false, idempotent: true });
    expect(byName("plainFn")).toMatchObject({ destructive: false, idempotent: false });
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
      interrupts: [makeInterrupt("id-1")],
      responses: [{ type: "approve" }],
    });
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.success).toBe(true);
    expect(body.value).toBe("resumed");
  });

  it("POST /resume rejects non-array inputs", async () => {
    const result = await handler("POST", "/resume", {
      interrupts: "not-array",
      responses: "not-array",
    });
    expect(result.status).toBe(400);
  });

  it("POST /resume rejects an unknown response type without running", async () => {
    // The core safety case: an unrecognized response type would otherwise fall
    // through the generated resume branch and continue PAST the interrupt.
    const { handler: spyHandler, respondSpy } = makeSpyHandler();
    const result = await spyHandler("POST", "/resume", {
      interrupts: [makeInterrupt("id-1")],
      responses: [{ type: "propagate" }],
    });
    expect(result.status).toBe(400);
    expect(respondSpy).not.toHaveBeenCalled();
  });

  it("POST /resume rejects length mismatch, empty, and duplicate-id batches", async () => {
    const { handler: spyHandler, respondSpy } = makeSpyHandler();
    const first = makeInterrupt("id-1");
    const second = makeInterrupt("id-2");
    const approveResponse = { type: "approve" };
    const rejectResponse = { type: "reject" };

    const mismatched = await spyHandler("POST", "/resume", {
      interrupts: [first, second],
      responses: [approveResponse],
    });
    expect(mismatched.status).toBe(400);

    const empty = await spyHandler("POST", "/resume", { interrupts: [], responses: [] });
    expect(empty.status).toBe(400);

    // buildResponseMap is keyed by interruptId, so duplicate ids would overwrite
    // one response and leave an interrupt unanswered.
    const duplicate = await spyHandler("POST", "/resume", {
      interrupts: [first, { ...second, interruptId: first.interruptId }],
      responses: [approveResponse, rejectResponse],
    });
    expect(duplicate.status).toBe(400);

    expect(respondSpy).not.toHaveBeenCalled();
  });

  it("POST /resume rejects malformed interrupt and response items via a table", async () => {
    const { handler: spyHandler, respondSpy } = makeSpyHandler();
    const valid = makeInterrupt("id-1");
    const approveResponse = { type: "approve" };

    const badInterrupts: unknown[] = [
      null,
      42,
      ["array"],
      { ...valid, type: "notInterrupt" },
      { ...valid, interruptId: "" },
    ];
    for (const badInterrupt of badInterrupts) {
      const result = await spyHandler("POST", "/resume", {
        interrupts: [badInterrupt],
        responses: [approveResponse],
      });
      expect(result.status).toBe(400);
    }

    const badResponses: unknown[] = [null, 42, ["array"], {}, { type: "propagate" }];
    for (const badResponse of badResponses) {
      const result = await spyHandler("POST", "/resume", {
        interrupts: [valid],
        responses: [badResponse],
      });
      expect(result.status).toBe(400);
    }

    expect(respondSpy).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown routes", async () => {
    const result = await handler("GET", "/unknown", undefined);
    expect(result.status).toBe(404);
  });

  it("GET /list includes interruptEffects as string arrays", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const deployFn = AgencyFunction.create(
      {
        name: "deploy",
        module: "test",
        fn: async () => {},
        params: [],
        toolDefinition: { name: "deploy", description: "Deploy", schema: null },
        exported: true,
      },
      registry,
    );
    const h = createHttpHandler({
      exports: [
        {
          kind: "function",
          name: "deploy",
          description: "Deploy",
          parameters: [],
          agencyFunction: deployFn,
          interruptEffects: [{ effect: "myapp::deploy" }],
          invoke: async (namedArgs) => returnedOutcome(await deployFn.invoke({ type: "named", positionalArgs: [], namedArgs })),
        },
      ],
      logger: createLogger("error"),
      hasInterrupts: () => false,
      respondToInterrupts: async () => returnedOutcome({ data: "ok" }),
    });
    const result = await h("GET", "/list", undefined);
    const body = result.body as any;
    expect(body.functions[0].interruptEffects).toEqual(["myapp::deploy"]);
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
      respondToInterrupts: async () => returnedOutcome({ data: "resumed" }),
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
        respondToInterrupts: async () => returnedOutcome({ data: "x" }),
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
      },
      registry,
    );
    const exportsWithFail: ExportedItem[] = [
      ...exports,
      {
        kind: "function",
        name: "fail",
        description: "",
        parameters: [],
        agencyFunction: failFn,
        interruptEffects: [],
        invoke: async (namedArgs) => returnedOutcome(await failFn.invoke({ type: "named", positionalArgs: [], namedArgs })),
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

describe("startHttpServer route logging", () => {
  function capturingLogger(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const sink = (msg: string) => {
      lines.push(msg);
    };
    return {
      lines,
      logger: { debug: sink, info: sink, warn: sink, error: sink },
    };
  }

  it("logs each exposed route with its params on startup", async () => {
    const { exports } = makeExports();
    const { logger, lines } = capturingLogger();
    await withServer(
      {
        exports,
        port: 0,
        logger,
        hasInterrupts: () => false,
        respondToInterrupts: async () => returnedOutcome({ data: "resumed" }),
      },
      async () => {
        // server is listening; the listen callback has already logged routes
      },
    );

    expect(lines).toContain("Routes:");
    const joined = lines.join("\n");
    expect(joined).toContain("GET   /list");
    // `add` has two required params a, b
    expect(joined).toContain("POST  /function/add (a, b)");
    // node `main` takes a single param
    expect(joined).toContain("POST  /node/main (message)");
    expect(joined).toContain("POST  /resume (interrupts, responses)");
  });
});

describe("root-budget trips surface as a typed budgetExceeded", () => {
  const silent = createLogger("error");

  function handlerFor(invoke: () => Promise<unknown>): ReturnType<typeof createHttpHandler> {
    const node: ExportedItem = {
      kind: "node",
      name: "run",
      parameters: [],
      interruptEffects: [],
      // The core turns a thrown guard trip / error into a threw-outcome; model
      // that here so the adapter maps it (402 / generic) with a usage snapshot.
      invoke: async () => {
        try {
          return returnedOutcome(await invoke());
        } catch (err) {
          return threwOutcome(err);
        }
      },
    };
    return createHttpHandler({
      exports: [node],
      logger: silent,
      hasInterrupts: () => false,
      respondToInterrupts: async () => returnedOutcome({ data: undefined }),
    });
  }

  it("returns a 402 budgetExceeded with dimension/limit/spent", async () => {
    const handler = handlerFor(async () => {
      throw new GuardExceededError("cost", 1, 2, "g1");
    });
    const result = await handler("POST", "/node/run", {});
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({
      success: false,
      code: "budgetExceeded",
      dimension: "cost",
      limit: 1,
      spent: 2,
    });
    expect((result.body as { error: string }).error).toContain("cost limit");
  });

  it("leaves a non-budget error as the generic tool error", async () => {
    const handler = handlerFor(async () => {
      throw new Error("kaboom");
    });
    const result = await handler("POST", "/node/run", {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: false, error: "Tool execution failed" });
  });
});
