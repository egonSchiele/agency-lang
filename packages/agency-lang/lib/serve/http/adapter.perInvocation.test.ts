import { describe, it, expect, vi } from "vitest";
import { createHttpHandler } from "./adapter.js";
import { createLogger } from "../../logger.js";
import { returnedOutcome, unusedPublicInvoke } from "../testOutcome.js";
import { interrupt } from "../../runtime/interrupts.js";
import { approve } from "../../runtime/interruptResponse.js";
import type { ServedExportedItem } from "../types.js";
import type { InvocationOptions } from "../../runtime/invocationOptions.js";

// A fully-formed interrupt + matching response, so /resume passes validation and
// actually reaches the resume callback.
function validResumeBody() {
  const intr = interrupt({
    effect: "delete",
    message: "ok?",
    data: null,
    origin: "test",
    runId: "run-1",
    interruptId: "1",
  });
  return { interrupts: [intr], responses: [approve()] };
}

// The serve adapter is a transparent transport: it forwards the InvocationOptions
// it receives, unchanged, to the served invoker / resume callback, and echoes the
// outcome's trace id onto the RouteResult (post-execution only). No config
// interpretation happens in any serve file.

function makeHandler() {
  const nodeSpy = vi.fn(async () =>
    returnedOutcome({ ok: true }, { traceId: "trace-from-outcome" }),
  );
  const fnSpy = vi.fn(async () => returnedOutcome("v", { traceId: "trace-from-outcome" }));
  const resumeSpy = vi.fn(async () =>
    returnedOutcome({ data: "resumed" }, { traceId: "trace-from-outcome" }),
  );

  const exports: ServedExportedItem[] = [
    {
      kind: "function",
      ...unusedPublicInvoke,
      name: "add",
      description: "add",
      parameters: [],
      agencyFunction: {} as never,
      interruptEffects: [],
      invokeServed: fnSpy,
    },
    {
      kind: "node",
      ...unusedPublicInvoke,
      name: "main",
      parameters: [],
      invokeServed: nodeSpy,
      interruptEffects: [],
    },
  ];

  const handler = createHttpHandler({
    exports,
    logger: createLogger("error"),
    hasInterrupts: () => false,
    respondToInterrupts: resumeSpy,
  });
  return { handler, nodeSpy, fnSpy, resumeSpy };
}

describe("serve adapter forwards InvocationOptions unchanged", () => {
  it("passes the exact options object by identity to a node invoker", async () => {
    const { handler, nodeSpy } = makeHandler();
    const invocation: InvocationOptions = { traceId: "abc", config: { observability: true } };
    await handler("POST", "/node/main", {}, invocation);
    expect((nodeSpy.mock.calls[0] as unknown[])[1]).toBe(invocation);
  });

  it("passes the exact options object by identity to a function invoker", async () => {
    const { handler, fnSpy } = makeHandler();
    const invocation: InvocationOptions = { traceId: "abc" };
    await handler("POST", "/function/add", {}, invocation);
    expect((fnSpy.mock.calls[0] as unknown[])[1]).toBe(invocation);
  });

  it("passes the exact options object by identity to the resume callback", async () => {
    const { handler, resumeSpy } = makeHandler();
    const invocation: InvocationOptions = { config: { budget: { maxCost: 1 } } };
    await handler("POST", "/resume", validResumeBody(), invocation);
    expect((resumeSpy.mock.calls[0] as unknown[])[2]).toBe(invocation);
  });
});

describe("RouteResult.traceId presence", () => {
  it("echoes the outcome trace id on a post-execution node result", async () => {
    const { handler } = makeHandler();
    const res = await handler("POST", "/node/main", {});
    expect(res.traceId).toBe("trace-from-outcome");
  });

  it("omits traceId on /list", async () => {
    const { handler } = makeHandler();
    const res = await handler("GET", "/list", undefined);
    expect(res.traceId).toBeUndefined();
  });

  it("omits traceId on an unknown route (404)", async () => {
    const { handler } = makeHandler();
    const res = await handler("POST", "/node/nope", {});
    expect(res.status).toBe(404);
    expect(res.traceId).toBeUndefined();
  });

  it("omits traceId on an invalid resume body (validation 400)", async () => {
    const { handler } = makeHandler();
    const res = await handler("POST", "/resume", "not an object");
    expect(res.status).toBe(400);
    expect(res.traceId).toBeUndefined();
  });
});
