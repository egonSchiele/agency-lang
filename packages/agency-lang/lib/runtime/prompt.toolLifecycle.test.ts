import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmolConfig } from "smoltalk";
import { z } from "zod";
import { AgencyFunction, type AgencyFunctionBody } from "./agencyFunction.js";
import { AbortedResult } from "./abortedResult.js";
import { runInTestContext } from "./asyncContext.js";
import { DeterministicClient } from "./deterministicClient.js";
import { AgencyCancelledError, makeAbortCause } from "./errors.js";
import type { CallbackMap } from "./hooks.js";
import { reject } from "./interruptResponse.js";
import { runPrompt } from "./prompt.js";
import { failure, success } from "./result.js";
import { RuntimeContext } from "./state/context.js";
import { MessageThread } from "./state/messageThread.js";
import { State } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";

function setup(fn: AgencyFunctionBody, handoff = false, requiredArgument = false) {
  const ctx = new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
  });
  ctx.setLLMClient(new DeterministicClient([{ toolCall: { name: "work" } }, { return: "done" }]));
  vi.spyOn(ctx.statelogClient, "promptCompletion").mockResolvedValue();
  const ends: CallbackMap["onToolCallEnd"][] = [];
  const order: string[] = [];
  ctx.callbacks = {
    onToolCallStart: () => {
      order.push("start");
    },
    onToolCallEnd: (event) => {
      order.push("end");
      ends.push(event);
    },
  };
  const tool = new AgencyFunction({
    name: "work",
    module: "test.agency",
    fn: (run, ...args) => {
      order.push("body");
      return fn(run, ...args);
    },
    markers: { handoff },
    params: requiredArgument
      ? [{ name: "value", hasDefault: false, defaultValue: undefined, variadic: false }]
      : [],
    toolDefinition: {
      name: "work",
      description: "Run the lifecycle fixture.",
      schema: requiredArgument ? z.object({ value: z.string() }) : z.object({}),
    },
  });
  const messages = new MessageThread();
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  const execute = () =>
    runInTestContext(ctx, ctx.stateStack, threads, (run) =>
      runPrompt(run, {
        prompt: "call work",
        messages,
        // runPrompt takes AgencyFunction objects and converts their schemas;
        // its SmolConfig intersection still declares the provider's tool type.
        clientConfig: { tools: [tool] as unknown as SmolConfig["tools"] },
      }),
    );
  return { execute, ends, order, messages };
}

afterEach(() => vi.restoreAllMocks());

describe("tool completion callbacks", () => {
  it.each([
    ["plain success", false],
    ["wrapped success", success({ answer: 42 })],
    ["failure", failure("unavailable", { retryAfter: 1 })],
    ["rejection", reject("permission denied")],
  ])("reports %s once with the original result", async (_name, result) => {
    const s = setup(() => result);
    expect(await s.execute()).toBe("done");
    expect(s.order).toEqual(["start", "body", "end"]);
    expect(s.ends).toHaveLength(1);
    expect(s.ends[0].result).toBe(result);
    expect(s.ends[0].timeTaken).toBeGreaterThanOrEqual(0);
  });

  it("reports a thrown error as the runtime failure sent to the model", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup(() => {
      throw new Error("connection closed");
    });
    expect(await s.execute()).toBe("done");
    expect(s.order).toEqual(["start", "body", "end"]);
    expect(s.ends).toHaveLength(1);
    expect(s.ends[0].result).toMatchObject({
      success: false,
      error: "connection closed",
      neverStarted: false,
    });
    const reply = s.messages.getMessages().find((message) => message.role === "tool");
    expect(reply?.content).toContain("connection closed");
  });

  it("reports argument binding failure without entering the body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup(() => "unreachable", false, true);
    expect(await s.execute()).toBe("done");
    expect(s.order).toEqual(["start", "end"]);
    expect(s.ends).toHaveLength(1);
    expect(s.ends[0].result).toMatchObject({ success: false, neverStarted: true });
    expect(s.ends[0].result.error).toContain("value");
  });

  it.each([
    ["successful", "handed back"],
    ["failed", failure("research unavailable")],
  ])("reports a %s handoff once", async (_name, result) => {
    const s = setup(() => result, true);
    expect(await s.execute()).toBe("done");
    expect(s.order).toEqual(["start", "body", "end"]);
    expect(s.ends).toHaveLength(1);
    expect(s.ends[0].result).toBe(result);
    expect(s.messages.getMessages().some((message) => message.role === "tool")).toBe(false);
  });

  it("does not report cancellation as a completed tool", async () => {
    const s = setup(() => {
      throw new AgencyCancelledError("cancelled fixture");
    });
    await expect(s.execute()).rejects.toBeInstanceOf(AgencyCancelledError);
    expect(s.order).toEqual(["start", "body"]);
    expect(s.ends).toEqual([]);
  });

  it.each([false, true])(
    "does not report a guard-aborted tool as complete (handoff: %s)",
    async (handoff) => {
      const cause = makeAbortCause({
        kind: "guardTrip",
        dimension: "time",
        limit: 1,
        spent: 2,
        guardId: "outer",
      });
      const s = setup(
        (run) =>
          AbortedResult.fromError(
            run.log,
            new AgencyCancelledError("guard stopped work", cause),
            new State(),
            "work",
          ),
        handoff,
      );
      expect(await s.execute()).toBe("done");
      expect(s.order).toEqual(["start", "body"]);
      expect(s.ends).toEqual([]);
    },
  );
});
