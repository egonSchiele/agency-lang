import { describe, it, expect, afterEach } from "vitest";
import { createHttpHandler } from "./adapter.js";
import { createLogger } from "../../logger.js";
import { RuntimeContext } from "../../runtime/state/context.js";
import { runExportedFunctionForServe } from "../../runtime/node.js";
import { getRuntimeContext } from "../../runtime/asyncContext.js";
import { returnedOutcome, unusedPublicInvoke } from "../testOutcome.js";
import type { GraphState } from "../../runtime/types.js";
import type { AgencyFunction } from "../../runtime/agencyFunction.js";
import type { ServedExportedFunction } from "../types.js";
import type { InvocationOptions } from "../../runtime/invocationOptions.js";

// End-to-end per-invocation telemetry isolation through the REAL adapter, the
// real runExportedFunctionForServe core, and the real StatelogClient. Each
// served call emits one statelog event from inside its body; a mocked global
// fetch records the Authorization header and trace_id of every /api/logs POST.
// No live model is needed.

type Post = { authorization: string | null; traceId: string };

describe("per-invocation telemetry isolation", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function installFetchMock(posts: Post[]): void {
    globalThis.fetch = (async (
      url: unknown,
      init: { headers?: Record<string, string>; body?: string } = {},
    ) => {
      const target = String(url);
      if (!target.endsWith("/api/logs")) {
        throw new Error(`unexpected fetch to ${target}`);
      }
      const headers = init.headers ?? {};
      const parsed = JSON.parse(init.body ?? "{}") as { trace_id: string };
      posts.push({
        authorization: headers.Authorization ?? headers.authorization ?? null,
        traceId: parsed.trace_id,
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  }

  // A frozen parent whose baked telemetry is deliberately different from any
  // per-call override, so "which credential was used" is unambiguous.
  function makeCtx() {
    return new RuntimeContext<GraphState>({
      statelogConfig: {
        host: "https://ingest.example",
        apiKey: "frozen-key",
        projectId: "frozen-proj",
        debugMode: false,
        observability: false,
      },
      smoltalkDefaults: {},
      dirname: process.cwd(),
    });
  }

  // A served function whose body emits one statelog event (so a remote POST
  // carries this call's effective credential + trace id), optionally awaiting a
  // barrier first to force overlap.
  function servedFunction(
    ctx: RuntimeContext<GraphState>,
    beforeEmit?: () => Promise<void>,
  ): ServedExportedFunction {
    const fn = {
      invoke: async () => {
        if (beforeEmit) await beforeEmit();
        await getRuntimeContext().ctx.statelogClient.debug("marker", {});
        return "ok";
      },
    } as unknown as AgencyFunction;
    return {
      kind: "function",
      ...unusedPublicInvoke,
      name: "run",
      description: "run",
      parameters: [],
      agencyFunction: fn,
      interruptEffects: [],
      invokeServed: (namedArgs, invocation) =>
        runExportedFunctionForServe({ ctx, fn, namedArgs, invocation }),
    };
  }

  function handlerFor(ctx: RuntimeContext<GraphState>, beforeEmit?: () => Promise<void>) {
    return createHttpHandler({
      exports: [servedFunction(ctx, beforeEmit)],
      logger: createLogger("error"),
      hasInterrupts: () => false,
      respondToInterrupts: async () => returnedOutcome({ data: undefined }),
    });
  }

  const override = (apiKey: string): InvocationOptions["config"] => ({
    observability: true,
    log: { host: "https://ingest.example", apiKey, projectId: "call-proj" },
  });

  it("injects the supplied trace id into the run and echoes it on the result", async () => {
    const posts: Post[] = [];
    installFetchMock(posts);
    const handler = handlerFor(makeCtx());

    const res = await handler(
      "POST",
      "/function/run",
      {},
      {
        traceId: "injected-trace",
        config: override("call-key"),
      },
    );

    expect(res.traceId).toBe("injected-trace");
    expect(posts.every((p) => p.traceId === "injected-trace")).toBe(true);
    expect(posts.length).toBeGreaterThan(0);
  });

  it("uses the per-call credential, not the frozen one", async () => {
    const posts: Post[] = [];
    installFetchMock(posts);
    const handler = handlerFor(makeCtx());

    await handler("POST", "/function/run", {}, { traceId: "t", config: override("call-key") });

    expect(posts.every((p) => p.authorization === "Bearer call-key")).toBe(true);
    expect(posts.some((p) => p.authorization === "Bearer frozen-key")).toBe(false);
  });

  it("does not cross-attribute credentials or trace ids across concurrent calls", async () => {
    const posts: Post[] = [];
    installFetchMock(posts);

    // Barrier: neither body emits until BOTH have arrived, forcing real overlap.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    };

    const handlerA = handlerFor(makeCtx(), barrier);
    const handlerB = handlerFor(makeCtx(), barrier);

    const [ra, rb] = await Promise.all([
      handlerA("POST", "/function/run", {}, { traceId: "trace-A", config: override("key-A") }),
      handlerB("POST", "/function/run", {}, { traceId: "trace-B", config: override("key-B") }),
    ]);

    expect(ra.traceId).toBe("trace-A");
    expect(rb.traceId).toBe("trace-B");

    expect(posts.some((p) => p.traceId === "trace-A")).toBe(true);
    expect(posts.some((p) => p.traceId === "trace-B")).toBe(true);
    for (const post of posts) {
      const expected = post.traceId === "trace-A" ? "Bearer key-A" : "Bearer key-B";
      expect(post.authorization).toBe(expected);
    }
  });
});
